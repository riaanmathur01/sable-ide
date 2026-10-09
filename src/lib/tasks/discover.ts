/**
 * The project's runnable tasks — package.json scripts, Makefile targets,
 * just recipes, and the usual Cargo/Go/Maven/Gradle/Deno/Composer
 * commands — from its build files. Pure (the caller reads the files), so
 * it's unit-tested.
 */

export interface Task {
  id: string;
  /** What's shown: "build", "test", … */
  label: string;
  /** Where it comes from ("npm", "make", "cargo", …). */
  source: string;
  /** The shell command that runs it. */
  command: string;
  /** What it does (an npm script's body, a make target's recipe), if known. */
  detail?: string;
}

/** The build files to read, relative to the project folder. */
export const TASK_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Makefile",
  "makefile",
  "GNUmakefile",
  "justfile",
  "Justfile",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradlew",
  "mvnw",
  "deno.json",
  "deno.jsonc",
  "composer.json",
  "pyproject.toml",
] as const;

type Files = Partial<Record<(typeof TASK_FILES)[number], string | null>>;

const quote = (word: string) => (/^[\w.:/@+-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

function npmTasks(files: Files): Task[] {
  if (!files["package.json"]) return [];
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(files["package.json"]) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [];
  }
  const runner =
    files["pnpm-lock.yaml"] != null
      ? "pnpm"
      : files["yarn.lock"] != null
        ? "yarn"
        : files["bun.lockb"] != null || files["bun.lock"] != null
          ? "bun"
          : "npm";
  return Object.entries(scripts)
    // pre/post hooks run with their script.
    .filter(([name]) => !/^(pre|post)/.test(name) || !(name.replace(/^(pre|post)/, "") in scripts))
    .map(([name, body]) => ({
      id: `${runner}:${name}`,
      label: name,
      source: runner,
      command: `${runner} run ${quote(name)}`,
      detail: body,
    }));
}

function makeTasks(text: string | null | undefined): Task[] {
  if (!text) return [];
  const tasks: Task[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    // "target: deps" — not variables (":=", "::="), patterns (%), or
    // special targets (.PHONY).
    const match = /^([A-Za-z0-9][\w./-]*)\s*:(?!=)(?!:=)/.exec(line);
    if (!match || seen.has(match[1]) || line.includes("%")) return;
    seen.add(match[1]);
    const recipe = lines[index + 1]?.startsWith("\t") ? lines[index + 1].trim() : undefined;
    tasks.push({ id: `make:${match[1]}`, label: match[1], source: "make", command: `make ${quote(match[1])}`, detail: recipe });
  });
  return tasks;
}

function justTasks(text: string | null | undefined): Task[] {
  if (!text) return [];
  const tasks: Task[] = [];
  for (const line of text.split("\n")) {
    // "recipe arg1 arg2:" at column 0 (not settings / variables).
    const match = /^@?([A-Za-z_][\w-]*)((?:\s+[^:=\s]+)*)\s*:(?!=)/.exec(line);
    if (!match || /^(set|alias|export|import|mod)\b/.test(line)) continue;
    const needsArgs = match[2].trim().split(/\s+/).some((arg) => arg && !arg.includes("="));
    tasks.push({
      id: `just:${match[1]}`,
      label: match[1],
      source: "just",
      command: `just ${match[1]}`,
      detail: needsArgs ? `takes arguments:${match[2]}` : undefined,
    });
  }
  return tasks;
}

function fixed(source: string, commands: [string, string][]): Task[] {
  return commands.map(([label, command]) => ({ id: `${source}:${label}`, label, source, command }));
}

function denoTasks(text: string | null | undefined): Task[] {
  if (!text) return [];
  try {
    // deno.jsonc may have comments.
    const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as { tasks?: Record<string, string> };
    return Object.entries(json.tasks ?? {}).map(([name, body]) => ({
      id: `deno:${name}`,
      label: name,
      source: "deno",
      command: `deno task ${quote(name)}`,
      detail: body,
    }));
  } catch {
    return [];
  }
}

function composerTasks(text: string | null | undefined): Task[] {
  if (!text) return [];
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return Object.keys(scripts).map((name) => ({
      id: `composer:${name}`,
      label: name,
      source: "composer",
      command: `composer run-script ${quote(name)}`,
    }));
  } catch {
    return [];
  }
}

/** pyproject.toml: the project's console scripts, run in its environment. */
function pythonTasks(text: string | null | undefined): Task[] {
  if (!text) return [];
  const section = /^\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text);
  if (!section) return [];
  const runner = /^\[tool\.poetry/m.test(text) ? "poetry run" : /^\[tool\.uv/m.test(text) ? "uv run" : "";
  return [...section[1].matchAll(/^\s*([\w.-]+)\s*=\s*"([^"]+)"/gm)].map((match) => ({
    id: `python:${match[1]}`,
    label: match[1],
    source: "python",
    command: runner ? `${runner} ${match[1]}` : match[1],
    detail: match[2],
  }));
}

export function discoverTasks(files: Files): Task[] {
  const gradle = files["build.gradle"] != null || files["build.gradle.kts"] != null;
  const gradleCommand = files["gradlew"] != null ? "./gradlew" : "gradle";
  const mavenCommand = files["mvnw"] != null ? "./mvnw" : "mvn";
  return [
    ...npmTasks(files),
    ...makeTasks(files["Makefile"] ?? files["makefile"] ?? files["GNUmakefile"]),
    ...justTasks(files["justfile"] ?? files["Justfile"]),
    ...(files["Cargo.toml"] != null
      ? fixed("cargo", [
          ["build", "cargo build"],
          ["run", "cargo run"],
          ["test", "cargo test"],
          ["check", "cargo check"],
          ["clippy", "cargo clippy"],
          ["fmt", "cargo fmt"],
        ])
      : []),
    ...(files["go.mod"] != null
      ? fixed("go", [
          ["build", "go build ./..."],
          ["test", "go test ./..."],
          ["vet", "go vet ./..."],
          ["mod tidy", "go mod tidy"],
        ])
      : []),
    ...(files["pom.xml"] != null
      ? fixed("maven", [
          ["compile", `${mavenCommand} compile`],
          ["test", `${mavenCommand} test`],
          ["package", `${mavenCommand} package`],
          ["clean", `${mavenCommand} clean`],
        ])
      : []),
    ...(gradle
      ? fixed("gradle", [
          ["build", `${gradleCommand} build`],
          ["test", `${gradleCommand} test`],
          ["run", `${gradleCommand} run`],
          ["clean", `${gradleCommand} clean`],
        ])
      : []),
    ...denoTasks(files["deno.json"] ?? files["deno.jsonc"]),
    ...composerTasks(files["composer.json"]),
    ...pythonTasks(files["pyproject.toml"]),
  ];
}

import { invoke } from "@tauri-apps/api/core";
import { join, tempDir } from "@tauri-apps/api/path";
import { deletePath, readDirectory, readFile, writeFile } from "../ipc";
import { shellQuote } from "../runConfig";
import { useInterpreterStore } from "../../store/interpreterStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import type { Framework, TestItem } from "./discover";
import { parseCargoTest, parseGoTestJson, parseJestJson, parseJUnitXml, type TestResult } from "./results";

/**
 * Running tests: which framework a file uses, the command that runs some
 * of its tests (or all of them, or the whole project's), and its results.
 * Commands run in the user's login shell (so npx, go, cargo, mvn are on
 * PATH) and write machine-readable reports Sable parses.
 */

export interface TestContext {
  framework: Framework;
  /** Where the runner runs: the package/module/crate/build root. */
  projectDir: string;
  /** JUnit: which build tool runs it. */
  buildTool?: "maven" | "gradle";
}

const separator = (path: string) => (path.includes("\\") ? "\\" : "/");
const parentOf = (path: string) => path.slice(0, path.lastIndexOf(separator(path))) || separator(path);

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** The nearest directory above `file` (up to the project folder) holding
 *  one of `names`, and which one. */
async function findUp(file: string, names: string[]): Promise<{ dir: string; name: string } | null> {
  const root = useWorkspaceStore.getState().rootPath;
  let dir = parentOf(file);
  for (let depth = 0; depth < 30; depth++) {
    for (const name of names) {
      if (await exists(`${dir}${separator(dir)}${name}`)) return { dir, name };
    }
    if (dir === root || parentOf(dir) === dir) return null;
    dir = parentOf(dir);
  }
  return null;
}

/** Contexts are looked up once per file. */
const contexts = new Map<string, Promise<TestContext | null>>();

export function clearTestContexts() {
  contexts.clear();
}

/** How `file`'s tests run, or null if Sable doesn't know a runner for it. */
export function testContext(file: string): Promise<TestContext | null> {
  if (!contexts.has(file)) contexts.set(file, detect(file));
  return contexts.get(file)!;
}

async function detect(file: string): Promise<TestContext | null> {
  const extension = file.split(".").pop()?.toLowerCase() ?? "";
  const root = useWorkspaceStore.getState().rootPath ?? parentOf(file);
  if (extension === "py") return { framework: "pytest", projectDir: root };
  if (/^[cm]?[jt]sx?$/.test(extension)) {
    const found = await findUp(file, ["package.json"]);
    if (!found) return null;
    const manifest = await readFile(`${found.dir}${separator(found.dir)}package.json`).catch(() => "{}");
    const { dependencies = {}, devDependencies = {} } = JSON.parse(manifest) as Record<string, Record<string, string>>;
    const all = { ...dependencies, ...devDependencies };
    if ("vitest" in all) return { framework: "vitest", projectDir: found.dir };
    if ("jest" in all) return { framework: "jest", projectDir: found.dir };
    return null;
  }
  if (extension === "go") {
    return (await findUp(file, ["go.mod"])) ? { framework: "go", projectDir: parentOf(file) } : null;
  }
  if (extension === "rs") {
    const found = await findUp(file, ["Cargo.toml"]);
    return found ? { framework: "cargo", projectDir: found.dir } : null;
  }
  if (extension === "java") {
    const found = await findUp(file, ["pom.xml", "build.gradle", "build.gradle.kts"]);
    if (!found) return null;
    return { framework: "junit", projectDir: found.dir, buildTool: found.name === "pom.xml" ? "maven" : "gradle" };
  }
  return null;
}

interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function run(command: string, cwd: string): Promise<ShellOutput> {
  return invoke<ShellOutput>("run_shell", { command, cwd, timeoutSecs: 1800 });
}

async function reportPath(extension: string): Promise<string> {
  return join(await tempDir(), `sable-tests-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
}

async function readReport(path: string): Promise<string | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  } finally {
    void deletePath(path).catch(() => {});
  }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The name pattern selecting a test or suite: Jest matches names joined
 * with spaces ("math adds"), Vitest with " > " ("math > adds"). A suite
 * selects everything inside it.
 */
function namePattern(framework: Framework, items: TestItem[]): string {
  const join = framework === "vitest" ? " > " : " ";
  const names = items.map((item) => {
    const name = escapeRegex([...item.parents, item.label].join(join));
    return item.kind === "suite" ? `${name}(${escapeRegex(join)}|$)` : `${name}$`;
  });
  return `^(${names.join("|")})`;
}

/** What to run: some tests of a file, the whole file, or the project. */
export type TestScope = { file: string; items: TestItem[] } | { file: string; items: "all" } | { project: true };

export interface TestRun {
  results: TestResult[];
  /** The command's own output, shown when something went wrong. */
  log: string;
  /** Set when the run itself failed (not just a test). */
  error?: string;
}

/** Run tests and parse the results. */
export async function runTests(context: TestContext, scope: TestScope): Promise<TestRun> {
  const file = "file" in scope ? scope.file : null;
  const items = "items" in scope && scope.items !== "all" ? scope.items.filter((item) => item.kind === "test") : null;
  const suites = "items" in scope && scope.items !== "all" ? scope.items.filter((item) => item.kind === "suite") : [];
  const { projectDir } = context;

  switch (context.framework) {
    case "pytest": {
      const python = useInterpreterStore.getState().selectedPath ?? "python3";
      const report = await reportPath("xml");
      const targets = !file
        ? []
        : items || suites.length
          ? [...suites, ...(items ?? [])].map((item) => `${file}::${item.selector}`)
          : [file];
      const output = await run(
        [
          shellQuote(python),
          "-m",
          "pytest",
          ...targets.map(shellQuote),
          "-q",
          "-p",
          "no:cacheprovider",
          // xunit1 records each test's file, so project runs group by file.
          "-o",
          "junit_family=xunit1",
          `--junitxml=${shellQuote(report)}`,
        ].join(" "),
        projectDir,
      );
      const xml = await readReport(report);
      if (!xml) {
        const missing = /No module named pytest/.test(output.stderr);
        return {
          results: [],
          log: output.stdout + output.stderr,
          error: missing ? `pytest isn't installed for ${python} — run: ${python} -m pip install pytest` : "pytest didn't produce a report",
        };
      }
      return {
        results: parseJUnitXml(xml, { classIsModule: true }).map((result) => ({
          ...result,
          // xunit1 files are relative to where pytest ran.
          file: result.file
            ? /^([/\\]|[A-Za-z]:)/.test(result.file)
              ? result.file
              : `${projectDir}${separator(projectDir)}${result.file}`
            : (file ?? undefined),
        })),
        log: output.stdout + output.stderr,
      };
    }

    case "vitest":
    case "jest": {
      const report = await reportPath("json");
      const selected = [...suites, ...(items ?? [])];
      const pattern = selected.length ? namePattern(context.framework, selected) : null;
      const args =
        context.framework === "vitest"
          ? ["npx", "vitest", "run", ...(file ? [file] : []), ...(pattern ? ["-t", pattern] : []), "--reporter=json", `--outputFile=${report}`]
          : ["npx", "jest", ...(file ? [file] : []), ...(pattern ? ["-t", pattern] : []), "--json", `--outputFile=${report}`];
      const output = await run(args.map(shellQuote).join(" "), projectDir);
      const json = await readReport(report);
      if (!json) return { results: [], log: output.stdout + output.stderr, error: `${context.framework} didn't produce a report` };
      let results = parseJestJson(json);
      // A filtered run reports the other tests as skipped; keep only the
      // ones asked for.
      if (selected.length) {
        results = results.filter((result) =>
          selected.some((item) =>
            item.kind === "suite" ? result.name.startsWith(`${item.selector} `) : result.name === item.selector,
          ),
        );
      }
      return { results, log: output.stdout + output.stderr };
    }

    case "go": {
      const names = items?.map((item) => item.selector);
      const regex = names ? `^(${names.join("|")})$` : null;
      const fileTests = file && !names ? await goTestNames(file) : null;
      const runPattern = regex ?? (fileTests ? `^(${fileTests.join("|")})$` : null);
      const command = ["go", "test", "-json", ...(runPattern ? ["-run", runPattern] : []), file ? "." : "./..."];
      const cwd = file ? projectDir : (useWorkspaceStore.getState().rootPath ?? projectDir);
      const output = await run(command.map(shellQuote).join(" "), cwd);
      const results = parseGoTestJson(output.stdout);
      return {
        results: file ? results.map((result) => ({ ...result, file })) : await locateGoTests(results, cwd),
        log: output.stdout + output.stderr,
      };
    }

    case "cargo": {
      // A single test: filter by name (substring); otherwise the crate.
      const filter = items && items.length === 1 ? [items[0].selector] : [];
      // 2>&1: the "Running <target>" lines (stderr) must stay in order
      // with the results (stdout) — they say which file a test is in.
      // --no-fail-fast: a failing test binary mustn't stop the others.
      const output = await run(`${["cargo", "test", "--no-fail-fast", ...filter].map(shellQuote).join(" ")} 2>&1`, projectDir);
      let results = parseCargoTest(output.stdout);
      if (items) {
        results = results.filter((result) => items.some((item) => cargoMatches(result.name, item.selector)));
      }
      return {
        results: await locateCargoTests(results, projectDir, items ? file : null),
        log: output.stdout + output.stderr,
        error: results.length === 0 && output.exitCode !== 0 ? "cargo test failed — see the log" : undefined,
      };
    }

    case "junit": {
      const selectors = [...suites, ...(items ?? [])].map((item) => item.selector);
      const reportsDir = `${projectDir}${separator(projectDir)}${context.buildTool === "maven" ? "target/surefire-reports" : "build/test-results/test"}`;
      let command: string;
      if (context.buildTool === "maven") {
        const test = selectors.length ? [`-Dtest=${selectors.join(",")}`] : file ? [`-Dtest=${fileClass(file)}`] : [];
        command = ["mvn", "-q", "test", ...test, "-DfailIfNoTests=false", "-Dsurefire.failIfNoSpecifiedTests=false"].map(shellQuote).join(" ");
      } else {
        const wrapper = (await exists(`${projectDir}${separator(projectDir)}gradlew`)) ? "./gradlew" : "gradle";
        const filters = selectors.length ? selectors.map((selector) => selector.replace("#", ".")) : file ? [fileClass(file)] : [];
        command = [wrapper, "test", ...filters.flatMap((filter) => ["--tests", filter])].map(shellQuote).join(" ");
      }
      // Reports from earlier runs would read as this run's (Maven never
      // removes them); they're build output, regenerated every run.
      await deletePath(reportsDir).catch(() => {});
      const output = await run(command, projectDir);
      const entries = await readDirectory(reportsDir).catch(() => []);
      const reports = await Promise.all(
        entries.filter((entry) => entry.name.endsWith(".xml")).map((entry) => readFile(entry.path).catch(() => "")),
      );
      const results = await locateJavaTests(reports.flatMap((xml) => parseJUnitXml(xml)), projectDir, file);
      return {
        results,
        log: output.stdout + output.stderr,
        error: results.length === 0 && output.exitCode !== 0 ? `${context.buildTool} test failed — see the log` : undefined,
      };
    }
  }
}

// --- Which file each result is in ------------------------------------------------

const testFunctionIn = (text: string, name: string) => new RegExp(`\\bfn\\s+${escapeRegex(name)}\\b|\\bfunc\\s+${escapeRegex(name)}\\s*\\(`).test(text);

/** Go: a package's test files, searched for the test function. */
async function locateGoTests(results: TestResult[], cwd: string): Promise<TestResult[]> {
  const packages = new Set(results.map((result) => result.suite).filter((suite): suite is string => !!suite));
  if (!packages.size) return results;
  const listing = await run(`go list -f '{{.ImportPath}}\t{{.Dir}}' ./...`, cwd);
  const dirs = new Map(
    listing.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t") as [string, string]),
  );
  const filesByPackage = new Map<string, { path: string; text: string }[]>();
  for (const pkg of packages) {
    const dir = dirs.get(pkg);
    const entries = dir ? await readDirectory(dir).catch(() => []) : [];
    filesByPackage.set(
      pkg,
      await Promise.all(
        entries
          .filter((entry) => entry.name.endsWith("_test.go"))
          .map(async (entry) => ({ path: entry.path, text: await readFile(entry.path).catch(() => "") })),
      ),
    );
  }
  return results.map((result) => {
    // Subtests ("TestX/case") are in their parent's file.
    const name = result.name.split("/")[0];
    const found = filesByPackage.get(result.suite ?? "")?.find((candidate) => testFunctionIn(candidate.text, name));
    return found ? { ...result, file: found.path } : result;
  });
}

/**
 * Rust: an integration test's file is its target's source; a unit test's
 * is found from its module path ("math::tests::adds" → src/math.rs or
 * src/math/mod.rs, or an inline module in the crate root).
 */
async function locateCargoTests(results: TestResult[], crateDir: string, fallback: string | null): Promise<TestResult[]> {
  const sep = separator(crateDir);
  const texts = new Map<string, Promise<string | null>>();
  const read = (path: string) => {
    if (!texts.has(path)) texts.set(path, readFile(path).catch(() => null));
    return texts.get(path)!;
  };
  return Promise.all(
    results.map(async (result) => {
      // Cargo can't run one file's tests, so a file's run reports the
      // whole crate — each result goes under its own file.
      if (!result.suite) return fallback ? { ...result, file: fallback } : result;
      const target = `${crateDir}${sep}${result.suite.split("/").join(sep)}`;
      const segments = result.name.split("::");
      const name = segments.pop()!;
      const targetDir = parentOf(target);
      // Deepest module file first, then shallower, then the target itself.
      const candidates: string[] = [];
      for (let depth = segments.length; depth > 0; depth--) {
        const modulePath = segments.slice(0, depth).join(sep);
        candidates.push(`${targetDir}${sep}${modulePath}.rs`, `${targetDir}${sep}${modulePath}${sep}mod.rs`);
      }
      candidates.push(target);
      for (const candidate of candidates) {
        const text = await read(candidate);
        if (text !== null && testFunctionIn(text, name)) return { ...result, file: candidate };
      }
      return fallback ? { ...result, file: fallback } : result;
    }),
  );
}

/** Java: a class's file under the standard test source folder. */
async function locateJavaTests(results: TestResult[], projectDir: string, file: string | null): Promise<TestResult[]> {
  const sep = separator(projectDir);
  // A file's run reports only that file's classes (nested ones included).
  const ownClass = file ? fileClass(file) : null;
  const located = await Promise.all(
    results.map(async (result) => {
      const className = (result.suite ?? "").split("$")[0];
      if (ownClass) {
        return className.split(".").pop() === ownClass ? { ...result, file: file! } : null;
      }
      if (!className) return result;
      const path = `${projectDir}${sep}src${sep}test${sep}java${sep}${className.split(".").join(sep)}.java`;
      return (await exists(path)) ? { ...result, file: path } : result;
    }),
  );
  return located.filter((result): result is TestResult => result !== null);
}

function fileClass(file: string): string {
  return (file.split(/[/\\]/).pop() ?? "").replace(/\.java$/, "");
}

async function goTestNames(file: string): Promise<string[] | null> {
  const text = await readFile(file).catch(() => "");
  const names = [...text.matchAll(/^func\s+(Test\w*)\s*\(/gm)].map((match) => match[1]);
  return names.length ? names : null;
}

/** Rust results are module paths ("tests::adds"); selectors are names. */
function cargoMatches(resultName: string, selector: string): boolean {
  return resultName === selector || resultName.endsWith(`::${selector}`);
}

/** Whether a result belongs to a test item. */
export function resultMatches(framework: Framework, result: TestResult, item: TestItem): boolean {
  switch (framework) {
    case "cargo":
      return cargoMatches(result.name, item.selector);
    case "junit":
      return result.name === item.selector.replace("#", "::");
    default:
      return result.name === item.selector;
  }
}

// --- Debugging a test ----------------------------------------------------------

/** Debug-launch settings for one test (merged into the debugger's launch
 *  configuration), or a reason it can't be debugged. */
export async function debugLaunchFor(
  context: TestContext,
  file: string,
  item: TestItem,
): Promise<
  | {
      overrides?: Record<string, unknown>;
      binary?: string;
      args?: string[];
      cwd?: string;
      jvm?: { command: (port: number) => Promise<string> };
    }
  | { error: string }
> {
  switch (context.framework) {
    case "pytest":
      return {
        overrides: { module: "pytest", program: null, args: [`${file}::${item.selector}`, "-q", "-p", "no:cacheprovider"] },
        cwd: context.projectDir,
      };
    case "vitest":
      return {
        overrides: {
          program: `${context.projectDir}/node_modules/vitest/vitest.mjs`,
          args: ["run", file, "-t", namePattern("vitest", [item]), "--no-file-parallelism"],
        },
        cwd: context.projectDir,
      };
    case "jest":
      return {
        overrides: {
          program: `${context.projectDir}/node_modules/jest/bin/jest.js`,
          args: [file, "-t", namePattern("jest", [item]), "--runInBand"],
        },
        cwd: context.projectDir,
      };
    case "go":
      return { overrides: { mode: "test", program: context.projectDir, args: ["-test.run", `^${item.selector}$`] } };
    case "cargo": {
      // Build the test binary, then debug it running just this test.
      const output = await run("cargo test --no-run --message-format=json", context.projectDir);
      const binary = cargoTestBinary(output.stdout, file);
      if (!binary) return { error: "Couldn't find the test binary — does the crate build?" };
      return { binary, args: [item.selector, "--test-threads=1", "--nocapture"], cwd: context.projectDir };
    }
    case "junit": {
      // The build tool starts the test JVM, connecting to Sable's port.
      const agent = (port: number) => `-agentlib:jdwp=transport=dt_socket,server=n,suspend=y,address=localhost:${port}`;
      const { projectDir, buildTool } = context;
      return {
        cwd: projectDir,
        jvm: {
          command: async (port) => {
            if (buildTool === "maven") {
              return [
                "mvn",
                `-Dmaven.surefire.debug=${agent(port)}`,
                "test",
                `-Dtest=${item.selector}`,
                "-DfailIfNoTests=false",
                "-Dsurefire.failIfNoSpecifiedTests=false",
              ]
                .map(shellQuote)
                .join(" ");
            }
            // Gradle: an init script adds the agent to every Test task.
            const script = await join(await tempDir(), `sable-debug-${port}.gradle`);
            await writeFile(
              script,
              `allprojects {\n  tasks.withType(Test).configureEach {\n    jvmArgs '${agent(port)}'\n    outputs.upToDateWhen { false }\n  }\n}\n`,
            );
            const wrapper = (await exists(`${projectDir}${separator(projectDir)}gradlew`)) ? "./gradlew" : "gradle";
            return [wrapper, "--init-script", script, "test", "--tests", item.selector.replace("#", ".")].map(shellQuote).join(" ");
          },
        },
      };
    }
  }
}

/** The Cargo test executable containing `file`'s tests. */
export function cargoTestBinary(messages: string, file: string): string | null {
  const artifacts = messages
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as {
          reason?: string;
          executable?: string | null;
          profile?: { test?: boolean };
          target?: { src_path?: string; kind?: string[] };
        };
      } catch {
        return null;
      }
    })
    .filter((message) => message?.reason === "compiler-artifact" && message.profile?.test && message.executable);
  // An integration test file is its own target; unit tests live in the
  // lib or bin target whose source tree contains the file.
  const exact = artifacts.find((artifact) => artifact!.target?.src_path === file);
  if (exact) return exact.executable!;
  const crateSource = artifacts.find((artifact) => {
    const source = artifact!.target?.src_path;
    return source && file.startsWith(parentOf(source)) && artifact!.target?.kind?.some((kind) => kind === "lib" || kind === "bin");
  });
  return crateSource?.executable ?? null;
}

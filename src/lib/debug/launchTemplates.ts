/**
 * launch.json starters: the debugger types offered when creating one
 * (VS Code's "Select debugger" pick), their configuration snippets
 * (Add Configuration…), and editing helpers. Pure.
 */

export interface LaunchSnippet {
  label: string;
  description: string;
  config: Record<string, unknown>;
}

export interface DebuggerTemplate {
  id: string;
  label: string;
  /** Files whose presence suggests this debugger (checked in the folder). */
  markers: string[];
  /** File extensions that suggest it (the active file). */
  extensions: string[];
  /** The first snippet goes into a new launch.json. */
  snippets: LaunchSnippet[];
}

export const DEBUGGER_TEMPLATES: DebuggerTemplate[] = [
  {
    id: "python",
    label: "Python Debugger",
    markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "manage.py"],
    extensions: ["py", "pyw"],
    snippets: [
      {
        label: "Python Debugger: Current File",
        description: "Debug the file open in the editor",
        config: { name: "Python Debugger: Current File", type: "debugpy", request: "launch", program: "${file}", console: "integratedTerminal" },
      },
      {
        label: "Python Debugger: Current File with Arguments",
        description: "Asks for the arguments each time",
        config: {
          name: "Python Debugger: Current File with Arguments",
          type: "debugpy",
          request: "launch",
          program: "${file}",
          console: "integratedTerminal",
          args: "${command:pickArgs}",
        },
      },
      {
        label: "Python Debugger: Module",
        description: "python -m <module>",
        config: { name: "Python Debugger: Module", type: "debugpy", request: "launch", module: "enter-your-module-name", console: "integratedTerminal" },
      },
      {
        label: "Python Debugger: Remote Attach",
        description: "Attach to `python -m debugpy --listen 5678`",
        config: {
          name: "Python Debugger: Remote Attach",
          type: "debugpy",
          request: "attach",
          connect: { host: "localhost", port: 5678 },
          pathMappings: [{ localRoot: "${workspaceFolder}", remoteRoot: "." }],
        },
      },
      {
        label: "Python Debugger: Attach using Process Id",
        description: "Pick a running Python process",
        config: { name: "Python Debugger: Attach using Process Id", type: "debugpy", request: "attach", processId: "${command:pickProcess}" },
      },
    ],
  },
  {
    id: "node",
    label: "Node.js",
    markers: ["package.json", "tsconfig.json"],
    extensions: ["js", "mjs", "cjs", "ts", "mts", "cts"],
    snippets: [
      {
        label: "Node.js: Launch Program",
        description: "Run a script with Node",
        config: { type: "node", request: "launch", name: "Launch Program", skipFiles: ["<node_internals>/**"], program: "${workspaceFolder}/index.js" },
      },
      {
        label: "Node.js: Launch Current File",
        description: "Debug the file open in the editor",
        config: { type: "node", request: "launch", name: "Launch Current File", skipFiles: ["<node_internals>/**"], program: "${file}" },
      },
      {
        label: "Node.js: Launch via npm",
        description: "npm run-script debug",
        config: {
          name: "Launch via NPM",
          request: "launch",
          runtimeArgs: ["run-script", "debug"],
          runtimeExecutable: "npm",
          skipFiles: ["<node_internals>/**"],
          type: "node",
        },
      },
      {
        label: "Node.js: Attach",
        description: "Attach to `node --inspect` (port 9229)",
        config: { name: "Attach", port: 9229, request: "attach", skipFiles: ["<node_internals>/**"], type: "node" },
      },
      {
        label: "Node.js: Attach to Process",
        description: "Pick a running Node process",
        config: { name: "Attach by Process ID", processId: "${command:PickProcess}", request: "attach", skipFiles: ["<node_internals>/**"], type: "node" },
      },
    ],
  },
  {
    id: "chrome",
    label: "Web App (Chrome)",
    markers: ["index.html", "vite.config.ts", "vite.config.js"],
    extensions: ["html"],
    snippets: [
      {
        label: "Chrome: Launch",
        description: "Open a page in Chrome and debug its scripts",
        config: { type: "chrome", request: "launch", name: "Launch Chrome against localhost", url: "http://localhost:8080", webRoot: "${workspaceFolder}" },
      },
      {
        label: "Chrome: Attach",
        description: "Attach to Chrome started with --remote-debugging-port=9222",
        config: { type: "chrome", request: "attach", name: "Attach to Chrome", port: 9222, webRoot: "${workspaceFolder}" },
      },
    ],
  },
  {
    id: "go",
    label: "Go (Delve)",
    markers: ["go.mod"],
    extensions: ["go"],
    snippets: [
      {
        label: "Go: Launch Package",
        description: "Debug the package of the open file",
        config: { name: "Launch Package", type: "go", request: "launch", mode: "auto", program: "${fileDirname}" },
      },
      {
        label: "Go: Launch Test Package",
        description: "Debug the tests of a package",
        config: { name: "Launch Test Package", type: "go", request: "launch", mode: "test", program: "${workspaceFolder}" },
      },
      {
        label: "Go: Attach to Local Process",
        description: "Pick a running Go process",
        config: { name: "Attach to Process", type: "go", request: "attach", mode: "local", processId: "${command:pickGoProcess}" },
      },
    ],
  },
  {
    id: "lldb",
    label: "C/C++/Rust (LLDB)",
    markers: ["Cargo.toml", "CMakeLists.txt", "Makefile", "meson.build"],
    extensions: ["c", "cc", "cpp", "cxx", "h", "hpp", "rs"],
    snippets: [
      {
        label: "LLDB: Launch",
        description: "Debug a built executable",
        config: { type: "lldb", request: "launch", name: "Debug", program: "${workspaceFolder}/<executable file>", args: [], cwd: "${workspaceFolder}" },
      },
      {
        label: "LLDB: Cargo Launch",
        description: "Build with Cargo, then debug the binary",
        config: { type: "lldb", request: "launch", name: "Debug executable", cargo: { args: ["build"] }, args: [], cwd: "${workspaceFolder}" },
      },
      {
        label: "LLDB: Attach to Process",
        description: "Pick a running process",
        config: { type: "lldb", request: "attach", name: "Attach", pid: "${command:pickMyProcess}" },
      },
    ],
  },
  {
    id: "java",
    label: "Java",
    markers: ["pom.xml", "build.gradle", "build.gradle.kts"],
    extensions: ["java"],
    snippets: [
      {
        label: "Java: Launch Current File",
        description: "Run the main class of the open file",
        config: { type: "java", name: "Current File", request: "launch", mainClass: "${file}" },
      },
      {
        label: "Java: Launch Main Class",
        description: "Run a main class of the project",
        config: { type: "java", name: "Launch Main", request: "launch", mainClass: "com.example.Main", projectName: "", args: "", vmArgs: "" },
      },
      {
        label: "Java: Attach",
        description: "Attach to a JVM started with -agentlib:jdwp (port 5005)",
        config: { type: "java", name: "Attach to JVM", request: "attach", hostName: "localhost", port: 5005 },
      },
    ],
  },
];

/** Debuggers for a folder, likeliest first: by its marker files, then the
 *  active file's extension. */
export function rankDebuggers(folderFiles: string[], activeFile: string | null): DebuggerTemplate[] {
  const extension = activeFile?.split(".").pop()?.toLowerCase() ?? "";
  const score = (template: DebuggerTemplate) =>
    (template.extensions.includes(extension) ? 2 : 0) + (template.markers.some((marker) => folderFiles.includes(marker)) ? 1 : 0);
  return [...DEBUGGER_TEMPLATES].map((template, index) => ({ template, index })).sort((a, b) => score(b.template) - score(a.template) || a.index - b.index).map(({ template }) => template);
}

const INDENT = "    ";

function indentJson(value: unknown, depth: number): string {
  return JSON.stringify(value, null, INDENT).split("\n").join(`\n${INDENT.repeat(depth)}`);
}

/** A new launch.json holding `configs` (VS Code's layout). */
export function newLaunchJson(configs: Record<string, unknown>[]): string {
  const body = configs.map((config) => `${INDENT.repeat(2)}${indentJson(config, 2)}`).join(",\n");
  return [
    "{",
    `${INDENT}// Use IntelliSense to learn about possible attributes.`,
    `${INDENT}// Hover to view descriptions of existing attributes.`,
    `${INDENT}// Variables like \${workspaceFolder} and \${file} are substituted when debugging.`,
    `${INDENT}"version": "0.2.0",`,
    `${INDENT}"configurations": [`,
    ...(body ? [body] : []),
    `${INDENT}]`,
    "}",
    "",
  ].join("\n");
}

/**
 * Scan JSON-with-comments text, calling `visit` for each structural
 * character outside strings and comments.
 */
function scan(text: string, visit: (char: string, index: number, depth: number) => boolean | void): void {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      for (index++; index < text.length && text[index] !== '"'; index++) if (text[index] === "\\") index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    if (visit(char, index, depth) === true) return;
    if (char === "}" || char === "]") depth--;
  }
}

/**
 * Insert a configuration at the end of launch.json's `configurations`
 * array, keeping the rest of the file (comments, formatting) as it is.
 * Returns the new text and the 1-based line the configuration starts on.
 */
export function insertConfiguration(text: string, config: Record<string, unknown>): { text: string; line: number } {
  if (!text.trim()) {
    const created = newLaunchJson([config]);
    return { text: created, line: created.split("\n").findIndex((line) => line.includes('"configurations"')) + 2 };
  }
  // Find `"configurations"` at depth 1, then its array's bounds.
  const keyMatch = /"configurations"\s*:\s*\[/g;
  let arrayStart = -1;
  for (const match of text.matchAll(keyMatch)) {
    let depthAtKey = -1;
    scan(text, (_, index, depth) => {
      if (index >= match.index!) {
        depthAtKey = depth;
        return true;
      }
    });
    // The first character after the key (outside strings) is at depth 1
    // for a top-level key.
    if (depthAtKey === 1) {
      arrayStart = match.index! + match[0].length - 1;
      break;
    }
  }
  if (arrayStart < 0) {
    // No configurations array: add one after the opening brace.
    const open = text.indexOf("{");
    if (open < 0) return insertConfiguration("", config);
    const snippet = `\n${INDENT}"configurations": [\n${INDENT.repeat(2)}${indentJson(config, 2)}\n${INDENT}],`;
    const updated = text.slice(0, open + 1) + snippet + text.slice(open + 1);
    return { text: updated, line: text.slice(0, open + 1).split("\n").length + 2 };
  }
  let arrayEnd = -1;
  let lastValueEnd = -1;
  let baseDepth = -1;
  scan(text, (char, index, depth) => {
    if (index < arrayStart) return;
    if (index === arrayStart) {
      baseDepth = depth;
      return;
    }
    if (char === "]" && depth === baseDepth) {
      arrayEnd = index;
      return true;
    }
    if (char === "}" && depth === baseDepth + 1) lastValueEnd = index;
  });
  if (arrayEnd < 0) throw new Error("launch.json's configurations array isn't closed");
  const hasItems = lastValueEnd > arrayStart;
  const before = text.slice(0, hasItems ? lastValueEnd + 1 : arrayStart + 1);
  const after = text.slice(hasItems ? lastValueEnd + 1 : arrayEnd);
  // A trailing comma after the last item is already there: don't double it.
  const trailingComma = hasItems && /^\s*,/.test(after);
  const insertion = `${hasItems && !trailingComma ? "," : ""}\n${INDENT.repeat(2)}${indentJson(config, 2)}${hasItems ? "" : `\n${INDENT}`}`;
  const updated = trailingComma
    ? before + after.replace(/^(\s*,)/, `$1\n${INDENT.repeat(2)}${indentJson(config, 2)},`)
    : before + insertion + after;
  const line = (trailingComma ? before + after.match(/^\s*,/)![0] : before).split("\n").length + 1;
  return { text: updated, line };
}

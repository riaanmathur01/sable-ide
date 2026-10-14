import { whenMonaco } from "../editorRegistry";
import { DEBUGGER_TEMPLATES } from "./launchTemplates";

/**
 * JSON schemas for .vscode/launch.json and .vscode/tasks.json, so the
 * editor completes and checks them (Monaco's JSON language service).
 */

const str = (description: string) => ({ type: "string", description });
const env = { type: "object", additionalProperties: { type: ["string", "null"] }, description: "Environment variables for the program." };
const args = { type: ["array", "string"], items: { type: "string" }, description: "Command-line arguments (a string is split like a shell would)." };

const COMMON = {
  name: str("Name shown in the Run and Debug configuration list."),
  type: {
    type: "string",
    description: "The debugger.",
    enum: ["debugpy", "python", "node", "pwa-node", "node-terminal", "chrome", "pwa-chrome", "msedge", "pwa-msedge", "go", "lldb", "lldb-dap", "codelldb", "cppdbg", "java"],
  },
  request: { type: "string", enum: ["launch", "attach"], description: "Start a program, or attach to one that's running." },
  preLaunchTask: str("A task (from tasks.json) to run before the session starts; a failure stops the launch."),
  postDebugTask: str("A task to run after the session ends."),
  envFile: str("A file of NAME=value lines to add to the environment (`env` wins)."),
  presentation: {
    type: "object",
    properties: { hidden: { type: "boolean" }, group: { type: "string" }, order: { type: "number" } },
  },
  internalConsoleOptions: { enum: ["neverOpen", "openOnFirstSessionStart", "openOnSessionStart"] },
};

const CONFIG_PROPERTIES = {
  ...COMMON,
  program: str("The program to debug (a file, package or executable)."),
  module: str("Python: run a module (`python -m`)."),
  args,
  cwd: str("Working directory of the program."),
  env,
  console: { enum: ["internalConsole", "integratedTerminal", "externalTerminal"], description: "Where the program's input and output go." },
  stopOnEntry: { type: "boolean", description: "Pause on the first line." },
  justMyCode: { type: "boolean", description: "Python: step only through your own code." },
  python: str("Python: the interpreter to run the program with."),
  connect: { type: "object", properties: { host: { type: "string" }, port: { type: "number" } }, description: "Python attach: where `debugpy --listen` waits." },
  processId: { type: ["number", "string"], description: "Attach to this process (`${command:pickProcess}` asks)." },
  port: { type: "number", description: "Attach port." },
  runtimeExecutable: str("Node: the runtime (node, npm, yarn…)."),
  runtimeArgs: { type: "array", items: { type: "string" }, description: "Node: arguments for the runtime." },
  skipFiles: { type: "array", items: { type: "string" }, description: "Node: files to skip when stepping." },
  outFiles: { type: "array", items: { type: "string" }, description: "Node: where the generated JavaScript is (source maps)." },
  sourceMaps: { type: "boolean" },
  url: str("Chrome: the page to open."),
  webRoot: str("Chrome: the folder the served files come from."),
  mode: { enum: ["auto", "debug", "test", "exec", "local", "remote"], description: "Go: what to build and debug." },
  buildFlags: { type: ["string", "array"], description: "Go: flags for the build." },
  mainClass: str("Java: the main class (or ${file})."),
  projectName: str("Java: the project the main class is in."),
  vmArgs: { type: ["string", "array"], description: "Java: JVM options." },
  hostName: str("Java attach: the JVM's host."),
  pid: { type: ["number", "string"], description: "LLDB attach: the process id." },
  cargo: { type: "object", properties: { args: { type: "array", items: { type: "string" } }, filter: { type: "object" } }, description: "Build with Cargo first." },
};

const INPUT = {
  type: "object",
  required: ["id", "type"],
  properties: {
    id: { type: "string" },
    type: { enum: ["promptString", "pickString", "command"] },
    description: { type: "string" },
    default: { type: "string" },
    password: { type: "boolean" },
    options: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { label: { type: "string" }, value: { type: "string" } } }] } },
  },
};

export const LAUNCH_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", enum: ["0.2.0"] },
    configurations: {
      type: "array",
      description: "Debug configurations.",
      items: {
        type: "object",
        required: ["name", "type", "request"],
        properties: { ...CONFIG_PROPERTIES, osx: { type: "object" }, linux: { type: "object" }, windows: { type: "object" } },
        defaultSnippets: DEBUGGER_TEMPLATES.flatMap((template) =>
          template.snippets.map((snippet) => ({ label: snippet.label, description: snippet.description, body: snippet.config })),
        ),
      },
    },
    compounds: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "configurations"],
        properties: {
          name: { type: "string" },
          configurations: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { name: { type: "string" }, folder: { type: "string" } } }] } },
          stopAll: { type: "boolean", description: "Stopping one session stops them all." },
          preLaunchTask: { type: "string" },
        },
      },
    },
    inputs: { type: "array", items: INPUT },
  },
};

export const TASKS_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", enum: ["2.0.0"] },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          type: { enum: ["shell", "process", "npm"] },
          command: { type: "string" },
          args: { type: "array" },
          options: { type: "object", properties: { cwd: { type: "string" }, env } },
          dependsOn: { type: ["string", "array"] },
          dependsOrder: { enum: ["parallel", "sequence"] },
          isBackground: { type: "boolean" },
          group: { anyOf: [{ enum: ["build", "test", "none"] }, { type: "object", properties: { kind: { type: "string" }, isDefault: { type: "boolean" } } }] },
          problemMatcher: {},
          presentation: { type: "object" },
          script: { type: "string" },
        },
      },
    },
    inputs: { type: "array", items: INPUT },
  },
};

let registered = false;

/** Add the schemas to Monaco's JSON service (once Monaco has loaded). */
export function registerLaunchSchemas(): void {
  if (registered) return;
  registered = true;
  void whenMonaco().then((monaco) => {
    const defaults = monaco.json.jsonDefaults;
    const current = defaults.diagnosticsOptions;
    const ours = [
      { uri: "sable://schemas/launch.json", fileMatch: ["**/.vscode/launch.json", "*/.vscode/launch.json"], schema: LAUNCH_SCHEMA },
      { uri: "sable://schemas/tasks.json", fileMatch: ["**/.vscode/tasks.json", "*/.vscode/tasks.json"], schema: TASKS_SCHEMA },
    ];
    defaults.setDiagnosticsOptions({
      ...current,
      validate: true,
      // launch.json and tasks.json are JSON with comments.
      allowComments: true,
      trailingCommas: "ignore",
      schemas: [...(current.schemas ?? []).filter((schema) => !ours.some((own) => own.uri === schema.uri)), ...ours],
    });
  });
}

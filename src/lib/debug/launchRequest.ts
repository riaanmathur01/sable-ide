import { parseArgs } from "../runConfig";

/**
 * A launch.json configuration (variables already substituted) → the DAP
 * launch/attach request for one of Sable's adapters, in that adapter's
 * terms. Like VS Code, fields Sable doesn't know go to the adapter
 * unchanged. Pure, so it can be unit-tested.
 */

/** Which adapter runs it (src-tauri/src/launch_config.rs `AdapterSpec`). */
export interface AdapterSpec {
  kind: "debugpy" | "js-debug" | "go" | "lldb" | "java";
  python?: string;
  port?: number;
  terminal?: boolean;
  cargo?: string[];
  cargoFilter?: unknown;
  cwd?: string;
}

export interface ResolvedLaunch {
  adapter: AdapterSpec;
  /** The DAP launch/attach arguments. */
  request: Record<string, unknown>;
  /** Java: main class / classpath come from jdtls before starting. */
  needsJdtls?: boolean;
  /** Files that must exist (checked before starting, for a clear error). */
  requiredPaths: { path: string; what: string }[];
}

/** A configuration Sable can't run (the message says why). */
export class LaunchError extends Error {}

export interface MapOptions {
  workspaceFolder: string | null;
  /** The selected Python interpreter. */
  python: string | null;
  /** Variables from the configuration's `envFile`, already read. */
  envFile?: Record<string, string> | null;
}

export const SUPPORTED_TYPES =
  "python/debugpy, node/pwa-node, chrome/pwa-chrome, msedge, go, lldb/lldb-dap/codelldb/cppdbg, java";

/** VS Code's own fields: never sent to an adapter. */
const CLIENT_ONLY = [
  "preLaunchTask",
  "postDebugTask",
  "presentation",
  "internalConsoleOptions",
  "serverReadyAction",
  "debugServer",
  "envFile",
  "osx",
  "linux",
  "windows",
];

const isAbsolute = (path: string) => /^([A-Za-z]:[/\\]|[/\\])/.test(path);
const join = (base: string, path: string) => (isAbsolute(path) ? path : `${base.replace(/[/\\]+$/, "")}/${path.replace(/^\.[/\\]/, "")}`);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringEnv(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const env: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    env[name] = String(item);
  }
  return env;
}

/** `args` as a list (a string is split like a shell would). */
function argList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return parseArgs(value);
  if (Array.isArray(value)) return value.map(String);
  throw new LaunchError(`"args" must be an array of strings`);
}

function toInteger(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) throw new LaunchError(`"${field}" must be a process id or port number (got ${JSON.stringify(value)})`);
  return number;
}

export function toLaunchRequest(config: Record<string, unknown>, options: MapOptions): ResolvedLaunch {
  const name = typeof config.name === "string" ? config.name : "Debug";
  const type = typeof config.type === "string" ? config.type : "";
  const requestKind = config.request;
  if (!type) throw new LaunchError(`Configuration “${name}” has no "type"`);
  if (requestKind !== "launch" && requestKind !== "attach") {
    throw new LaunchError(`Configuration “${name}”: "request" must be "launch" or "attach"`);
  }
  const request: Record<string, unknown> = { ...config };
  for (const key of CLIENT_ONLY) delete request[key];
  const launching = requestKind === "launch";
  const folder = options.workspaceFolder;
  const requiredPaths: ResolvedLaunch["requiredPaths"] = [];
  // envFile first, `env` wins (VS Code's order).
  const mergeEnv = () => {
    const env = { ...(options.envFile ?? {}), ...stringEnv(config.env) };
    if (Object.keys(env).length) request.env = env;
    else delete request.env;
  };
  const defaultCwd = () => {
    if (request.cwd === undefined && folder) request.cwd = folder;
  };
  const normalizeArgs = () => {
    const args = argList(config.args);
    if (args) request.args = args;
  };

  switch (type) {
    case "python":
    case "debugpy": {
      request.type = "python";
      const configured = Array.isArray(config.python) ? config.python[0] : (config.python ?? config.pythonPath);
      const python = typeof configured === "string" && configured ? configured : (options.python ?? "python3");
      delete request.pythonPath;
      if (launching) {
        if (!config.program && !config.module && !config.code) {
          throw new LaunchError(`Configuration “${name}”: set "program" (a file) or "module" to debug`);
        }
        normalizeArgs();
        mergeEnv();
        defaultCwd();
        request.console ??= "integratedTerminal";
        if (request.console === "internalConsole") request.redirectOutput ??= true;
        request.justMyCode ??= true;
        request.python ??= python;
        if (typeof config.program === "string") {
          requiredPaths.push({ path: join(String(request.cwd ?? folder ?? ""), config.program), what: "program" });
        }
      } else {
        // Legacy `host`/`port` → `connect`.
        if (!config.connect && (config.port !== undefined || config.host !== undefined) && !config.listen) {
          request.connect = { host: config.host ?? "127.0.0.1", port: config.port };
          delete request.host;
          delete request.port;
        }
        if (isObject(request.connect)) {
          request.connect = { host: "127.0.0.1", ...request.connect, port: toInteger(request.connect.port, "connect.port") };
        } else if (config.processId !== undefined) {
          request.processId = toInteger(config.processId, "processId");
        } else if (!config.listen) {
          throw new LaunchError(`Configuration “${name}”: attaching needs "connect": {"host", "port"} or "processId"`);
        }
        request.justMyCode ??= true;
      }
      return { adapter: { kind: "debugpy", python }, request, requiredPaths };
    }

    case "node":
    case "pwa-node":
    case "node2":
    case "node-terminal": {
      request.type = type === "node-terminal" ? "node-terminal" : "pwa-node";
      if (launching) {
        if (type !== "node-terminal" && !config.program && !config.runtimeExecutable) {
          throw new LaunchError(`Configuration “${name}”: set "program" (or "runtimeExecutable" for npm scripts)`);
        }
        normalizeArgs();
        const runtimeArgs = argList(config.runtimeArgs);
        if (runtimeArgs) request.runtimeArgs = runtimeArgs;
        mergeEnv();
        defaultCwd();
        request.console ??= "internalConsole";
        request.skipFiles ??= ["<node_internals>/**"];
        if (typeof config.program === "string") {
          requiredPaths.push({ path: join(String(request.cwd ?? folder ?? ""), config.program), what: "program" });
        }
      } else {
        if (config.processId !== undefined) request.processId = String(config.processId);
        else request.port = config.port === undefined ? 9229 : toInteger(config.port, "port");
        request.address ??= "localhost";
        request.skipFiles ??= ["<node_internals>/**"];
      }
      return { adapter: { kind: "js-debug" }, request, requiredPaths };
    }

    case "chrome":
    case "pwa-chrome":
    case "msedge":
    case "pwa-msedge": {
      request.type = type.includes("msedge") ? "pwa-msedge" : "pwa-chrome";
      if (folder) request.webRoot ??= folder;
      if (launching) {
        if (!config.url && !config.file) throw new LaunchError(`Configuration “${name}”: set "url" (or "file") to open in the browser`);
      } else {
        request.port = config.port === undefined ? 9222 : toInteger(config.port, "port");
      }
      return { adapter: { kind: "js-debug" }, request, requiredPaths };
    }

    case "go": {
      request.type = "go";
      delete request.debugAdapter;
      delete request.dlvFlags;
      if (launching) {
        const program = typeof config.program === "string" ? config.program : null;
        if (!program) throw new LaunchError(`Configuration “${name}”: set "program" (a package folder or a .go file)`);
        // Delve resolves relative paths against its own directory, not the project.
        request.program = folder ? join(folder, program) : program;
        const mode = typeof config.mode === "string" ? config.mode : "auto";
        request.mode = mode === "auto" ? (/_test\.go$/.test(program) ? "test" : "debug") : mode;
        if (!["debug", "test", "exec", "replay", "core"].includes(String(request.mode))) {
          throw new LaunchError(`Configuration “${name}”: Go mode “${mode}” isn't supported (use debug, test or exec)`);
        }
        normalizeArgs();
        mergeEnv();
        if (Array.isArray(config.buildFlags)) request.buildFlags = config.buildFlags.map(String).join(" ");
        if (typeof request.cwd === "string" && folder) request.cwd = join(folder, request.cwd);
        const terminal = config.console === "integratedTerminal" || config.console === "externalTerminal";
        delete request.console;
        requiredPaths.push({ path: String(request.program), what: "program" });
        return { adapter: { kind: "go", terminal }, request, requiredPaths };
      }
      const mode = config.mode ?? "local";
      if (mode !== "local") {
        throw new LaunchError(`Configuration “${name}”: Go attach mode “${String(mode)}” isn't supported — Sable attaches to local processes ("mode": "local")`);
      }
      request.mode = "local";
      request.processId = toInteger(config.processId, "processId");
      return { adapter: { kind: "go" }, request, requiredPaths };
    }

    case "lldb":
    case "lldb-dap":
    case "lldb-vscode":
    case "codelldb":
    case "cppdbg": {
      request.type = "lldb-dap";
      let cargo: string[] | undefined;
      let cargoFilter: unknown;
      if (isObject(config.cargo)) {
        cargo = argList(config.cargo.args) ?? ["build"];
        cargoFilter = config.cargo.filter;
      }
      if (launching) {
        if (!config.program && !cargo) throw new LaunchError(`Configuration “${name}”: set "program" (the executable to debug)`);
        normalizeArgs();
        // cppdbg: [{name, value}] environment and stopAtEntry.
        if (Array.isArray(config.environment)) {
          const env: Record<string, string> = {};
          for (const item of config.environment) if (isObject(item) && typeof item.name === "string") env[item.name] = String(item.value ?? "");
          config = { ...config, env: { ...env, ...stringEnv(config.env) } };
        }
        mergeEnv();
        defaultCwd();
        if (config.stopAtEntry !== undefined) request.stopOnEntry = config.stopAtEntry;
        const terminal =
          config.externalConsole === true ||
          config.console === "integratedTerminal" ||
          config.console === "externalTerminal" ||
          config.terminal === "integrated" ||
          config.terminal === "external";
        if (terminal) request.runInTerminal = true;
        if (typeof config.program === "string" && !cargo) {
          requiredPaths.push({ path: join(String(request.cwd ?? folder ?? ""), config.program), what: "program" });
        }
      } else {
        const pid = config.pid ?? config.processId;
        if (pid !== undefined) request.pid = toInteger(pid, "pid");
        else if (!config.program) throw new LaunchError(`Configuration “${name}”: attaching needs "pid" (or "program" with "waitFor")`);
      }
      // CodeLLDB's sourceMap is an object; lldb-dap wants pairs.
      if (isObject(config.sourceMap)) request.sourceMap = Object.entries(config.sourceMap);
      for (const key of [
        "MIMode",
        "miDebuggerPath",
        "miDebuggerArgs",
        "miDebuggerServerAddress",
        "setupCommands",
        "externalConsole",
        "environment",
        "stopAtEntry",
        "logging",
        "visualizerFile",
        "symbolSearchPath",
        "sourceLanguages",
        "terminal",
        "console",
        "cargo",
        "processId",
        "sourceFileMap",
      ]) {
        delete request[key];
      }
      return {
        adapter: { kind: "lldb", ...(cargo ? { cargo, cargoFilter, cwd: String(request.cwd ?? folder ?? ".") } : {}) },
        request,
        requiredPaths,
      };
    }

    case "java": {
      request.type = "java";
      if (launching) {
        if (!config.mainClass) throw new LaunchError(`Configuration “${name}”: set "mainClass"`);
        mergeEnv();
        defaultCwd();
        request.console ??= "integratedTerminal";
        return { adapter: { kind: "java" }, request, needsJdtls: true, requiredPaths };
      }
      if (config.port === undefined) throw new LaunchError(`Configuration “${name}”: attaching needs "hostName" and "port"`);
      request.hostName ??= "localhost";
      request.port = toInteger(config.port, "port");
      return { adapter: { kind: "java" }, request, needsJdtls: true, requiredPaths };
    }

    case "cppvsdbg":
      throw new LaunchError(`Configuration “${name}”: “cppvsdbg” (the Visual Studio debugger) isn't available — use "type": "lldb"`);
    default:
      throw new LaunchError(`Configuration “${name}”: debug type “${type}” isn't supported by Sable (supported: ${SUPPORTED_TYPES})`);
  }
}

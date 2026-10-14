import type { LaunchInput } from "./launchJson";

/**
 * VS Code's `${…}` variables in launch.json and tasks.json. Pure apart
 * from the callbacks in the context (prompts, the process picker), so
 * it can be unit-tested.
 */

export interface VariableContext {
  /** The folder the launch.json belongs to (null: a .code-workspace config). */
  workspaceFolder: string | null;
  /** Every folder of the workspace, for `${workspaceFolder:name}`. */
  folders: string[];
  /** The active editor's file, line and selection. */
  file: string | null;
  lineNumber: number | null;
  selectedText: string | null;
  env: Record<string, string>;
  userHome: string;
  pathSeparator: string;
  /** A setting's value (`${config:editor.fontSize}`), undefined if unset. */
  config: (key: string) => unknown;
  inputs: LaunchInput[];
  /** Ask for an input's value; null when cancelled. */
  promptInput: (input: LaunchInput) => Promise<string | null>;
  /** Let the user choose a process; its id, or null when cancelled. */
  pickProcess: (mine: boolean) => Promise<string | null>;
  /** `${command:pickArgs}` (Python): ask for program arguments. */
  pickArgs?: () => Promise<string | null>;
  /** The selected Python interpreter (`${command:python.interpreterPath}`). */
  pythonInterpreter?: () => string | null;
  defaultBuildTask: () => string | null;
  /** Answers already given during this launch (an input asked once). */
  answers?: Map<string, string>;
}

/** A variable that can't be resolved (unknown, or nothing to resolve it from). */
export class VariableError extends Error {}

/** The user cancelled a prompt: stop the launch quietly. */
export class LaunchCancelled extends Error {
  constructor() {
    super("Launch cancelled");
  }
}

const basename = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;
const dirname = (path: string) => {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? (index === 0 ? path[0] : ".") : path.slice(0, index);
};
const extname = (path: string) => {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
};
const isInside = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`);

/** The workspace folder holding `path` (the innermost). */
function folderOfPath(path: string, folders: string[]): string | null {
  let best: string | null = null;
  for (const folder of folders) if (isInside(path, folder) && (!best || folder.length > best.length)) best = folder;
  return best;
}

function relative(path: string, folder: string | null): string {
  return folder && isInside(path, folder) ? path.slice(folder.length).replace(/^[/\\]/, "") : path;
}

const PICK_PROCESS_COMMANDS = new Set([
  "pickProcess",
  "pickMyProcess",
  "PickProcess",
  "extension.pickNodeProcess",
  "pickGoProcess",
  "pickRemoteProcess",
  "lldb.pickProcess",
  "lldb.pickMyProcess",
  "python.pickProcess",
]);

/** Resolve one `${…}` variable's name (the text between the braces). */
async function resolveVariable(name: string, context: VariableContext): Promise<string> {
  const answers = (context.answers ??= new Map());
  const needFile = () => {
    if (!context.file) throw new VariableError(`\${${name}} needs an open file — open one in the editor first`);
    return context.file;
  };
  const needFolder = () => {
    const folder = context.workspaceFolder ?? context.folders[0] ?? null;
    if (!folder) throw new VariableError(`\${${name}} needs an open folder`);
    return folder;
  };
  const colon = name.indexOf(":");
  if (colon > 0) {
    const kind = name.slice(0, colon);
    const argument = name.slice(colon + 1);
    switch (kind) {
      case "env":
        return context.env[argument] ?? "";
      case "config": {
        const value = context.config(argument);
        if (value === undefined) throw new VariableError(`\${config:${argument}}: no such setting`);
        return typeof value === "string" ? value : JSON.stringify(value);
      }
      case "workspaceFolder":
      case "workspaceFolderBasename":
      case "workspaceRoot": {
        const folder = context.folders.find((candidate) => basename(candidate) === argument);
        if (!folder) throw new VariableError(`\${${name}}: no workspace folder named “${argument}”`);
        return kind === "workspaceFolderBasename" ? basename(folder) : folder;
      }
      case "input": {
        const cached = answers.get(`input:${argument}`);
        if (cached !== undefined) return cached;
        const input = context.inputs.find((candidate) => candidate.id === argument);
        if (!input) throw new VariableError(`\${input:${argument}}: no input with id “${argument}” in "inputs"`);
        if (input.type !== "promptString" && input.type !== "pickString") {
          throw new VariableError(`\${input:${argument}}: inputs of type “${input.type}” aren't supported (use promptString or pickString)`);
        }
        const answer = await context.promptInput(input);
        if (answer === null) throw new LaunchCancelled();
        answers.set(`input:${argument}`, answer);
        return answer;
      }
      case "command": {
        const cached = answers.get(`command:${argument}`);
        if (cached !== undefined) return cached;
        let answer: string | null;
        if (PICK_PROCESS_COMMANDS.has(argument)) {
          answer = await context.pickProcess(argument.toLowerCase().includes("my"));
        } else if (argument === "pickArgs" || argument === "python.pickArgs") {
          if (!context.pickArgs) throw new VariableError(`\${command:${argument}} isn't available here`);
          answer = await context.pickArgs();
        } else if (argument === "python.interpreterPath") {
          answer = context.pythonInterpreter?.() ?? "python3";
        } else {
          throw new VariableError(`\${command:${argument}} isn't supported by Sable (supported: pickProcess, pickMyProcess, pickArgs, python.interpreterPath)`);
        }
        if (answer === null) throw new LaunchCancelled();
        answers.set(`command:${argument}`, answer);
        return answer;
      }
      default:
        throw new VariableError(`Unknown variable \${${name}}`);
    }
  }
  switch (name) {
    case "workspaceFolder":
    case "workspaceRoot":
      return needFolder();
    case "workspaceFolderBasename":
      return basename(needFolder());
    case "file":
      return needFile();
    case "fileBasename":
      return basename(needFile());
    case "fileBasenameNoExtension": {
      const base = basename(needFile());
      const extension = extname(base);
      return extension ? base.slice(0, -extension.length) : base;
    }
    case "fileDirname":
      return dirname(needFile());
    case "fileDirnameBasename":
      return basename(dirname(needFile()));
    case "fileExtname":
      return extname(needFile());
    case "fileWorkspaceFolder": {
      const folder = folderOfPath(needFile(), context.folders);
      if (!folder) throw new VariableError(`\${fileWorkspaceFolder}: the open file isn't in the workspace`);
      return folder;
    }
    case "fileWorkspaceFolderBasename": {
      const folder = folderOfPath(needFile(), context.folders);
      if (!folder) throw new VariableError(`\${fileWorkspaceFolderBasename}: the open file isn't in the workspace`);
      return basename(folder);
    }
    case "relativeFile": {
      const file = needFile();
      return relative(file, folderOfPath(file, context.folders) ?? context.workspaceFolder);
    }
    case "relativeFileDirname": {
      // As VS Code: the dirname of ${relativeFile} ("." at the top).
      const file = needFile();
      const relativePath = relative(file, folderOfPath(file, context.folders) ?? context.workspaceFolder);
      return /[/\\]/.test(relativePath) ? dirname(relativePath) : ".";
    }
    case "lineNumber":
      if (context.lineNumber == null) throw new VariableError("${lineNumber} needs an open file");
      return String(context.lineNumber);
    case "selectedText":
      return context.selectedText ?? "";
    case "cwd":
      return context.workspaceFolder ?? context.folders[0] ?? context.userHome;
    case "pathSeparator":
    case "/":
      return context.pathSeparator;
    case "userHome":
      return context.userHome;
    case "defaultBuildTask": {
      const task = context.defaultBuildTask();
      if (!task) throw new VariableError("${defaultBuildTask}: tasks.json has no build task");
      return task;
    }
    default:
      throw new VariableError(`Unknown variable \${${name}}`);
  }
}

const VARIABLE = /\$\{([^{}]+)\}/g;

/** Substitute the variables in a string. */
export async function substituteString(text: string, context: VariableContext): Promise<string> {
  if (!text.includes("${")) return text;
  let result = "";
  let last = 0;
  for (const match of text.matchAll(VARIABLE)) {
    result += text.slice(last, match.index);
    result += await resolveVariable(match[1].trim(), context);
    last = match.index! + match[0].length;
  }
  return result + text.slice(last);
}

/** Substitute variables in every string of a configuration (keys stay). */
export async function substitute<T>(value: T, context: VariableContext): Promise<T> {
  if (typeof value === "string") return (await substituteString(value, context)) as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await substitute(item, context));
    return out as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await substitute(item, context);
    return out as T;
  }
  return value;
}

/** The `${input:…}` / `${command:…}` variables a value uses, in order —
 *  so a launch can ask for everything up front. */
export function interactiveVariables(value: unknown): string[] {
  const found: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      for (const match of item.matchAll(VARIABLE)) {
        const name = match[1].trim();
        if ((name.startsWith("input:") || name.startsWith("command:")) && !found.includes(name)) found.push(name);
      }
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  return found;
}

import { parseJsonc } from "../jsonc";

/**
 * VS Code launch.json / tasks.json: parsing and the entries the Run and
 * Debug view lists. Pure (callers read the files), so it can be
 * unit-tested.
 */

/** One `configurations` entry. Unknown fields go to the adapter as-is. */
export interface LaunchConfig {
  name: string;
  type: string;
  request: string;
  preLaunchTask?: string;
  postDebugTask?: string;
  presentation?: { hidden?: boolean; group?: string; order?: number };
  [key: string]: unknown;
}

/** A compound reference: a configuration by name, optionally in another folder. */
export type CompoundMember = string | { name: string; folder?: string };

export interface Compound {
  name: string;
  configurations: CompoundMember[];
  /** Stopping one session stops them all. */
  stopAll?: boolean;
  preLaunchTask?: string;
  presentation?: { hidden?: boolean };
}

/** An `inputs` entry (`${input:id}`). */
export interface LaunchInput {
  id: string;
  type: "promptString" | "pickString" | "command" | string;
  description?: string;
  default?: string;
  password?: boolean;
  options?: (string | { label?: string; value: string })[];
  command?: string;
  args?: unknown;
}

export interface LaunchFile {
  configurations: LaunchConfig[];
  compounds: Compound[];
  inputs: LaunchInput[];
  /** Problems found (a configuration without a name…), for the console. */
  errors: string[];
}

export const EMPTY_LAUNCH: LaunchFile = { configurations: [], compounds: [], inputs: [], errors: [] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `launch` object of launch.json, or of a .code-workspace file. */
export function parseLaunchObject(raw: unknown, where = "launch.json"): LaunchFile {
  const file: LaunchFile = { configurations: [], compounds: [], inputs: [], errors: [] };
  if (!isObject(raw)) {
    if (raw !== undefined) file.errors.push(`${where}: expected an object`);
    return file;
  }
  const configurations = raw.configurations ?? [];
  if (!Array.isArray(configurations)) file.errors.push(`${where}: "configurations" must be an array`);
  else {
    configurations.forEach((config, index) => {
      if (!isObject(config)) {
        file.errors.push(`${where}: configuration ${index + 1} isn't an object`);
        return;
      }
      if (typeof config.name !== "string" || !config.name.trim()) {
        file.errors.push(`${where}: configuration ${index + 1} has no "name"`);
        return;
      }
      if (typeof config.type !== "string" || typeof config.request !== "string") {
        file.errors.push(`${where}: “${config.name}” needs "type" and "request"`);
      }
      file.configurations.push({
        ...config,
        name: config.name,
        type: typeof config.type === "string" ? config.type : "",
        request: typeof config.request === "string" ? config.request : "",
      } as LaunchConfig);
    });
  }
  const compounds = raw.compounds ?? [];
  if (Array.isArray(compounds)) {
    for (const compound of compounds) {
      if (!isObject(compound) || typeof compound.name !== "string") continue;
      const members = Array.isArray(compound.configurations)
        ? compound.configurations.filter(
            (member): member is CompoundMember =>
              typeof member === "string" || (isObject(member) && typeof member.name === "string"),
          )
        : [];
      file.compounds.push({ ...(compound as object), name: compound.name, configurations: members } as Compound);
    }
  }
  const inputs = raw.inputs ?? [];
  if (Array.isArray(inputs)) {
    for (const input of inputs) {
      if (isObject(input) && typeof input.id === "string") file.inputs.push(input as unknown as LaunchInput);
    }
  }
  return file;
}

/** Parse launch.json text (JSON with comments). */
export function parseLaunchJson(text: string, where = "launch.json"): LaunchFile {
  if (!text.trim()) return { ...EMPTY_LAUNCH, errors: [] };
  try {
    return parseLaunchObject(parseJsonc(text), where);
  } catch (error) {
    return { ...EMPTY_LAUNCH, errors: [`${where}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** The `launch` section of a .code-workspace file. */
export function parseWorkspaceLaunch(text: string, where = "workspace file"): LaunchFile {
  try {
    const raw = parseJsonc(text);
    return isObject(raw) && raw.launch !== undefined ? parseLaunchObject(raw.launch, where) : { ...EMPTY_LAUNCH, errors: [] };
  } catch (error) {
    return { ...EMPTY_LAUNCH, errors: [`${where}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

// --- The entries the Run and Debug view lists --------------------------------

/** Where a launch file came from: a folder's .vscode/launch.json, or the
 *  .code-workspace file (folder null). */
export interface LaunchSource {
  folder: string | null;
  path: string;
  file: LaunchFile;
}

export type LaunchEntry =
  | { kind: "config"; key: string; label: string; config: LaunchConfig; source: LaunchSource }
  | { kind: "compound"; key: string; label: string; compound: Compound; source: LaunchSource };

export const folderBasename = (folder: string) => folder.split(/[/\\]/).filter(Boolean).pop() ?? folder;

export const entryKey = (kind: "config" | "compound", folder: string | null, name: string) =>
  `${kind}|${folder ?? "<workspace>"}|${name}`;

/** Every visible configuration and compound, labeled `Name (folder)` in a
 *  multi-root workspace (VS Code's labels). */
export function launchEntries(sources: LaunchSource[], multiRoot: boolean): LaunchEntry[] {
  const entries: LaunchEntry[] = [];
  const suffix = (source: LaunchSource) =>
    multiRoot ? ` (${source.folder ? folderBasename(source.folder) : "workspace"})` : source.folder ? "" : " (workspace)";
  for (const source of sources) {
    const visible = source.file.configurations
      .filter((config) => !config.presentation?.hidden)
      .map((config, index) => ({ config, index }))
      // presentation.order sorts within the file (stable otherwise).
      .sort((a, b) => (a.config.presentation?.order ?? 1e9) - (b.config.presentation?.order ?? 1e9) || a.index - b.index);
    for (const { config } of visible) {
      entries.push({ kind: "config", key: entryKey("config", source.folder, config.name), label: config.name + suffix(source), config, source });
    }
    for (const compound of source.file.compounds) {
      if (compound.presentation?.hidden) continue;
      entries.push({
        kind: "compound",
        key: entryKey("compound", source.folder, compound.name),
        label: compound.name + suffix(source),
        compound,
        source,
      });
    }
  }
  return entries;
}

/** The configurations a compound starts, in order. A member names a
 *  configuration in the compound's own file, else (with `folder`, or when
 *  the name is unique) another folder's. */
export function compoundMembers(
  compound: Compound,
  source: LaunchSource,
  sources: LaunchSource[],
): { config: LaunchConfig; source: LaunchSource }[] {
  return compound.configurations.map((member) => {
    const name = typeof member === "string" ? member : member.name;
    const folder = typeof member === "string" ? undefined : member.folder;
    const candidates = folder
      ? sources.filter((candidate) => candidate.folder && (folderBasename(candidate.folder) === folder || candidate.folder === folder))
      : [source, ...sources.filter((candidate) => candidate !== source)];
    for (const candidate of candidates) {
      const config = candidate.file.configurations.find((existing) => existing.name === name);
      if (config) return { config, source: candidate };
    }
    throw new Error(`Compound “${compound.name}”: no configuration named “${name}”${folder ? ` in folder ${folder}` : ""}`);
  });
}

// --- tasks.json ---------------------------------------------------------------

export interface TaskDefinition {
  label: string;
  type?: string;
  command?: string;
  args?: (string | { value: string; quoting?: string })[];
  options?: { cwd?: string; env?: Record<string, string>; shell?: { executable?: string; args?: string[] } };
  dependsOn?: string | string[];
  dependsOrder?: "parallel" | "sequence";
  isBackground?: boolean;
  group?: string | { kind?: string; isDefault?: boolean };
  /** npm tasks. */
  script?: string;
  path?: string;
  windows?: Partial<TaskDefinition>;
  osx?: Partial<TaskDefinition>;
  linux?: Partial<TaskDefinition>;
  [key: string]: unknown;
}

export interface TasksFile {
  tasks: TaskDefinition[];
  inputs: LaunchInput[];
  errors: string[];
}

/** tasks.json (or a .code-workspace file's `tasks`). */
export function parseTasksObject(raw: unknown, where = "tasks.json"): TasksFile {
  const file: TasksFile = { tasks: [], inputs: [], errors: [] };
  if (!isObject(raw)) return file;
  if (Array.isArray(raw.tasks)) {
    for (const task of raw.tasks) {
      if (!isObject(task)) continue;
      // Version 0.1.0 used taskName; npm tasks may be unlabeled.
      const label =
        typeof task.label === "string"
          ? task.label
          : typeof task.taskName === "string"
            ? task.taskName
            : task.type === "npm" && typeof task.script === "string"
              ? `npm: ${task.script}`
              : null;
      if (!label) {
        file.errors.push(`${where}: a task has no "label"`);
        continue;
      }
      file.tasks.push({ ...task, label } as TaskDefinition);
    }
  }
  if (Array.isArray(raw.inputs)) {
    for (const input of raw.inputs) if (isObject(input) && typeof input.id === "string") file.inputs.push(input as unknown as LaunchInput);
  }
  return file;
}

export function parseTasksJson(text: string, where = "tasks.json"): TasksFile {
  if (!text.trim()) return { tasks: [], inputs: [], errors: [] };
  try {
    return parseTasksObject(parseJsonc(text), where);
  } catch (error) {
    return { tasks: [], inputs: [], errors: [`${where}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export type Platform = "osx" | "linux" | "windows";

/** A configuration or task with its `osx` / `linux` / `windows` part merged in. */
export function withPlatform<T extends Record<string, unknown>>(value: T, platform: Platform): T {
  const { osx, linux, windows, ...rest } = value as Record<string, unknown>;
  const specific = { osx, linux, windows }[platform];
  if (!isObject(specific)) return rest as T;
  const merged: Record<string, unknown> = { ...rest };
  for (const [key, part] of Object.entries(specific)) {
    // Objects (env, options) merge a level deep, as VS Code does.
    merged[key] = isObject(part) && isObject(merged[key]) ? { ...(merged[key] as object), ...part } : part;
  }
  return merged as T;
}

/** The default build task's label (`${defaultBuildTask}`). */
export function defaultBuildTask(tasks: TaskDefinition[]): string | null {
  const isBuild = (task: TaskDefinition) => task.group === "build" || (isObject(task.group) && task.group.kind === "build");
  const preferred = tasks.find((task) => isBuild(task) && isObject(task.group) && task.group.isDefault);
  return (preferred ?? tasks.find(isBuild))?.label ?? null;
}

/** POSIX shell quoting for task arguments. */
export function quoteArgument(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command line a shell/process/npm task runs. */
export function taskCommandLine(task: TaskDefinition): string {
  if (task.type === "npm") {
    const script = task.script ?? task.label.replace(/^npm:\s*/, "");
    return `npm run ${quoteArgument(script)}`;
  }
  if (!task.command) return "";
  const args = (task.args ?? []).map((arg) => {
    const value = typeof arg === "string" ? arg : arg.value;
    const quoting = typeof arg === "string" ? undefined : arg.quoting;
    // Shell tasks pass arguments as written (VS Code quotes only those
    // with spaces); process tasks run without a shell, so quote everything.
    if (quoting === "weak") return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
    if (quoting === "strong" || task.type === "process" || /\s/.test(value)) return quoteArgument(value);
    return value;
  });
  const command = task.type === "process" ? quoteArgument(task.command) : task.command;
  return [command, ...args].join(" ");
}

/** A task with what it depends on, run first (`dependsOn`). */
export interface TaskPlan {
  task: TaskDefinition;
  dependencies: TaskPlan[];
  /** Run dependencies one after another, not together. */
  sequence: boolean;
}

/** Resolve a task and its dependencies. `lookup` finds tasks not in
 *  tasks.json (detected ones like "npm: build"). */
export function planTask(
  label: string,
  tasks: TaskDefinition[],
  lookup: (label: string) => TaskDefinition | null = () => null,
  chain: string[] = [],
): TaskPlan {
  if (chain.includes(label)) throw new Error(`Task “${label}” depends on itself (${[...chain, label].join(" → ")})`);
  const task = tasks.find((candidate) => candidate.label === label) ?? lookup(label);
  if (!task) throw new Error(`Could not find the task “${label}” (in .vscode/tasks.json)`);
  const names = task.dependsOn === undefined ? [] : Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn];
  return {
    task,
    sequence: task.dependsOrder === "sequence",
    dependencies: names.map((name) => planTask(name, tasks, lookup, [...chain, label])),
  };
}

// --- Running tasks (the pure parts; terminals: launchTasks.ts) ----------------

/** A task that exited non-zero (or couldn't start). */
export class TaskFailed extends Error {
  constructor(
    readonly label: string,
    readonly exitCode: number | null,
    detail?: string,
  ) {
    super(
      detail ??
        (exitCode === null
          ? `The task “${label}” ended without reporting an exit code`
          : `The task “${label}” failed (exit code ${exitCode})`),
    );
  }
}

/** Run a plan: dependencies (together, or in order with
 *  `dependsOrder: "sequence"`), then the task. `run` resolves to an exit
 *  code. */
export async function runTaskPlan(plan: TaskPlan, run: (task: TaskDefinition) => Promise<number | null>): Promise<void> {
  if (plan.sequence) {
    for (const dependency of plan.dependencies) await runTaskPlan(dependency, run);
  } else {
    await Promise.all(plan.dependencies.map((dependency) => runTaskPlan(dependency, run)));
  }
  // A task that only groups others has no command of its own.
  if (!plan.task.command && plan.task.type !== "npm") return;
  const code = await run(plan.task);
  if (code !== 0) throw new TaskFailed(plan.task.label, code);
}

/** OSC 7770, which terminals ignore: `ESC ] 7770 ; sable-exit ; <code> BEL`. */
const EXIT_PATTERN = /\x1b\]7770;sable-exit;(\d+)\x07/;

/** The shell command that runs `commandLine` and reports its exit status. */
export function withExitReport(commandLine: string): string {
  return `(\n${commandLine}\n)\n__sable_status=$?\nprintf '\\033]7770;sable-exit;%d\\007' "$__sable_status"\nexit $__sable_status`;
}

/** Find the exit status in terminal output (null: not there). */
export function exitStatusIn(output: string): number | null {
  const match = EXIT_PATTERN.exec(output);
  return match ? Number(match[1]) : null;
}


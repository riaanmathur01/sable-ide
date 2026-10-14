import { invoke } from "../backend";
import { createDirectory, pathExists, readDirectory, readFile, writeFile } from "../ipc";
import { getEditor, getModelValue, pathFromUri, replaceModelContent, revealPosition } from "../editorRegistry";
import { parseEnv } from "../runConfig";
import { sendRequest, pathToUri } from "../lsp/lspClient";
import { useDebugStore } from "../../store/debugStore";
import { sourceBreakpoints, useBreakpointsStore } from "../../store/breakpointsStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useInterpreterStore } from "../../store/interpreterStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useTasksStore } from "../../store/tasksStore";
import { AUTO_FILE_KEY, joinPath, launchHooks, useLaunchStore, watchLaunchFiles, type LaunchSession } from "../../store/launchStore";
import {
  compoundMembers,
  defaultBuildTask,
  folderBasename,
  planTask,
  withPlatform,
  type LaunchConfig,
  type LaunchEntry,
  type LaunchInput,
  type LaunchSource,
  type Platform,
  type TaskDefinition,
} from "./launchJson";
import { LaunchCancelled, substitute, VariableError, type VariableContext } from "./launchVariables";
import { toLaunchRequest, type ResolvedLaunch } from "./launchRequest";
import { runTaskInTerminal, runTaskPlan } from "./launchTasks";
import { JAVA_DEBUG_MISSING } from "./javaLaunch";
import { DEBUGGER_TEMPLATES, insertConfiguration, newLaunchJson, rankDebuggers, type LaunchSnippet } from "./launchTemplates";
import { registerLaunchSchemas } from "./launchSchemas";
import { installSessionRouting, stopAllLaunchSessions } from "./launchSessions";

/**
 * Starting launch.json configurations, as VS Code does: substitute
 * variables (asking for inputs), run the preLaunchTask, map the type onto
 * one of Sable's adapters, and start the session (launch_config.rs).
 * Compounds start several sessions (launchSessions.ts routes them).
 */

const platform = (): Platform =>
  /windows/i.test(navigator.userAgent) ? "windows" : /mac/i.test(navigator.userAgent) ? "osx" : "linux";

let environmentCache: Promise<{ env: Record<string, string>; userHome: string; pathSeparator: string }> | null = null;
function environment() {
  environmentCache ??= invoke<{ env: Record<string, string>; userHome: string; pathSeparator: string }>("debug_config_environment").catch(() => ({
    env: {},
    userHome: "",
    pathSeparator: "/",
  }));
  return environmentCache;
}

const log = {
  info: (text: string) => useDebugStore.getState().appendConsole("console", text),
  error: (text: string) => useDebugStore.getState().appendConsole("error", text),
};

/** The folder a source's `${workspaceFolder}` means. */
const folderFor = (source: LaunchSource) => source.folder ?? useWorkspaceStore.getState().folders[0] ?? null;

/** A setting for `${config:…}`: the folder's .vscode/settings.json, the
 *  workspace file's settings, then Sable's own. */
function settingValue(source: LaunchSource, key: string): unknown {
  const { extras } = useLaunchStore.getState();
  for (const extra of [extras.find((item) => item.folder === source.folder), extras.find((item) => item.folder === null)]) {
    if (extra && key in extra.settings) return extra.settings[key];
  }
  const values = useSettingsStore.getState().values as unknown as Record<string, unknown>;
  return values[key];
}

/** Every task a source can name: its folder's tasks.json, then the
 *  workspace file's. */
function tasksFor(source: LaunchSource): TaskDefinition[] {
  const { extras } = useLaunchStore.getState();
  return [
    ...(extras.find((item) => item.folder === source.folder)?.tasks.tasks ?? []),
    ...(extras.find((item) => item.folder === null)?.tasks.tasks ?? []),
  ];
}

/** Ask for an `${input:…}` value. */
async function promptInput(input: LaunchInput): Promise<string | null> {
  const ui = useUiStore.getState();
  const description = input.description ?? input.id;
  if (input.type === "pickString") {
    const options = (input.options ?? []).map((option) =>
      typeof option === "string" ? { label: option, value: option } : { label: option.label ?? option.value, value: option.value },
    );
    // The default first, so Enter takes it.
    options.sort((a, b) => Number(b.value === input.default) - Number(a.value === input.default));
    const index = await ui.openPick(
      options.map((option) => ({ label: option.label, detail: option.label !== option.value ? option.value : undefined })),
      description,
    );
    return index === null ? null : options[index].value;
  }
  const answer = await ui.openPickOrText([], description, "%s", input.default);
  return typeof answer === "string" ? answer : null;
}

/** `${command:pickProcess}`: choose a running process. */
async function pickProcess(): Promise<string | null> {
  const processes = await invoke<{ pid: number; name: string; command: string }[]>("list_processes");
  const index = await useUiStore.getState().openPick(
    processes.map((process) => ({ label: `${process.name} (${process.pid})`, detail: process.command })),
    "Pick the process to attach to",
  );
  return index === null ? null : String(processes[index].pid);
}

/** The variables' values for a configuration from `source`. */
async function variableContext(source: LaunchSource, inputs: LaunchInput[], answers: Map<string, string>): Promise<VariableContext> {
  const { env, userHome, pathSeparator } = await environment();
  const file = useTabsStore.getState().lastFilePath;
  const editor = getEditor();
  const model = editor?.getModel();
  const editorFile = model && model.uri.scheme === "file" ? pathFromUri(model.uri) : null;
  const selection = editorFile === file ? editor?.getSelection() : null;
  return {
    workspaceFolder: folderFor(source),
    folders: useWorkspaceStore.getState().folders,
    file,
    lineNumber: editorFile === file ? (editor?.getPosition()?.lineNumber ?? null) : null,
    selectedText: selection && model ? model.getValueInRange(selection) : null,
    env,
    userHome,
    pathSeparator,
    config: (key) => settingValue(source, key),
    inputs,
    promptInput,
    pickProcess: () => pickProcess(),
    pickArgs: async () => {
      const answer = await useUiStore.getState().openPickOrText([], "Program arguments", "%s");
      return typeof answer === "string" ? answer : null;
    },
    pythonInterpreter: () => useInterpreterStore.getState().selectedPath,
    defaultBuildTask: () => defaultBuildTask(tasksFor(source)),
    answers,
  };
}

/** Run a task by label (preLaunchTask / postDebugTask) and what it depends on. */
export async function runNamedTask(label: string, source: LaunchSource, answers = new Map<string, string>()): Promise<void> {
  const tasks = tasksFor(source);
  const detected = (name: string): TaskDefinition | null => {
    // Detected tasks ("npm: build") — Sable's own task list.
    const task = useTasksStore.getState().tasks.find((candidate) => `${candidate.source}: ${candidate.label}` === name || candidate.label === name);
    return task ? { label: name, type: "shell", command: task.command } : null;
  };
  const plan = planTask(label, tasks, detected);
  const { extras } = useLaunchStore.getState();
  const inputs = [...(extras.find((item) => item.folder === source.folder)?.tasks.inputs ?? []), ...source.file.inputs];
  const context = await variableContext(source, inputs, answers);
  const folder = folderFor(source);
  log.info(`Running task “${label}”…`);
  useLaunchStore.getState().setLaunching(`Running task “${label}”…`);
  try {
    await runTaskPlan(plan, async (task) => {
      const resolved = await substitute(withPlatform(task, platform()), context);
      const cwd = resolved.options?.cwd ?? folder;
      return runTaskInTerminal({ ...resolved, options: { ...resolved.options, cwd: cwd ?? undefined } }, folder);
    });
  } finally {
    useLaunchStore.getState().setLaunching(null);
  }
  log.info(`Task “${label}” finished`);
}

/** Read the configuration's envFile (missing file: an error, like VS Code). */
async function readEnvFile(path: unknown, folder: string | null): Promise<Record<string, string> | null> {
  if (typeof path !== "string" || !path) return null;
  const full = /^([A-Za-z]:[/\\]|[/\\])/.test(path) || !folder ? path : joinPath(folder, path);
  const text = await readFile(full).catch(() => {
    throw new Error(`envFile “${full}” doesn't exist`);
  });
  return parseEnv(text);
}

/** Java: jdtls resolves the main class and classpath and starts java-debug. */
async function resolveJava(resolved: ResolvedLaunch, folder: string | null): Promise<ResolvedLaunch> {
  if (!(await invoke<boolean>("java_debug_installed"))) throw new Error(JAVA_DEBUG_MISSING);
  const execute = (command: string, args: unknown[]) => sendRequest("java", "workspace/executeCommand", { command, arguments: args }, 15_000);
  const request = { ...resolved.request };
  let port: unknown = null;
  for (let attempt = 0; attempt < 30 && typeof port !== "number"; attempt++) {
    if (request.request === "launch") {
      const mainClass = String(request.mainClass);
      if (/[/\\]|\.java$/.test(mainClass)) {
        // A file: its main class, via jdtls.
        const candidates = (await execute("vscode.java.resolveMainClass", [folder ? pathToUri(folder) : null])) as
          | { mainClass: string; projectName: string; filePath?: string }[]
          | null;
        const match = candidates?.find((candidate) => candidate.filePath === mainClass) ?? null;
        if (!match) {
          if (attempt === 0) log.info("Waiting for the Java language server…");
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        request.mainClass = match.mainClass;
        request.projectName ??= match.projectName;
      }
      if (!request.classPaths && !request.modulePaths) {
        const classpath = await execute("vscode.java.resolveClasspath", [request.mainClass, request.projectName ?? ""]);
        if (Array.isArray(classpath)) {
          request.modulePaths = classpath[0] ?? [];
          request.classPaths = classpath[1] ?? [];
        }
      }
      if (!request.javaExec) {
        const javaExec = await execute("vscode.java.resolveJavaExecutable", [request.mainClass, request.projectName ?? ""]);
        if (typeof javaExec === "string") request.javaExec = javaExec;
      }
    }
    port = await execute("vscode.java.startDebugSession", []);
    if (typeof port !== "number") {
      if (attempt === 0) log.info("Waiting for the Java language server…");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (typeof port !== "number") throw new Error("The Java language server (jdtls) didn't start the debugger — open a Java file and try again");
  return { ...resolved, request, adapter: { ...resolved.adapter, port } };
}

let sessionCounter = 0;

/** Substitute, map and check a configuration without starting it (also
 *  what the tests inspect). Runs no tasks. */
export async function resolveConfiguration(
  config: LaunchConfig,
  source: LaunchSource,
  answers = new Map<string, string>(),
): Promise<{ resolved: ResolvedLaunch; substituted: Record<string, unknown> }> {
  const context = await variableContext(source, source.file.inputs, answers);
  const substituted = await substitute(withPlatform(config as Record<string, unknown>, platform()), context);
  const folder = folderFor(source);
  const envFile = await readEnvFile(substituted.envFile, folder);
  const resolved = toLaunchRequest(substituted, {
    workspaceFolder: folder,
    python: useInterpreterStore.getState().selectedPath,
    envFile,
  });
  return { resolved, substituted };
}

/** Start one configuration (in the background: alongside the focused session). */
async function launchOne(config: LaunchConfig, source: LaunchSource, background: boolean, relaunch: () => Promise<void>): Promise<boolean> {
  const debug = useDebugStore.getState();
  // Unique across reloads and windows: late events from an old session never match.
  const id = `${config.name}#${Date.now().toString(36)}-${++sessionCounter}`;
  const label = useWorkspaceStore.getState().folders.length > 1 && source.folder ? `${config.name} (${folderBasename(source.folder)})` : config.name;
  const answers = new Map<string, string>();
  try {
    const { resolved: mapped, substituted } = await resolveConfiguration(config, source, answers);
    if (typeof substituted.preLaunchTask === "string" && substituted.preLaunchTask) {
      await runNamedTask(substituted.preLaunchTask, source, answers);
    }
    for (const required of mapped.requiredPaths) {
      if (!(await pathExists(required.path).catch(() => true))) {
        throw new Error(`Configuration “${config.name}”: the ${required.what} “${required.path}” doesn't exist`);
      }
    }
    let resolved = mapped;
    if (resolved.needsJdtls) resolved = await resolveJava(resolved, folderFor(source));
    const program = typeof resolved.request.program === "string" ? resolved.request.program : null;
    const session: LaunchSession = {
      id,
      name: label,
      state: "running",
      threadId: null,
      reason: null,
      postDebugTask: typeof substituted.postDebugTask === "string" ? substituted.postDebugTask : undefined,
      source,
    };
    useLaunchStore.setState((state) => ({
      sessions: [...state.sessions, session],
      focusedSession: background ? state.focusedSession : id,
    }));
    if (!background) {
      useDebugStore.setState({
        isDebugging: true,
        isPaused: false,
        stoppedThreadId: null,
        stopReason: null,
        stoppedFile: null,
        stoppedLine: null,
        frames: [],
        selectedFrameId: null,
        scopes: [],
        lastProgram: program,
        missingTool: null,
        relaunch,
      });
    }
    log.info(`Starting “${label}” (${resolved.request.type} ${resolved.request.request})`);
    const breakpoints = Object.fromEntries(
      Object.keys(useBreakpointsStore.getState().breakpointsByFile).map((file) => [file, sourceBreakpoints(file)]),
    );
    await invoke("debug_config_start", { session: id, adapter: resolved.adapter, launch: resolved.request, breakpoints, background });
    return true;
  } catch (error) {
    if (error instanceof VariableError) error = new Error(`Configuration “${config.name}”: ${error.message}`);
    const wasFocused = useLaunchStore.getState().focusedSession === id;
    useLaunchStore.setState((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      focusedSession: wasFocused ? null : state.focusedSession,
    }));
    useUiStore.getState().setBottomPanel("debug");
    if (error instanceof LaunchCancelled) {
      log.info(`“${label}”: launch cancelled`);
      useUiStore.getState().showStatus("Debugging cancelled");
      if (!background && wasFocused) useDebugStore.setState({ isDebugging: false });
      return false;
    }
    if (background) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`“${label}”: ${message}`);
      useUiStore.getState().setLastError(message);
    } else {
      // Sets isDebugging false; offers a missing debugger's install.
      useDebugStore.setState({ relaunch });
      debug.reportError(error instanceof Error ? error.message : error);
    }
    return false;
  }
}

/** Start a launch.json configuration or compound. */
export async function startEntry(entry: LaunchEntry): Promise<void> {
  const store = useLaunchStore.getState();
  if (store.launching) {
    useUiStore.getState().showStatus(store.launching);
    return;
  }
  await stopAllLaunchSessions();
  if (useDebugStore.getState().isDebugging) await useDebugStore.getState().stop();
  const relaunch = () => {
    const latest = useLaunchStore.getState().entries.find((candidate) => candidate.key === entry.key);
    return latest ? startEntry(latest) : Promise.resolve();
  };
  const debug = useDebugStore.getState();
  debug.clearConsole();
  useUiStore.getState().setBottomPanel("debug");
  useLaunchStore.setState({ launching: `Starting “${entry.label}”…`, compound: null });
  try {
    if (entry.kind === "config") {
      await launchOne(entry.config, entry.source, false, relaunch);
      return;
    }
    const { compound, source } = entry;
    let members: { config: LaunchConfig; source: LaunchSource }[];
    try {
      members = compoundMembers(compound, source, useLaunchStore.getState().sources);
      if (members.length === 0) throw new Error(`Compound “${compound.name}” has no configurations`);
      useLaunchStore.getState().setLaunching(null);
      if (compound.preLaunchTask) await runNamedTask(compound.preLaunchTask, source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(message);
      useUiStore.getState().setLastError(message);
      useUiStore.getState().setBottomPanel("debug");
      return;
    }
    useLaunchStore.setState({ compound: { name: compound.name, stopAll: compound.stopAll === true } });
    log.info(`Starting compound “${compound.name}”: ${members.map((member) => member.config.name).join(", ")}`);
    let focused = false;
    for (const member of members) {
      // The first that starts is focused; the rest run alongside it.
      if (await launchOne(member.config, member.source, focused, relaunch)) focused = true;
    }
  } finally {
    useLaunchStore.getState().setLaunching(null);
  }
}

/** F5 / ▶: the selected launch.json configuration, else (no launch.json,
 *  or "Current File" selected) Sable's own current-file debugging. */
export async function startDebugging(): Promise<void> {
  const debug = useDebugStore.getState();
  if (debug.isDebugging) return debug.start(); // continue when paused
  const entry = useLaunchStore.getState().selectedEntry();
  if (!entry) return debug.start();
  return startEntry(entry);
}

/** Debug: Select and Start Debugging. */
export async function selectAndStart(): Promise<void> {
  const { entries } = useLaunchStore.getState();
  const file = useTabsStore.getState().lastFilePath;
  const items = [
    ...entries.map((entry) => ({ label: entry.label, detail: entry.kind === "compound" ? "compound" : `${entry.config.type} · ${entry.config.request}` })),
    { label: "Current File", detail: file ? `Sable · ${file.split(/[/\\]/).pop()}` : "Sable" },
    { label: "Add Configuration…", detail: "launch.json" },
  ];
  const index = await useUiStore.getState().openPick(items, "Select a configuration to debug");
  if (index === null) return;
  if (index === entries.length + 1) return addConfiguration();
  if (index === entries.length) {
    useLaunchStore.getState().select(AUTO_FILE_KEY);
    return useDebugStore.getState().start();
  }
  useLaunchStore.getState().select(entries[index].key);
  return startEntry(entries[index]);
}

/** Which folder's launch.json to open or edit (asks in a multi-root workspace). */
async function chooseFolder(): Promise<string | null> {
  const { folders } = useWorkspaceStore.getState();
  if (folders.length <= 1) return folders[0] ?? null;
  const index = await useUiStore.getState().openPick(
    folders.map((folder) => ({ label: folderBasename(folder), detail: folder })),
    "Which folder's launch.json?",
  );
  return index === null ? null : folders[index];
}

/** Ask which debugger (VS Code's "Select debugger"), likeliest first. */
async function chooseSnippet(folder: string, allSnippets: boolean): Promise<LaunchSnippet | null> {
  const files = await readDirectory(folder)
    .then((entries) => entries.map((entry) => entry.name))
    .catch(() => [] as string[]);
  const ranked = rankDebuggers(files, useTabsStore.getState().lastFilePath);
  const ui = useUiStore.getState();
  if (!allSnippets) {
    const index = await ui.openPick(
      ranked.map((template) => ({ label: template.label, detail: template.snippets[0].label })),
      "Select debugger",
    );
    return index === null ? null : ranked[index].snippets[0];
  }
  const snippets = ranked.flatMap((template) => template.snippets);
  const index = await ui.openPick(
    snippets.map((snippet) => ({ label: snippet.label, detail: snippet.description })),
    "Add a configuration",
  );
  return index === null ? null : snippets[index];
}

/** The gear: open launch.json, creating it from a template if missing. */
export async function openLaunchJson(folderOverride?: string): Promise<void> {
  const folder = folderOverride ?? (await chooseFolder());
  if (!folder) {
    useUiStore.getState().setLastError("Open a folder to create a launch.json");
    return;
  }
  const path = joinPath(folder, ".vscode", "launch.json");
  if (!(await pathExists(path).catch(() => false))) {
    const snippet = await chooseSnippet(folder, false);
    if (!snippet) return;
    await createDirectory(joinPath(folder, ".vscode")).catch(() => {});
    await writeFile(path, newLaunchJson([snippet.config]));
    await useLaunchStore.getState().load();
    useUiStore.getState().showStatus("Created .vscode/launch.json");
  }
  await useTabsStore.getState().openFile(path);
}

/** Add Configuration…: a snippet at the end of `configurations`. */
export async function addConfiguration(): Promise<void> {
  const folder = await chooseFolder();
  if (!folder) {
    useUiStore.getState().setLastError("Open a folder to add a launch configuration");
    return;
  }
  const snippet = await chooseSnippet(folder, true);
  if (!snippet) return;
  const path = joinPath(folder, ".vscode", "launch.json");
  const tabs = useTabsStore.getState();
  // Edit the open editor's text when there is one (unsaved changes stay).
  let text = getModelValue(path);
  if (text === null) text = await readFile(path).catch(() => "");
  let updated: { text: string; line: number };
  try {
    updated = insertConfiguration(text, snippet.config);
  } catch (error) {
    useUiStore.getState().setLastError(String(error instanceof Error ? error.message : error));
    return;
  }
  if (getModelValue(path) !== null && replaceModelContent(path, updated.text)) {
    await tabs.openFile(path);
  } else {
    await createDirectory(joinPath(folder, ".vscode")).catch(() => {});
    await writeFile(path, updated.text);
    await tabs.openFile(path);
    await useLaunchStore.getState().load();
  }
  setTimeout(() => revealPosition(path, updated.line), 50);
  useUiStore.getState().showStatus(`Added “${snippet.config.name as string}” to launch.json`);
}

export { DEBUGGER_TEMPLATES };

// Problems in launch.json / tasks.json go to the debug console and the status bar.
launchHooks.reportProblems = (problems) => {
  for (const problem of problems) log.error(problem);
  useUiStore.getState().setLastError(problems[0] + (problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""));
};

installSessionRouting();
registerLaunchSchemas();
watchLaunchFiles();

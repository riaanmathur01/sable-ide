import { useTabsStore } from "../store/tabsStore";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { useInterpreterStore } from "../store/interpreterStore";
import { useRunConfigStore } from "../store/runConfigStore";
import { commandLineFor, isEmptyConfig } from "./runConfig";

/**
 * "Run" (▶ button / Cmd+R): force-save the active file, open the
 * terminal, and execute it with an interpreter picked by extension. For
 * Python, the interpreter is the user's selection (see interpreterStore).
 */

/** The Python command uses the selected interpreter, falling back to python3. */
function pythonCommand(path: string): string {
  const selected = useInterpreterStore.getState().selectedPath;
  const interpreter = selected ?? "python3";
  return `"${interpreter}" "${path}"`;
}

const RUNNERS_BY_EXTENSION: Record<string, (path: string) => string> = {
  py: pythonCommand,
  pyi: pythonCommand,
  js: (path) => `node "${path}"`,
  mjs: (path) => `node "${path}"`,
  cjs: (path) => `node "${path}"`,
  // Node 22.18+ / 24 strips TypeScript types natively.
  ts: (path) => `node "${path}"`,
  sh: (path) => `bash "${path}"`,
  zsh: (path) => `zsh "${path}"`,
  bash: (path) => `bash "${path}"`,
  ps1: (path) => `powershell -File "${path}"`,
  rb: (path) => `ruby "${path}"`,
  php: (path) => `php "${path}"`,
  lua: (path) => `lua "${path}"`,
  go: (path) => `go run "${path}"`,
  // Runs in the terminal's cwd (the workspace root), so this works for
  // Cargo projects rather than single .rs files. `--` passes arguments
  // to the program rather than to Cargo.
  rs: () => "cargo run --",
};

/** The file Run acts on: the active file, or the last real file when a
 *  settings/diff tab is active. */
export function runnableFile(): string | null {
  const { activePath, lastFilePath, tabs } = useTabsStore.getState();
  const activeTab = tabs.find((tab) => tab.path === activePath);
  return activeTab && activeTab.kind !== "file" ? lastFilePath : activePath;
}

export async function runActiveFile(): Promise<void> {
  const filePath = runnableFile();
  if (!filePath) {
    useUiStore.getState().setLastError("No file to run — open one first");
    return;
  }
  await runFile(filePath);
}

/** Run a file in the terminal, with its run configuration (arguments,
 *  environment, working directory). */
export async function runFile(filePath: string): Promise<void> {
  const { saveTab } = useTabsStore.getState();
  const { setLastError, setBottomPanel } = useUiStore.getState();

  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  const buildCommand = RUNNERS_BY_EXTENSION[extension];
  if (!buildCommand) {
    setLastError(`Don't know how to run .${extension} files`);
    return;
  }

  await saveTab(filePath); // run what's on screen, not a stale file
  setBottomPanel("terminal");
  // Queue the command; the terminal view runs it once mounted and
  // listening (the panel lazy-loads, so it may not exist yet).
  const config = useRunConfigStore.getState().configFor(filePath);
  const base = buildCommand(filePath);
  useTerminalStore
    .getState()
    .enqueueCommand(isEmptyConfig(config) ? base.replace(/ --$/, "") : commandLineFor(base, config));
}

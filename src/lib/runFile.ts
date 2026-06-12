import { useTabsStore } from "../store/tabsStore";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";

/**
 * "Run" (▶ button / Cmd+R): force-save the active file, open the
 * terminal, and execute it with an interpreter picked by extension.
 */

const RUNNERS_BY_EXTENSION: Record<string, (path: string) => string> = {
  py: (path) => `python3 "${path}"`,
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
  // Cargo projects rather than single .rs files.
  rs: () => "cargo run",
};

export async function runActiveFile(): Promise<void> {
  const { activePath, saveTab } = useTabsStore.getState();
  const { setLastError, setTerminalVisible } = useUiStore.getState();

  if (!activePath) {
    setLastError("No file to run — open one first");
    return;
  }

  const extension = activePath.split(".").pop()?.toLowerCase() ?? "";
  const buildCommand = RUNNERS_BY_EXTENSION[extension];
  if (!buildCommand) {
    setLastError(`Don't know how to run .${extension} files`);
    return;
  }

  await saveTab(activePath); // run what's on screen, not a stale file
  setTerminalVisible(true);
  await useTerminalStore.getState().sendCommandLine(buildCommand(activePath));
}

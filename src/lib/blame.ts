import { gitBlame } from "./ipc";
import { setBlame, clearBlame } from "./editorRegistry";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useUiStore } from "../store/uiStore";

/**
 * Fetch git blame for a file and render it as per-line annotations.
 * Surfaces a clear status when there's nothing to show (not a repo, or
 * the file isn't committed) instead of silently doing nothing.
 */
export async function refreshBlame(filePath: string): Promise<void> {
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) {
    clearBlame();
    return;
  }
  try {
    const lines = await gitBlame(root, filePath);
    if (lines.length === 0) {
      clearBlame();
      useUiStore
        .getState()
        .setLastError(
          "No git blame for this file (not committed, or not a Git repo).",
        );
      return;
    }
    setBlame(filePath, lines);
  } catch (error) {
    clearBlame();
    useUiStore.getState().setLastError(`Blame failed: ${String(error)}`);
  }
}

export { clearBlame };

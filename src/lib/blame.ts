import { gitBlame } from "./ipc";
import { setBlame, clearBlame } from "./editorRegistry";
import { useWorkspaceStore } from "../store/workspaceStore";

/**
 * Fetch git blame for a file and render it as per-line annotations.
 * Clears if there's nothing to show (new/untracked file).
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
      return;
    }
    setBlame(filePath, lines);
  } catch {
    clearBlame();
  }
}

export { clearBlame };

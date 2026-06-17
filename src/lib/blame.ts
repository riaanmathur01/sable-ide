import { gitBlame, type BlameLine } from "./ipc";
import { useWorkspaceStore } from "../store/workspaceStore";

/**
 * Fetch git blame for a file. Returns one entry per committed line, or an
 * empty array for a new/untracked file, a non-repo folder, or any error.
 */
export async function fetchBlame(filePath: string): Promise<BlameLine[]> {
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) return [];
  try {
    return await gitBlame(root, filePath);
  } catch {
    return [];
  }
}

import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../store/workspaceStore";

/**
 * Prompt for a folder and open it as the workspace. Works whether or not
 * a folder is already open — openWorkspace resets the prior workspace's
 * state, so this cleanly switches folders.
 */
export async function openFolderDialog(): Promise<void> {
  const selected = await openNativeDialog({
    directory: true,
    title: "Open Folder",
  });
  if (typeof selected === "string") {
    await useWorkspaceStore.getState().openWorkspace(selected);
  }
}

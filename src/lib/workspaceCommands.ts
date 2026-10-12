import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { isRemoteActive } from "./backend";
import { openNewWindow } from "./windows";
import { folderName, useWorkspaceStore } from "../store/workspaceStore";
import { useRemoteStore } from "../store/remoteStore";
import { useUiStore } from "../store/uiStore";

/**
 * Windows and multi-root workspaces, for the command palette, shortcuts
 * and the Explorer.
 */

/** File: New Window (⇧⌘N): an empty window. */
export function newWindow(): Promise<void> {
  return openNewWindow();
}

/** File: Close Window (⇧⌘W). */
export async function closeWindow(): Promise<void> {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().close();
}

/** Choose a folder (here) and open it in a new window. */
export async function openFolderInNewWindow(path?: string): Promise<void> {
  const folder =
    path ?? (await openDialog({ directory: true, title: "Open Folder in New Window" }).then((chosen) => (typeof chosen === "string" ? chosen : null)));
  if (folder) await openNewWindow({ folders: [folder] });
}

/** Workspaces: Add Folder to Workspace… */
export async function addFolderToWorkspace(): Promise<void> {
  if (isRemoteActive()) {
    await useRemoteStore.getState().openFolder({ add: true });
    return;
  }
  const chosen = await openDialog({ directory: true, multiple: true, title: "Add Folder to Workspace" });
  const folders = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
  for (const folder of folders) await useWorkspaceStore.getState().addFolder(folder);
}

/** Workspaces: Remove Folder from Workspace… */
export async function removeFolderFromWorkspace(path?: string): Promise<void> {
  const { folders, removeFolder } = useWorkspaceStore.getState();
  if (folders.length < 2) {
    useUiStore.getState().showStatus("The workspace has one folder — close it instead (or open another)");
    return;
  }
  let folder = path;
  if (!folder) {
    const choice = await useUiStore.getState().openPick(
      folders.map((candidate) => ({ label: folderName(candidate), detail: candidate })),
      "Remove a folder from the workspace",
    );
    if (choice === null) return;
    folder = folders[choice];
  }
  await removeFolder(folder);
}

/** File: Open Workspace from File… (.code-workspace) */
export async function openWorkspaceFromFile(): Promise<void> {
  const chosen = await openDialog({ title: "Open Workspace from File", filters: [{ name: "Workspace", extensions: ["code-workspace"] }] });
  if (typeof chosen === "string") await useWorkspaceStore.getState().openWorkspaceFile(chosen);
}

/** File: Save Workspace As… */
export async function saveWorkspaceAs(): Promise<void> {
  const { folders, rootPath, workspaceFile } = useWorkspaceStore.getState();
  if (!folders.length) {
    useUiStore.getState().showStatus("Open a folder first");
    return;
  }
  const defaultPath = workspaceFile ?? `${rootPath}/../${folderName(rootPath ?? "workspace")}.code-workspace`;
  const file = await saveDialog({ title: "Save Workspace As", defaultPath, filters: [{ name: "Workspace", extensions: ["code-workspace"] }] });
  if (file) await useWorkspaceStore.getState().saveWorkspaceAs(file.endsWith(".code-workspace") ? file : `${file}.code-workspace`);
}

import { open as openNativeDialog, save as saveNativeDialog } from "@tauri-apps/plugin-dialog";
import { invoke, invokeLocal } from "./backend";
import type { FsEntry } from "./ipc";
import { useUiStore } from "../store/uiStore";
import { useWorkspaceStore } from "../store/workspaceStore";

/**
 * Copying files between this computer and a remote workspace: drop files
 * on a remote window (or Upload Files Here…) to upload them, Download…
 * in the explorer to bring a remote file or folder here. Bytes travel as
 * base64 through the backend (`invokeLocal` here, `invoke` → the agent).
 */

/** Most files copied at once (a folder of thousands is a mistake). */
const MAX_FILES = 2000;
const SKIPPED = new Set([".git", "node_modules", ".DS_Store"]);

const baseName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;
const joinPath = (dir: string, name: string) => `${dir.replace(/[/\\]+$/, "")}/${name}`;

/** Every file under `path` (or `path` itself), with paths relative to its parent. */
async function walk(
  path: string,
  list: (dir: string) => Promise<FsEntry[]>,
  isDirectory: (path: string) => Promise<boolean>,
): Promise<{ path: string; relative: string }[]> {
  const files: { path: string; relative: string }[] = [];
  const visit = async (current: string, relative: string) => {
    if (files.length >= MAX_FILES) throw new Error(`That's more than ${MAX_FILES} files — copy fewer at a time`);
    if (!(await isDirectory(current))) {
      files.push({ path: current, relative });
      return;
    }
    for (const entry of await list(current)) {
      if (!SKIPPED.has(entry.name)) await visit(entry.path, `${relative}/${entry.name}`);
    }
  };
  await visit(path, baseName(path));
  return files;
}

/** Upload local files/folders into `remoteDir`. Returns how many files. */
export async function uploadToRemote(localPaths: string[], remoteDir: string): Promise<number> {
  const ui = useUiStore.getState();
  let copied = 0;
  try {
    for (const local of localPaths) {
      const files = await walk(
        local,
        (dir) => invokeLocal<FsEntry[]>("read_directory", { path: dir }),
        (path) => invokeLocal<boolean>("is_directory", { path }),
      );
      for (const file of files) {
        ui.showStatus(`Uploading ${file.relative}…`);
        const data = await invokeLocal<string>("read_file_base64", { path: file.path });
        await invoke("write_file_base64", { path: joinPath(remoteDir, file.relative), data });
        copied += 1;
      }
    }
    ui.showStatus(`Uploaded ${copied} file${copied === 1 ? "" : "s"} to ${remoteDir}`);
  } catch (error) {
    ui.setLastError(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await useWorkspaceStore.getState().refreshDirectory(remoteDir);
  return copied;
}

/** Choose local files and upload them into `remoteDir`. */
export async function chooseAndUpload(remoteDir: string): Promise<void> {
  const chosen = await openNativeDialog({ multiple: true, title: "Upload Files" });
  const paths = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
  if (paths.length) await uploadToRemote(paths, remoteDir);
}

/** Download a remote file or folder to a place chosen here. */
export async function downloadFromRemote(entry: FsEntry): Promise<void> {
  const ui = useUiStore.getState();
  try {
    if (!entry.isDirectory) {
      const target = await saveNativeDialog({ title: "Download", defaultPath: entry.name });
      if (!target) return;
      ui.showStatus(`Downloading ${entry.name}…`);
      const data = await invoke<string>("read_file_base64", { path: entry.path });
      await invokeLocal("write_file_base64", { path: target, data });
      ui.showStatus(`Downloaded ${entry.name} to ${target}`);
      return;
    }
    const folder = await openNativeDialog({ directory: true, title: `Download ${entry.name} into…` });
    if (typeof folder !== "string") return;
    const files = await walk(
      entry.path,
      (dir) => invoke<FsEntry[]>("read_directory", { path: dir }),
      (path) => invoke<boolean>("is_directory", { path }),
    );
    for (const file of files) {
      ui.showStatus(`Downloading ${file.relative}…`);
      const data = await invoke<string>("read_file_base64", { path: file.path });
      await invokeLocal("write_file_base64", { path: joinPath(folder, file.relative), data });
    }
    ui.showStatus(`Downloaded ${files.length} file${files.length === 1 ? "" : "s"} to ${joinPath(folder, entry.name)}`);
  } catch (error) {
    ui.setLastError(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

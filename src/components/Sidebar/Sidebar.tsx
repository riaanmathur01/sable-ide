import { useState } from "react";
import { FilePlus, FolderOpen, FolderPlus } from "lucide-react";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { createDirectory, createFile } from "../../lib/ipc";
import { FileTree } from "./FileTree";
import "./Sidebar.css";

type PendingCreate = "file" | "folder" | null;

/**
 * File explorer sidebar: open-folder entry point, New File / New Folder
 * actions, and the virtualized tree.
 */
export function Sidebar() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const rootName = useWorkspaceStore((state) => state.rootName);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const refreshDirectory = useWorkspaceStore((state) => state.refreshDirectory);
  const setLastError = useUiStore((state) => state.setLastError);

  const [pendingCreate, setPendingCreate] = useState<PendingCreate>(null);
  const [pendingName, setPendingName] = useState("");

  async function pickFolder() {
    const selectedPath = await openNativeDialog({
      directory: true,
      title: "Open Folder",
    });
    if (typeof selectedPath === "string") {
      await openWorkspace(selectedPath);
    }
  }

  async function confirmCreate() {
    const name = pendingName.trim();
    if (!rootPath || !name || !pendingCreate) {
      cancelCreate();
      return;
    }
    // Forward slash works on Windows too; Rust normalizes on its side.
    const newPath = `${rootPath}/${name}`;
    try {
      if (pendingCreate === "file") {
        await createFile(newPath);
      } else {
        await createDirectory(newPath);
      }
      await refreshDirectory(rootPath);
    } catch (error) {
      setLastError(String(error));
    }
    cancelCreate();
  }

  function cancelCreate() {
    setPendingCreate(null);
    setPendingName("");
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">{rootName ?? "Explorer"}</span>
        {rootPath && (
          <span className="sidebar-actions">
            <button
              className="icon-button"
              title="New File"
              onClick={() => setPendingCreate("file")}
            >
              <FilePlus size={15} strokeWidth={1.5} />
            </button>
            <button
              className="icon-button"
              title="New Folder"
              onClick={() => setPendingCreate("folder")}
            >
              <FolderPlus size={15} strokeWidth={1.5} />
            </button>
          </span>
        )}
      </div>

      {pendingCreate && (
        <input
          className="sidebar-create-input"
          autoFocus
          placeholder={pendingCreate === "file" ? "file name" : "folder name"}
          value={pendingName}
          onChange={(event) => setPendingName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") confirmCreate();
            if (event.key === "Escape") cancelCreate();
          }}
          onBlur={cancelCreate}
        />
      )}

      {rootPath ? (
        <FileTree />
      ) : (
        <div className="sidebar-empty">
          <FolderOpen size={28} strokeWidth={1.25} aria-hidden />
          <p>No folder opened</p>
          <button className="sidebar-open-button" onClick={pickFolder}>
            Open Folder
          </button>
          <p className="sidebar-empty-hint">or drag a folder into the window</p>
        </div>
      )}
    </aside>
  );
}

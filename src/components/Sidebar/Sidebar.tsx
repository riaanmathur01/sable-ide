import { useState } from "react";
import {
  Bug,
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  Puzzle,
  Search,
} from "lucide-react";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useGitStore } from "../../store/gitStore";
import { createDirectory, createFile } from "../../lib/ipc";
import { openFolderDialog } from "../../lib/openFolder";
import { FileTree } from "./FileTree";
import { TasksSection } from "./TasksSection";
import { SearchPanel } from "./SearchPanel";
import { SourceControlPanel } from "./SourceControlPanel";
import { HistoryPanel } from "./HistoryPanel";
import { DebugPanel } from "../Debug/DebugPanel";
import { PluginsPanel } from "../Plugins/PluginsPanel";
import "./Sidebar.css";

type PendingCreate = "file" | "folder" | null;

/**
 * File explorer sidebar: open-folder entry point, New File / New Folder
 * actions, and the virtualized tree.
 */
export function Sidebar() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const rootName = useWorkspaceStore((state) => state.rootName);
  const refreshDirectory = useWorkspaceStore((state) => state.refreshDirectory);
  const setLastError = useUiStore((state) => state.setLastError);
  const sidebarView = useUiStore((state) => state.sidebarView);
  const setSidebarView = useUiStore((state) => state.setSidebarView);
  const width = useUiStore((state) => state.panelSizes.sidebarWidth);
  const changeCount = useGitStore(
    (state) => Object.keys(state.statusByPath).length,
  );

  const [pendingCreate, setPendingCreate] = useState<PendingCreate>(null);
  const [pendingName, setPendingName] = useState("");

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
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">
          {sidebarView === "search"
            ? "Search"
            : sidebarView === "git"
              ? "Source Control"
              : sidebarView === "history"
                ? "History"
                : sidebarView === "debug"
                  ? "Run and Debug"
                  : sidebarView === "plugins"
                    ? "Plugins"
                    : (rootName ?? "Explorer")}
        </span>
        <span className="sidebar-actions">
          <button
            className={
              sidebarView === "files" ? "icon-button active" : "icon-button"
            }
            title="Explorer"
            onClick={() => setSidebarView("files")}
          >
            <Files size={15} strokeWidth={1.5} />
          </button>
          <button
            className={
              sidebarView === "search" ? "icon-button active" : "icon-button"
            }
            title="Search (⇧⌘F)"
            onClick={() => setSidebarView("search")}
          >
            <Search size={15} strokeWidth={1.5} />
          </button>
          <button
            className={
              sidebarView === "git" ? "icon-button active" : "icon-button"
            }
            title="Source Control (⇧⌘G)"
            onClick={() => setSidebarView("git")}
          >
            <GitBranch size={15} strokeWidth={1.5} />
            {changeCount > 0 && (
              <span className="sidebar-change-count">{changeCount}</span>
            )}
          </button>
          <button
            className={
              sidebarView === "history" ? "icon-button active" : "icon-button"
            }
            title="History"
            onClick={() => setSidebarView("history")}
          >
            <History size={15} strokeWidth={1.5} />
          </button>
          <button
            className={
              sidebarView === "debug" ? "icon-button active" : "icon-button"
            }
            title="Run and Debug (⇧⌘D)"
            onClick={() => setSidebarView("debug")}
          >
            <Bug size={15} strokeWidth={1.5} />
          </button>
          <button
            className={
              sidebarView === "plugins" ? "icon-button active" : "icon-button"
            }
            title="Plugins"
            onClick={() => setSidebarView("plugins")}
          >
            <Puzzle size={15} strokeWidth={1.5} />
          </button>
          {rootPath && sidebarView === "files" && (
            <>
              <span className="sidebar-actions-divider" />
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
              <button
                className="icon-button"
                title="Open Folder… (⌘O)"
                onClick={openFolderDialog}
              >
                <FolderOpen size={15} strokeWidth={1.5} />
              </button>
            </>
          )}
        </span>
      </div>

      {sidebarView === "search" && <SearchPanel />}
      {sidebarView === "git" && <SourceControlPanel />}
      {sidebarView === "history" && <HistoryPanel />}
      {sidebarView === "debug" && <DebugPanel />}
      {sidebarView === "plugins" && <PluginsPanel />}

      {sidebarView === "files" && pendingCreate && (
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

      {sidebarView === "files" &&
        (rootPath ? (
          <>
            <FileTree />
            <TasksSection />
          </>
        ) : (
          <div className="sidebar-empty">
            <FolderOpen size={28} strokeWidth={1.25} aria-hidden />
            <p>No folder opened</p>
            <button
              className="sidebar-open-button"
              onClick={openFolderDialog}
            >
              Open Folder
            </button>
            <p className="sidebar-empty-hint">
              or drag a folder into the window
            </p>
          </div>
        ))}
    </aside>
  );
}

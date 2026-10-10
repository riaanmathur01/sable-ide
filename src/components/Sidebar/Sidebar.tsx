import { useState } from "react";
import { FilePlus, FolderOpen, FolderPlus } from "lucide-react";
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
import { PAGES, VIEWS, openPage, showView } from "../ActivityBar/views";
import { ViewMenu } from "../ActivityBar/ViewMenu";
import { useSetting } from "../../store/settingsStore";
import "./Sidebar.css";

type PendingCreate = "file" | "folder" | null;

/**
 * The sidebar: the current view (Explorer, Search, Source Control, …) under
 * a header with its title and actions — and, depending on the View
 * Switcher setting, the view icons or the ☰ view menu.
 */
export function Sidebar() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const rootName = useWorkspaceStore((state) => state.rootName);
  const refreshDirectory = useWorkspaceStore((state) => state.refreshDirectory);
  const setLastError = useUiStore((state) => state.setLastError);
  const sidebarView = useUiStore((state) => state.sidebarView);
  const switcher = useSetting("workbench.viewSwitcher");
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
        {switcher === "menu" && <ViewMenu />}
        <span className="sidebar-title">
          {sidebarView === "files" ? (rootName ?? "Explorer") : (VIEWS.find((view) => view.id === sidebarView)?.label ?? "")}
        </span>
        <span className="sidebar-actions">
          {switcher === "sidebarHeader" && (
            <>
              {VIEWS.map(({ id, label, icon: Icon, shortcut }) => (
                <button
                  key={id}
                  className={sidebarView === id ? "icon-button active" : "icon-button"}
                  title={shortcut ? `${label} (${shortcut})` : label}
                  onClick={() => showView(id)}
                >
                  <Icon size={15} strokeWidth={1.5} />
                  {id === "git" && changeCount > 0 && <span className="sidebar-change-count">{changeCount}</span>}
                </button>
              ))}
              <button className="icon-button" title={PAGES.plugins.label} onClick={() => openPage("plugins")}>
                <PAGES.plugins.icon size={15} strokeWidth={1.5} />
              </button>
            </>
          )}
          {rootPath && sidebarView === "files" && (
            <>
              {switcher === "sidebarHeader" && <span className="sidebar-actions-divider" />}
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

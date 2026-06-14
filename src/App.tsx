import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { EditorArea } from "./components/Editor/EditorArea";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { useUiStore, lastTerminalVisible } from "./store/uiStore";
import { useTabsStore } from "./store/tabsStore";
import {
  useWorkspaceStore,
  lastOpenedFolder,
  clearLastOpenedFolder,
} from "./store/workspaceStore";
import { useSearchStore } from "./store/searchStore";
import { useGitStore } from "./store/gitStore";
import { isDirectory, type SearchMatch } from "./lib/ipc";
import { useGlobalKeybindings } from "./lib/useGlobalKeybindings";
import { initLspListeners } from "./lib/lsp/lspClient";
import "./App.css";

/**
 * Shell layout: a horizontal row of sidebar + editor, with the status bar
 * pinned underneath. The terminal panel slots into the editor column in
 * Phase 4.
 */
function App() {
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const setLastError = useUiStore((state) => state.setLastError);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const applyExternalChanges = useWorkspaceStore(
    (state) => state.applyExternalChanges,
  );
  const [isDropTarget, setIsDropTarget] = useState(false);

  useGlobalKeybindings();

  // Register LSP event listeners once for the app's lifetime.
  useEffect(() => {
    initLspListeners();
  }, []);

  // Session restore: reopen the folder from last launch, then its tabs
  // (and the terminal panel if it was open). If the folder is gone
  // (moved/deleted), forget it silently instead of erroring.
  useEffect(() => {
    const last = lastOpenedFolder();
    if (!last) return;
    isDirectory(last)
      .then(async (exists) => {
        if (!exists) {
          clearLastOpenedFolder();
          return;
        }
        await openWorkspace(last);
        await useTabsStore.getState().restoreSession();
        if (lastTerminalVisible()) {
          useUiStore.getState().setTerminalVisible(true);
        }
      })
      .catch(() => clearLastOpenedFolder());
  }, [openWorkspace]);

  // The Rust watcher reports which directories changed on disk (already
  // debounced); refresh whichever of them the tree has loaded.
  useEffect(() => {
    const unlistenPromise = listen<string[]>("fs:changed", (event) => {
      applyExternalChanges(event.payload);
      // Disk changes (incl. external commits) can change git status.
      useGitStore.getState().refresh();
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [applyExternalChanges]);

  // Streaming search results from the Rust side.
  useEffect(() => {
    const unlistenBatch = listen<{ searchId: number; matches: SearchMatch[] }>(
      "search:results",
      (event) =>
        useSearchStore
          .getState()
          .receiveBatch(event.payload.searchId, event.payload.matches),
    );
    const unlistenDone = listen<{
      searchId: number;
      total: number;
      limitHit: boolean;
    }>("search:done", (event) =>
      useSearchStore
        .getState()
        .finishSearch(event.payload.searchId, event.payload.limitHit),
    );
    return () => {
      unlistenBatch.then((unlisten) => unlisten());
      unlistenDone.then((unlisten) => unlisten());
    };
  }, []);

  // Native drag-and-drop: dropping a folder anywhere on the window opens
  // it as the workspace. The OS gives us real paths (unlike browser DnD),
  // delivered through Tauri's webview event stream.
  useEffect(() => {
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setIsDropTarget(true);
      } else if (event.payload.type === "drop") {
        setIsDropTarget(false);
        const droppedPath = event.payload.paths[0];
        if (!droppedPath) return;
        isDirectory(droppedPath)
          .then((directory) => {
            if (directory) return openWorkspace(droppedPath);
            setLastError("Drop a folder to open it as a workspace");
          })
          .catch((error) => setLastError(String(error)));
      } else {
        setIsDropTarget(false);
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [openWorkspace, setLastError]);

  return (
    <div className="app-shell">
      <div className="app-main">
        {sidebarVisible && <Sidebar />}
        <div className="editor-column">
          <EditorArea />
          <TerminalPanel />
        </div>
      </div>
      <StatusBar />
      {isDropTarget && (
        <div className="drop-overlay">Drop folder to open</div>
      )}
    </div>
  );
}

export default App;

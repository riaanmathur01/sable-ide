import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { EditorArea } from "./components/Editor/EditorArea";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { RunConfigDialog } from "./components/Run/RunConfigDialog";
import { RefactorPicker } from "./components/ContextMenu/RefactorPicker";
import { checkForUpdatesQuietly } from "./lib/updates";
import { AgentPanel } from "./components/Agent/AgentPanel";
import { Resizer } from "./components/Layout/Resizer";
import { useUiStore, lastTerminalVisible } from "./store/uiStore";
import { useColorTheme, useSettingsStore } from "./store/settingsStore";
import { applyUiTheme } from "./lib/themes";
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
import { initDebugListeners } from "./lib/debug/debugClient";
import "./App.css";

/**
 * Shell layout: sidebar | editor column (editor over the bottom panel) |
 * AI agent panel, with resizable splits and the status bar pinned
 * underneath.
 */
function App() {
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const terminalVisible = useUiStore((state) => state.terminalVisible);
  const agentVisible = useUiStore((state) => state.agentVisible);
  const panelSizes = useUiStore((state) => state.panelSizes);
  const setPanelSize = useUiStore((state) => state.setPanelSize);
  const setLastError = useUiStore((state) => state.setLastError);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const applyExternalChanges = useWorkspaceStore(
    (state) => state.applyExternalChanges,
  );
  const [isDropTarget, setIsDropTarget] = useState(false);

  useGlobalKeybindings();

  const colorTheme = useColorTheme();
  useEffect(() => applyUiTheme(colorTheme), [colorTheme]);

  // Register LSP + debug event listeners once for the app's lifetime,
  // and load the user's settings.
  useEffect(() => {
    initLspListeners();
    initDebugListeners();
    // Settings first: whether to check for updates is one of them.
    void useSettingsStore.getState().load().then(() => checkForUpdatesQuietly());
  }, []);

  // Session restore: reopen the folder from last launch, then its tabs
  // (and the terminal panel if it was open). If the folder is gone
  // (moved/deleted), forget it silently instead of erroring.
  const restoredRef = useRef(false);
  useEffect(() => {
    // Run once — React StrictMode double-invokes effects in dev, and a
    // second restore would race the async tab opens into duplicates.
    if (restoredRef.current) return;
    restoredRef.current = true;
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
        {sidebarVisible && (
          <>
            <Sidebar />
            <Resizer
              axis="x"
              size={panelSizes.sidebarWidth}
              defaultSize={240}
              onResize={(size) => setPanelSize("sidebarWidth", size)}
            />
          </>
        )}
        <div className="editor-column">
          <EditorArea />
          {terminalVisible && (
            <Resizer
              axis="y"
              invert
              size={panelSizes.panelHeight}
              defaultSize={240}
              onResize={(size) => setPanelSize("panelHeight", size)}
            />
          )}
          <TerminalPanel />
        </div>
        {agentVisible && (
          <>
            <Resizer
              axis="x"
              invert
              size={panelSizes.agentWidth}
              defaultSize={380}
              onResize={(size) => setPanelSize("agentWidth", size)}
            />
            <AgentPanel />
          </>
        )}
      </div>
      <StatusBar />
      {isDropTarget && (
        <div className="drop-overlay">Drop folder to open</div>
      )}
      <CommandPalette />
      <RunConfigDialog />
      <RefactorPicker />
    </div>
  );
}

export default App;

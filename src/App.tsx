import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "./lib/events";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { EditorArea, warmEditor } from "./components/Editor/EditorArea";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { RunConfigDialog } from "./components/Run/RunConfigDialog";
import { RefactorPicker } from "./components/ContextMenu/RefactorPicker";
import { RefactoringDialogs } from "./components/Refactoring/RefactoringDialogs";
import { BreakpointEditor } from "./components/Debug/BreakpointEditor";
import { AttachDialog } from "./components/Debug/AttachDialog";
import { RebaseDialog } from "./components/Sidebar/RebaseDialog";
import { AskpassDialog } from "./components/Remote/AskpassDialog";
import { checkForUpdatesQuietly } from "./lib/updates";
import { useTasksStore } from "./store/tasksStore";
import { usePluginStore } from "./store/pluginStore";
import { ActivityBar } from "./components/ActivityBar/ActivityBar";
import { clearTestContexts } from "./lib/testing/runner";
import { ColorPicker } from "./components/ColorPicker/ColorPicker";
import { AgentsPanel } from "./components/Agents/AgentsPanel";
import { Resizer } from "./components/Layout/Resizer";
import { useUiStore, lastTerminalVisible } from "./store/uiStore";
import { useColorTheme, useSetting, useSettingsStore } from "./store/settingsStore";
import { applyUiTheme, onThemeRegistryChange, themeRegistryVersion } from "./lib/themes";
import { useTabsStore } from "./store/tabsStore";
import {
  useWorkspaceStore,
  lastOpenedFolder,
  clearLastOpenedFolder,
} from "./store/workspaceStore";
import { useSearchStore } from "./store/searchStore";
import { useGitStore } from "./store/gitStore";
import { isDirectory, pathExists, type SearchMatch } from "./lib/ipc";
import { initLocalRoots, isRemoteActive } from "./lib/backend";
import { lastRemote, useRemoteStore } from "./store/remoteStore";
import { launchState, mainWindowState, openNewWindow, takeOtherWindowStates, type WindowState } from "./lib/windows";
import { startWindowSync } from "./lib/windowSync";
import { uploadToRemote } from "./lib/transfer";
import { useGlobalKeybindings } from "./lib/useGlobalKeybindings";
import { useShortcutStore } from "./lib/shortcuts";

/** Resolves when the folder from last time is open again (or there's none). */
let markWorkspaceRestored: () => void = () => {};
const workspaceRestored = Promise.race([
  new Promise<void>((resolve) => (markWorkspaceRestored = resolve)),
  // Never hold plugins back for long (a slow remote reconnect).
  new Promise<void>((resolve) => setTimeout(resolve, 8000)),
]);
import { initLspListeners } from "./lib/lsp/lspClient";
import { initDebugListeners } from "./lib/debug/debugClient";
import { initClaudeCode } from "./lib/claudeCode";
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
  const viewSwitcher = useSetting("workbench.viewSwitcher");
  // Only the activity bar lives outside the sidebar; the other switchers
  // are in its header, so a sidebar hidden from the activity bar would
  // take them with it. Show it whenever one of those is chosen.
  useEffect(() => {
    if (viewSwitcher !== "activityBar" && !useUiStore.getState().sidebarVisible) {
      useUiStore.getState().toggleSidebar();
    }
  }, [viewSwitcher]);

  useGlobalKeybindings();

  const colorTheme = useColorTheme();
  // Plugins' themes register as their files load: repaint when the one in
  // use arrives (or changes).
  const themes = useSyncExternalStore(onThemeRegistryChange, themeRegistryVersion);
  useEffect(() => applyUiTheme(colorTheme), [colorTheme, themes]);

  // Register LSP + debug event listeners once for the app's lifetime,
  // and load the user's settings.
  useEffect(() => {
    initLspListeners();
    initDebugListeners();
    // Claude Code (Anthropic's CLI) connects to this window as its IDE.
    initClaudeCode();
    // Themes from plugins don't wait for the folder: the window's colors
    // may depend on one.
    void usePluginStore.getState().loadThemes();
    // Settings first: whether to check for updates is one of them.
    void useSettingsStore
      .getState()
      .load()
      .then(() => {
        checkForUpdatesQuietly();
        // Plugins start once the last folder is open again (extensions,
        // as in VS Code, see the workspace when they activate).
        void workspaceRestored.then(() => usePluginStore.getState().load());
        // keybindings.json lives beside settings.json.
        void useShortcutStore.getState().load();
      });
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
    const remote = lastRemote();
    const launch = launchState();
    void (async () => {
      // Sable's own files stay local even in a remote window.
      await initLocalRoots();
      try {
        if (launch === "empty") return;
        if (launch) {
          // A window opened from another one (New Window, Open in New
          // Window), or one reopened from last time.
          await openWindowState(launch);
        } else {
          const saved = mainWindowState();
          // A multi-root workspace: its folders (or workspace file).
          if (saved && !saved.remote && (saved.folders.length > 1 || saved.workspaceFile)) await openWindowState(saved);
          else await restoreLastWorkspace();
          // …and the other windows that were open at quit.
          for (const state of takeOtherWindowStates()) void openNewWindow(state);
        }
      } finally {
        markWorkspaceRestored();
        startWindowSync();
      }
    })();
    async function openWindowState(state: WindowState) {
      if (state.remote) {
        if (!(await useRemoteStore.getState().connect(state.remote.target, state.remote.folder))) return;
        for (const folder of state.folders.slice(1)) await useWorkspaceStore.getState().addFolder(folder);
      } else if (state.workspaceFile && (await pathExists(state.workspaceFile).catch(() => false))) {
        await useWorkspaceStore.getState().openWorkspaceFile(state.workspaceFile);
      } else {
        const existing: string[] = [];
        for (const folder of state.folders) if (await isDirectory(folder).catch(() => false)) existing.push(folder);
        if (!existing.length) return;
        await useWorkspaceStore.getState().openFolders(existing, state.workspaceFile ?? null);
      }
      await useTabsStore.getState().restoreSession();
    }
    async function restoreLastWorkspace() {
      if (!last) return;
      if (remote && remote.folder === last) {
        // A remote folder: reconnect to it, as VS Code does.
        if (!(await useRemoteStore.getState().connect(remote.target, remote.folder))) return;
      } else {
        if (!(await isDirectory(last).catch(() => false))) {
          clearLastOpenedFolder();
          return;
        }
        await openWorkspace(last);
      }
      await useTabsStore.getState().restoreSession();
      if (lastTerminalVisible()) {
        useUiStore.getState().setTerminalVisible(true);
      }
    }
  }, [openWorkspace]);

  // Load the editor while idle after startup, so the first file opened
  // doesn't wait for Monaco (3.7 MB) or React's Suspense reveal delay.
  useEffect(() => {
    const warm = () => warmEditor();
    const idle = (window as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(warm, { timeout: 2500 });
    else setTimeout(warm, 1200);
  }, []);

  // The Rust watcher reports which directories changed on disk (already
  // debounced); refresh whichever of them the tree has loaded.
  useEffect(() => {
    const unlistenPromise = listen<string[]>("fs:changed", (event) => {
      applyExternalChanges(event.payload);
      // A build file at the top (package.json, Makefile…) may have changed.
      if (event.payload.includes(useWorkspaceStore.getState().rootPath ?? "")) {
        void useTasksStore.getState().load();
      }
      // …and which test runner applies (a new package.json, Cargo.toml, …).
      clearTestContexts();
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
        // A remote window: dropped files are uploaded to the remote folder.
        if (isRemoteActive()) {
          const root = useWorkspaceStore.getState().rootPath;
          if (root) void uploadToRemote(event.payload.paths, root);
          else setLastError(`Open a folder on ${useRemoteStore.getState().label} first, then drop files to upload them`);
          return;
        }
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
        {viewSwitcher === "activityBar" && <ActivityBar />}
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
            <AgentsPanel />
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
      <RefactoringDialogs />
      <BreakpointEditor />
      <AttachDialog />
      <RebaseDialog />
      <AskpassDialog />
      <ColorPicker />
    </div>
  );
}

export default App;

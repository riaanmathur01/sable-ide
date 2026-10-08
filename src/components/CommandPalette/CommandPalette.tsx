import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useUiStore, type PaletteMode } from "../../store/uiStore";
import { cursorContext, goTo, useNavigationStore } from "../../store/navigationStore";
import {
  documentSymbols,
  serverSupports,
  SYMBOL_KIND_NAMES,
  workspaceSymbols,
  type SymbolEntry,
} from "../../lib/lsp/navigation";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useGitStore } from "../../store/gitStore";
import { useTerminalStore } from "../../store/terminalStore";
import { listWorkspaceFiles } from "../../lib/ipc";
import { fuzzyScore } from "../../lib/fuzzy";
import { runActiveFile } from "../../lib/runFile";
import { openFolderDialog } from "../../lib/openFolder";
import { useDebugStore } from "../../store/debugStore";
import { useAgentStore } from "../../store/agentStore";
import { useBreakpointsStore } from "../../store/breakpointsStore";
import {
  DEFAULT_SETTINGS,
  useSettingsStore,
  type SettingKey,
} from "../../store/settingsStore";
import { getEditor } from "../../lib/editorRegistry";
import { installRuff } from "../../lib/formatting";
import { runnableFile } from "../../lib/runFile";
import { useRunConfigStore } from "../../store/runConfigStore";
import { useTestStore } from "../../store/testStore";
import { refactor, refactorThis } from "../../lib/refactor";
import { checkForUpdates } from "../../lib/updates";
import { THEMES } from "../../lib/themes";
import {
  restartLanguageServers,
  setUpPythonSemanticHighlighting,
  setUpTypeScriptServer,
} from "../../lib/lsp/lspClient";
import "./CommandPalette.css";

interface PaletteItem {
  id: string;
  label: string;
  /** Dim secondary text: a relative path or a keybinding hint. */
  detail?: string;
  /** Small tag before the label (symbol kind). */
  tag?: string;
  /** Indentation level (File Structure). */
  depth?: number;
  /** Search Everywhere groups results under headings. */
  section?: string;
  /** Text matched by the filter, when it differs from the label. */
  filterText?: string;
  run: () => void;
}

const MAX_RESULTS = 50;

const PLACEHOLDERS: Record<PaletteMode, string> = {
  commands: "Type a command…",
  files: "Go to file…",
  structure: "Go to a class, function or member in this file…",
  symbols: "Go to a class, function or variable in the project…",
  everywhere: "Search files, symbols and actions…",
  recentFiles: "Recent files",
  recentLocations: "Recent locations",
};

function relativeTo(path: string): string {
  const root = useWorkspaceStore.getState().rootPath ?? "";
  return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") : path;
}

function fileItem(path: string, section?: string): PaletteItem {
  const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
  return {
    id: `file:${path}`,
    label: name,
    detail: relativeTo(path),
    section,
    run: () => void useTabsStore.getState().openFile(path),
  };
}

function symbolItem(symbol: SymbolEntry, options: { showFile: boolean; section?: string }): PaletteItem {
  const where = options.showFile ? `${relativeTo(symbol.path)}:${symbol.line}` : `:${symbol.line}`;
  return {
    id: `symbol:${symbol.path}:${symbol.line}:${symbol.column}:${symbol.name}`,
    label: symbol.name,
    tag: SYMBOL_KIND_NAMES[symbol.kind],
    depth: options.showFile ? 0 : symbol.depth,
    detail: [symbol.detail, symbol.container, where].filter(Boolean).join("  ·  "),
    section: options.section,
    run: () => void goTo(symbol.path, symbol.line, symbol.column),
  };
}

/** Fuzzy-filter and rank; an empty query keeps the original order. */
function rank(items: PaletteItem[], query: string, limit: number): PaletteItem[] {
  if (query.trim() === "") return items.slice(0, limit);
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    // Score the label and the detail (e.g. a path); take the better.
    const nameScore = fuzzyScore(query, item.filterText ?? item.label);
    const detailScore = item.detail && !item.tag ? fuzzyScore(query, item.detail) : null;
    const best =
      nameScore === null ? detailScore : detailScore === null ? nameScore : Math.max(nameScore, detailScore);
    if (best !== null) scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.item);
}

/**
 * The palette overlay: commands (⇧⌘P), files (⌘P), File Structure
 * (⌘F12), Go to Symbol (⌥⌘O), Search Everywhere (double Shift), Recent
 * Files (⌘E) and Recent Locations (⇧⌘E). One overlay, one fuzzy filter,
 * the same keyboard navigation.
 */
export function CommandPalette() {
  const mode = useUiStore((state) => state.paletteMode);
  const closePalette = useUiStore((state) => state.closePalette);

  if (!mode) return null;
  // Remount per mode so query/selection reset cleanly between them.
  return <PaletteInner key={mode} mode={mode} onClose={closePalette} />;
}

function PaletteInner({ mode, onClose }: { mode: PaletteMode; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [structure, setStructure] = useState<SymbolEntry[] | null>(null);
  /** Project symbols for the current query (asked of the servers). */
  const [symbols, setSymbols] = useState<{ query: string; items: SymbolEntry[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recentFiles = useNavigationStore((state) => state.recentFiles);
  const recentLocations = useNavigationStore((state) => state.recentLocations);
  /** The file the palette was opened over. */
  const [currentPath] = useState(() => cursorContext()?.path ?? useTabsStore.getState().activePath);

  // The workspace's files (quick open, Search Everywhere).
  useEffect(() => {
    if (mode !== "files" && mode !== "everywhere") return;
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    listWorkspaceFiles(root)
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [mode]);

  // File Structure: the current file's symbols.
  useEffect(() => {
    if (mode !== "structure") return;
    if (!currentPath || !serverSupports(currentPath, "documentSymbolProvider")) {
      setStructure([]);
      return;
    }
    documentSymbols(currentPath)
      .then(setStructure)
      .catch(() => setStructure([]));
  }, [mode, currentPath]);

  // Project symbols, re-queried as you type (debounced).
  useEffect(() => {
    if (mode !== "symbols" && mode !== "everywhere") return;
    const trimmed = query.trim();
    if (!trimmed) {
      setSymbols(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      workspaceSymbols(trimmed, useWorkspaceStore.getState().rootPath)
        .then((items) => {
          if (!cancelled) setSymbols({ query: trimmed, items });
        })
        .catch(() => {
          if (!cancelled) setSymbols({ query: trimmed, items: [] });
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, query]);

  const results = useMemo<PaletteItem[]>(() => {
    switch (mode) {
      case "files":
        return rank(files.map((path) => fileItem(path)), query, MAX_RESULTS);
      case "commands":
        return rank(buildCommands(), query, MAX_RESULTS);
      case "structure":
        return rank(
          (structure ?? []).map((symbol) => symbolItem(symbol, { showFile: false })),
          query,
          query.trim() ? MAX_RESULTS : 1000,
        );
      case "symbols":
        return rank(
          (symbols?.items ?? []).map((symbol) => symbolItem(symbol, { showFile: true })),
          query,
          MAX_RESULTS,
        );
      case "recentFiles":
        // The current file is listed but the previous one is preselected.
        return rank(recentFiles.map((path) => fileItem(path)), query, MAX_RESULTS);
      case "recentLocations":
        return rank(
          recentLocations.map((location) => ({
            id: `location:${location.path}:${location.line}`,
            label: location.preview.trim() || "(blank line)",
            detail: `${relativeTo(location.path)}:${location.line}`,
            filterText: `${location.preview} ${relativeTo(location.path)}`,
            run: () => void goTo(location.path, location.line, location.column),
          })),
          query,
          MAX_RESULTS,
        );
      case "everywhere": {
        if (!query.trim()) {
          // Nothing typed: recent files, like JetBrains.
          return recentFiles.slice(0, 10).map((path) => fileItem(path, "Recent Files"));
        }
        const fileResults = rank(files.map((path) => fileItem(path, "Files")), query, 8);
        const symbolResults = rank(
          (symbols?.items ?? []).map((symbol) => symbolItem(symbol, { showFile: true, section: "Symbols" })),
          query,
          8,
        );
        const actionResults = rank(
          buildCommands().map((command) => ({ ...command, section: "Actions" })),
          query,
          6,
        );
        return [...fileResults, ...symbolResults, ...actionResults];
      }
    }
  }, [mode, files, structure, symbols, query, recentFiles, recentLocations]);

  // Reset the selection when the results change. In Recent Files the
  // current file is first, so start on the one before it (⌘E, Enter
  // flips between two files).
  useEffect(() => {
    const switchBack = mode === "recentFiles" && !query && recentFiles[0] === currentPath && results.length > 1;
    setSelected(switchBack ? 1 : 0);
  }, [query, mode, results.length, recentFiles, currentPath]);
  useEffect(() => {
    const node = listRef.current?.querySelector(`[data-index="${selected}"]`) as HTMLElement | null;
    node?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function choose(item: PaletteItem | undefined) {
    if (!item) return;
    const before = useUiStore.getState().paletteMode;
    item.run();
    // If the action re-targeted the palette (e.g. "Go to File…"), leave
    // it open; otherwise close.
    if (useUiStore.getState().paletteMode === before) onClose();
  }

  const emptyMessage =
    mode === "structure"
      ? structure === null
        ? "Loading…"
        : currentPath && !serverSupports(currentPath, "documentSymbolProvider")
          ? "File Structure needs a language server for this file's language"
          : "No symbols"
      : mode === "symbols" && !query.trim()
        ? "Type a name — searches every running language server"
        : (mode === "symbols" || mode === "everywhere") && query.trim() && symbols?.query !== query.trim()
          ? "Searching…"
          : mode === "recentFiles" || mode === "recentLocations"
            ? query
              ? "No matches"
              : "Nothing yet"
            : "No matches";

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder={PLACEHOLDERS[mode]}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((index) => Math.min(index + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(results[selected]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">{emptyMessage}</div>}
          {results.map((item, index) => (
            <Fragment key={item.id}>
              {item.section && item.section !== results[index - 1]?.section && (
                <div className="palette-section">{item.section}</div>
              )}
              <div
                data-index={index}
                className={index === selected ? "palette-item selected" : "palette-item"}
                style={item.depth ? { paddingLeft: 10 + item.depth * 16 } : undefined}
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(item)}
              >
                {item.tag && <span className="palette-item-tag">{item.tag}</span>}
                <span className="palette-item-label">{item.label}</span>
                {item.detail && <span className="palette-item-detail">{item.detail}</span>}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Flip a boolean setting. */
function toggleSetting(key: SettingKey) {
  const { values, set } = useSettingsStore.getState();
  set(key, !values[key] as never);
}

/** The static action list for command mode (plus git actions if a repo). */
function buildCommands(): PaletteItem[] {
  const ui = useUiStore.getState();
  const tabs = useTabsStore.getState();
  const debug = useDebugStore.getState();
  const settings = useSettingsStore.getState();
  const items: PaletteItem[] = [
    {
      id: "settings",
      label: "Preferences: Open Settings",
      detail: "⌘,",
      run: () => tabs.openSettings(),
    },
    {
      id: "settings-json",
      label: "Preferences: Open settings.json",
      run: () => {
        const path = settings.filePath;
        if (path) void tabs.openFile(path);
      },
    },
    {
      id: "agent-focus",
      label: "Agent: Ask the AI Agent",
      detail: "⌘L",
      run: () => ui.focusAgent(),
    },
    {
      id: "agent-toggle",
      label: "Agent: Toggle Panel",
      detail: "⌥⌘A",
      run: () => ui.toggleAgent(),
    },
    {
      id: "agent-new",
      label: "Agent: New Chat",
      run: () => {
        useAgentStore.getState().newChat();
        ui.focusAgent();
      },
    },
    ...Object.values(THEMES).map((theme) => ({
      id: `theme-${theme.id}`,
      label: `Color Theme: ${theme.label}`,
      detail: settings.values["workbench.colorTheme"] === theme.id ? "current" : undefined,
      run: () => settings.set("workbench.colorTheme", theme.id),
    })),
    {
      id: "split-right",
      label: "View: Split Editor Right",
      detail: "⌘\\",
      run: () => void tabs.splitRight(),
    },
    {
      id: "move-to-next-group",
      label: "View: Move Editor into Next Group",
      run: () => void tabs.moveActiveTabToNextGroup(),
    },
    {
      id: "focus-next-group",
      label: "View: Focus Next Editor Group",
      detail: "⌥⌘→",
      run: () => tabs.focusAdjacentGroup(1),
    },
    {
      id: "close-group",
      label: "View: Close Editor Group",
      run: () => void tabs.closeGroup(tabs.activeGroupId),
    },
    {
      id: "python-basedpyright",
      label: "Python: Install basedpyright (semantic highlighting)",
      run: () => void setUpPythonSemanticHighlighting(),
    },
    {
      id: "install-typescript-server",
      label: "TypeScript: Install Language Server",
      run: () => void setUpTypeScriptServer(),
    },
    {
      id: "restart-lsp",
      label: "Restart Language Servers",
      run: () => void restartLanguageServers(),
    },
    {
      id: "problems",
      label: "View: Show Problems",
      run: () => ui.setBottomPanel("problems"),
    },
    {
      id: "quick-fix",
      label: "Quick Fix…",
      detail: "⌘.",
      run: () => {
        const editor = getEditor();
        editor?.focus();
        void editor?.getAction("editor.action.quickFix")?.run();
      },
    },
    {
      id: "next-problem",
      label: "Go to Next Problem",
      detail: "F8",
      run: () => {
        const editor = getEditor();
        editor?.focus();
        void editor?.getAction("editor.action.marker.nextInFiles")?.run();
      },
    },
    { id: "check-updates", label: "Check for Updates…", run: () => void checkForUpdates() },
    { id: "refactor-this", label: "Refactor: Refactor This… (⌃T)", run: refactorThis },
    {
      id: "local-history",
      label: "Local History: Show History for Current File",
      run: () => {
        const file = useTabsStore.getState().lastFilePath;
        if (file) useTabsStore.getState().openHistory(file);
      },
    },
    {
      id: "git-stash",
      label: "Git: Stash Changes (including new files)",
      run: () => void useGitStore.getState().stashSave(null, true),
    },
    {
      id: "git-stash-pop",
      label: "Git: Pop Latest Stash",
      run: () => void useGitStore.getState().stashApply(0, true),
    },
    {
      id: "local-history-deleted",
      label: "Local History: Recover Deleted File…",
      run: () => useTabsStore.getState().openHistory(null),
    },
    { id: "refactor-variable", label: "Refactor: Extract Variable (⌥⌘V)", run: () => void refactor("extractVariable") },
    { id: "refactor-method", label: "Refactor: Extract Method (⌥⌘M)", run: () => void refactor("extractMethod") },
    { id: "refactor-constant", label: "Refactor: Extract Constant (⌥⌘C)", run: () => void refactor("extractConstant") },
    { id: "refactor-inline", label: "Refactor: Inline (⌥⌘N)", run: () => void refactor("inline") },
    {
      id: "format",
      label: "Format Document",
      run: () => {
        void getEditor()?.getAction("editor.action.formatDocument")?.run();
      },
    },
    {
      id: "word-wrap",
      label: "View: Toggle Word Wrap",
      detail: "⌥Z",
      run: () =>
        settings.set(
          "editor.wordWrap",
          settings.values["editor.wordWrap"] === "on" ? "off" : "on",
        ),
    },
    {
      id: "minimap",
      label: "View: Toggle Minimap",
      run: () => toggleSetting("editor.minimap"),
    },
    {
      id: "sticky-scroll",
      label: "View: Toggle Sticky Scroll",
      run: () => toggleSetting("editor.stickyScroll"),
    },
    {
      id: "auto-save",
      label: "File: Toggle Auto Save",
      run: () => toggleSetting("files.autoSave"),
    },
    {
      id: "zoom-in",
      label: "View: Editor Zoom In",
      detail: "⌘=",
      run: () => settings.set("editor.fontSize", settings.values["editor.fontSize"] + 1),
    },
    {
      id: "zoom-out",
      label: "View: Editor Zoom Out",
      detail: "⌘-",
      run: () => settings.set("editor.fontSize", settings.values["editor.fontSize"] - 1),
    },
    {
      id: "zoom-reset",
      label: "View: Reset Editor Zoom",
      detail: "⌘0",
      run: () => settings.set("editor.fontSize", DEFAULT_SETTINGS["editor.fontSize"]),
    },
    {
      id: "reopen-tab",
      label: "Reopen Closed Tab",
      detail: "⇧⌘T",
      run: () => void tabs.reopenClosedTab(),
    },
    {
      id: "debug-view",
      label: "Debug: Show Run and Debug",
      detail: "⇧⌘D",
      run: () => ui.setSidebarView("debug"),
    },
    {
      id: "debug-console",
      label: "Debug: Show Debug Console",
      run: () => ui.setBottomPanel("debug"),
    },
    {
      id: "debug-breakpoint",
      label: "Debug: Toggle Breakpoint",
      detail: "F9",
      run: () => {
        const path = tabs.lastFilePath;
        const line = getEditor()?.getPosition()?.lineNumber;
        if (path && line) useBreakpointsStore.getState().toggle(path, line);
      },
    },
    ...(debug.isDebugging
      ? [
          { id: "debug-continue", label: "Debug: Continue", detail: "F5", run: () => void debug.continue() },
          { id: "debug-over", label: "Debug: Step Over", detail: "F10", run: () => void debug.stepOver() },
          { id: "debug-into", label: "Debug: Step Into", detail: "F11", run: () => void debug.stepInto() },
          { id: "debug-out", label: "Debug: Step Out", detail: "⇧F11", run: () => void debug.stepOut() },
          { id: "debug-pause", label: "Debug: Pause", detail: "F6", run: () => void debug.pause() },
          { id: "debug-restart", label: "Debug: Restart", detail: "⇧⌘F5", run: () => void debug.restart() },
        ]
      : []),
    {
      id: "quick-open",
      label: "Go to File…",
      detail: "⌘P",
      run: () => ui.openPalette("files"),
    },
    {
      id: "navigate-back",
      label: "Navigate: Back",
      detail: "⌘[",
      run: () => void useNavigationStore.getState().goBack(),
    },
    {
      id: "navigate-forward",
      label: "Navigate: Forward",
      detail: "⌘]",
      run: () => void useNavigationStore.getState().goForward(),
    },
    {
      id: "search-everywhere",
      label: "Navigate: Search Everywhere",
      detail: "⇧ ⇧",
      run: () => ui.openPalette("everywhere"),
    },
    {
      id: "go-to-symbol",
      label: "Navigate: Go to Symbol…",
      detail: "⌥⌘O",
      run: () => ui.openPalette("symbols"),
    },
    {
      id: "file-structure",
      label: "Navigate: File Structure",
      detail: "⌘F12",
      run: () => ui.openPalette("structure"),
    },
    {
      id: "recent-files",
      label: "Navigate: Recent Files",
      detail: "⌘E",
      run: () => ui.openPalette("recentFiles"),
    },
    {
      id: "recent-locations",
      label: "Navigate: Recent Locations",
      detail: "⇧⌘E",
      run: () => ui.openPalette("recentLocations"),
    },
    {
      id: "find-usages",
      label: "Navigate: Find Usages",
      detail: "⌥F7",
      run: () => void useNavigationStore.getState().findUsagesAtCursor(),
    },
    {
      id: "go-to-implementation",
      label: "Navigate: Go to Implementation",
      detail: "⌥⌘B",
      run: () => void useNavigationStore.getState().goToAtCursor("implementation"),
    },
    {
      id: "go-to-type",
      label: "Navigate: Go to Type Declaration",
      detail: "⇧⌘B",
      run: () => void useNavigationStore.getState().goToAtCursor("typeDefinition"),
    },
    {
      id: "call-hierarchy",
      label: "Navigate: Call Hierarchy",
      detail: "⌃⌥H",
      run: () => void useNavigationStore.getState().showCallHierarchy(),
    },
    {
      id: "tests-at-cursor",
      label: "Tests: Run Test at Cursor",
      detail: "⌃⇧R",
      run: () => void useTestStore.getState().atCursor(false),
    },
    {
      id: "tests-debug-at-cursor",
      label: "Tests: Debug Test at Cursor",
      detail: "⌃⇧D",
      run: () => void useTestStore.getState().atCursor(true),
    },
    {
      id: "tests-file",
      label: "Tests: Run All Tests in File",
      run: () => {
        const path = runnableFile();
        if (path) void useTestStore.getState().runFileTests(path);
      },
    },
    {
      id: "tests-project",
      label: "Tests: Run All Tests in Project",
      run: () => void useTestStore.getState().runProject(),
    },
    {
      id: "tests-rerun-failed",
      label: "Tests: Rerun Failed Tests",
      run: () => void useTestStore.getState().rerunFailed(),
    },
    {
      id: "tests-show",
      label: "Tests: Show Results",
      run: () => ui.setBottomPanel("tests"),
    },
    {
      id: "run-config",
      label: "Run: Edit Configuration… (arguments, environment, working directory)",
      run: () => {
        const path = runnableFile();
        if (path) useRunConfigStore.getState().edit(path);
      },
    },
    {
      id: "install-ruff",
      label: "Python: Install Ruff (formatter)",
      run: () => void installRuff(),
    },
    {
      id: "inlay-hints",
      label: "View: Toggle Inlay Hints",
      run: () => toggleSetting("editor.inlayHints"),
    },
    {
      id: "save",
      label: "Save File",
      detail: "⌘S",
      run: () => {
        const { activePath, saveTab } = useTabsStore.getState();
        if (activePath) void saveTab(activePath);
      },
    },
    { id: "run", label: "Run File", detail: "⌘R", run: () => runActiveFile() },
    {
      id: "debug-start",
      label: "Debug: Start Debugging",
      detail: "F5",
      run: () => void useDebugStore.getState().start(),
    },
    {
      id: "debug-stop",
      label: "Debug: Stop Debugging",
      detail: "⇧F5",
      run: () => void useDebugStore.getState().stop(),
    },
    {
      id: "toggle-terminal",
      label: "Toggle Terminal",
      detail: "⌘J",
      run: () => ui.toggleTerminal(),
    },
    {
      id: "restart-terminal",
      label: "Restart Terminal",
      run: () => void useTerminalStore.getState().restartSession(),
    },
    {
      id: "new-terminal",
      label: "Terminal: New Terminal",
      detail: "⌃⇧`",
      run: () => void useTerminalStore.getState().newTerminal(),
    },
    {
      id: "kill-terminal",
      label: "Terminal: Kill Active Terminal",
      run: () => {
        const terminals = useTerminalStore.getState();
        void terminals.closeTerminal(terminals.activeId);
      },
    },
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      detail: "⌘B",
      run: () => ui.toggleSidebar(),
    },
    {
      id: "explorer",
      label: "Show Explorer",
      run: () => ui.setSidebarView("files"),
    },
    {
      id: "search",
      label: "Search in Workspace",
      detail: "⇧⌘F",
      run: () => ui.setSidebarView("search"),
    },
    {
      id: "scm",
      label: "Source Control",
      detail: "⇧⌘G",
      run: () => ui.setSidebarView("git"),
    },
    {
      id: "history",
      label: "Show History",
      run: () => ui.setSidebarView("history"),
    },
    {
      id: "toggle-blame",
      label: "Toggle Git Blame",
      run: () => ui.toggleBlame(),
    },
    {
      id: "open-folder",
      label: "Open Folder…",
      detail: "⌘O",
      run: () => void openFolderDialog(),
    },
    {
      id: "close-tab",
      label: "Close Tab",
      detail: "⌘W",
      run: () => {
        const { activePath, closeTab } = useTabsStore.getState();
        if (activePath) void closeTab(activePath);
      },
    },
  ];

  // Git network actions only make sense with a remote.
  const git = useGitStore.getState();
  if (git.isRepo && git.hasRemote) {
    items.push(
      { id: "git-sync", label: "Git: Sync (Pull, then Push)", run: () => void git.sync() },
      { id: "git-push", label: "Git: Push", run: () => void git.push() },
      { id: "git-pull", label: "Git: Pull", run: () => void git.pull() },
      { id: "git-fetch", label: "Git: Fetch", run: () => void git.fetch() },
    );
  }
  return items;
}

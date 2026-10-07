import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../../store/uiStore";
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
import { THEMES } from "../../lib/themes";
import {
  restartLanguageServers,
  setUpPythonSemanticHighlighting,
} from "../../lib/lsp/lspClient";
import "./CommandPalette.css";

interface PaletteItem {
  id: string;
  label: string;
  /** Dim secondary text: a relative path or a keybinding hint. */
  detail?: string;
  run: () => void;
}

const MAX_RESULTS = 50;

/**
 * Command palette (⇧⌘P) and quick file open (⌘P). One overlay, two
 * sources of items, the same fuzzy filter + keyboard navigation.
 */
export function CommandPalette() {
  const mode = useUiStore((state) => state.paletteMode);
  const closePalette = useUiStore((state) => state.closePalette);

  if (!mode) return null;
  // Remount per mode so query/selection reset cleanly between them.
  return <PaletteInner key={mode} mode={mode} onClose={closePalette} />;
}

function PaletteInner({
  mode,
  onClose,
}: {
  mode: "commands" | "files";
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // Load the workspace file list once for quick-open.
  useEffect(() => {
    if (mode !== "files") return;
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    listWorkspaceFiles(root)
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [mode]);

  const allItems = useMemo<PaletteItem[]>(() => {
    if (mode === "files") {
      const root = useWorkspaceStore.getState().rootPath ?? "";
      return files.map((path) => {
        const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
        const relative = path.startsWith(root)
          ? path.slice(root.length).replace(/^[/\\]/, "")
          : path;
        return {
          id: path,
          label: name,
          detail: relative,
          run: () => void useTabsStore.getState().openFile(path),
        };
      });
    }
    return buildCommands();
  }, [mode, files]);

  // Filter + rank. Empty query keeps original order (capped).
  const results = useMemo<PaletteItem[]>(() => {
    if (query.trim() === "") return allItems.slice(0, MAX_RESULTS);
    const scored: { item: PaletteItem; score: number }[] = [];
    for (const item of allItems) {
      // For files, score the filename and the path; take the better.
      const nameScore = fuzzyScore(query, item.label);
      const pathScore = item.detail ? fuzzyScore(query, item.detail) : null;
      const best =
        nameScore === null
          ? pathScore
          : pathScore === null
            ? nameScore
            : Math.max(nameScore, pathScore);
      if (best !== null) scored.push({ item, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((entry) => entry.item);
  }, [query, allItems]);

  // Keep selection in range and scrolled into view.
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    const node = listRef.current?.children[selected] as
      | HTMLElement
      | undefined;
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

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          className="palette-input"
          autoFocus
          placeholder={
            mode === "files" ? "Go to file…" : "Type a command…"
          }
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
          {results.length === 0 && (
            <div className="palette-empty">No matches</div>
          )}
          {results.map((item, index) => (
            <div
              key={item.id}
              className={
                index === selected ? "palette-item selected" : "palette-item"
              }
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(item)}
            >
              <span className="palette-item-label">{item.label}</span>
              {item.detail && (
                <span className="palette-item-detail">{item.detail}</span>
              )}
            </div>
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
      detail: "⌥⌘B",
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

import { useState } from "react";
import {
  Bug,
  CircleX,
  TriangleAlert,
  GitBranch,
  RefreshCw,
  Settings,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { useGitStore } from "../../store/gitStore";
import { useInterpreterStore } from "../../store/interpreterStore";
import { useDebugStore } from "../../store/debugStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useProblemCounts } from "../../store/problemsStore";
import { serverIdFor } from "../../lib/lsp/lspClient";
import { InterpreterPicker } from "./InterpreterPicker";
import { BranchPicker } from "./BranchPicker";
import { usePluginStore } from "../../store/pluginStore";
import "../Plugins/Plugins.css";
import "./StatusBar.css";

/** Languages that show an interpreter selector in the status bar. */
const INTERPRETER_EXTENSIONS = new Set(["py", "pyi"]);

/** Friendly names for Monaco language ids where the id is cryptic. */
const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  java: "Java",
  rust: "Rust",
  go: "Go",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  markdown: "Markdown",
  shell: "Shell",
  yaml: "YAML",
  plaintext: "Plain Text",
  cpp: "C++",
  csharp: "C#",
};

/** Plugins' status-bar items (clicking runs the plugin's command). */
function PluginStatusItems() {
  const items = usePluginStore((state) => state.statusItems);
  const commands = usePluginStore((state) => state.commands);
  return (
    <>
      {Object.entries(items).map(([pluginId, item]) => {
        const command = item.command
          ? commands.find((entry) => entry.pluginId === pluginId && entry.command.id === item.command)
          : undefined;
        return command ? (
          <button
            key={pluginId}
            className="status-bar-button status-bar-plugin"
            title={item.tooltip ?? command.command.title}
            onClick={() => usePluginStore.getState().runCommand(pluginId, command.command.handler)}
          >
            {item.text}
          </button>
        ) : (
          <span key={pluginId} className="status-bar-item status-bar-plugin" title={item.tooltip}>
            {item.text}
          </span>
        );
      })}
    </>
  );
}

/**
 * Status bar pinned to the bottom of the window: panel toggles, workspace
 * and git on the left; the current file and transient errors in the
 * middle; cursor, indentation, language, interpreter, and tools on the
 * right.
 */
export function StatusBar() {
  const rootName = useWorkspaceStore((state) => state.rootName);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const lastError = useUiStore((state) => state.lastError);
  const statusMessage = useUiStore((state) => state.statusMessage);
  const updateProgress = useUiStore((state) => state.updateProgress);
  const setLastError = useUiStore((state) => state.setLastError);
  const cursorPosition = useUiStore((state) => state.cursorPosition);
  const lastFileForLsp = useTabsStore((state) => state.lastFilePath);
  // The language server for the file being edited, not whichever
  // server last reported in.
  const lspStatus = useUiStore((state) => {
    const serverId = lastFileForLsp ? serverIdFor(lastFileForLsp) : null;
    return serverId ? (state.lspStatus[serverId] ?? null) : null;
  });
  const terminalVisible = useUiStore((state) => state.terminalVisible);
  const toggleTerminal = useUiStore((state) => state.toggleTerminal);
  const activePath = useTabsStore((state) => state.activePath);
  const lastFilePath = useTabsStore((state) => state.lastFilePath);
  const hasActiveTab = activePath !== null;
  const isRepo = useGitStore((state) => state.isRepo);
  const branch = useGitStore((state) => state.branch);
  const ahead = useGitStore((state) => state.ahead);
  const behind = useGitStore((state) => state.behind);
  const hasUpstream = useGitStore((state) => state.hasUpstream);
  const hasRemote = useGitStore((state) => state.hasRemote);
  const isSyncing = useGitStore((state) => state.isSyncing);
  const sync = useGitStore((state) => state.sync);
  const editorInfo = useUiStore((state) => state.editorInfo);
  const problems = useProblemCounts();
  const agentVisible = useUiStore((state) => state.agentVisible);
  const toggleAgent = useUiStore((state) => state.toggleAgent);
  const isDebugging = useDebugStore((state) => state.isDebugging);
  const isPaused = useDebugStore((state) => state.isPaused);
  const autoSave = useSettingsStore((state) => state.values["files.autoSave"]);
  const activeKind = useTabsStore(
    (state) => state.tabs.find((tab) => tab.path === state.activePath)?.kind,
  );

  const interpreters = useInterpreterStore((state) => state.interpreters);
  const selectedPath = useInterpreterStore((state) => state.selectedPath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);

  const activeExtension = activePath?.split(".").pop()?.toLowerCase() ?? "";
  const showInterpreter = INTERPRETER_EXTENSIONS.has(activeExtension);

  // Path of the file currently in the editor, relative to the workspace.
  const currentFilePath =
    lastFilePath && rootPath && lastFilePath.startsWith(rootPath)
      ? lastFilePath.slice(rootPath.length).replace(/^[/\\]/, "")
      : lastFilePath;
  const selected = interpreters.find((i) => i.path === selectedPath);
  const interpreterLabel =
    selected?.label ??
    (selectedPath
      ? (selectedPath.split("/").pop() ?? "Python")
      : "Select Interpreter");

  return (
    <footer className="status-bar">
      <div className="status-bar-group">
        <button
          className={
            terminalVisible
              ? "status-bar-button active"
              : "status-bar-button"
          }
          title="Toggle Terminal (⌘J)"
          onClick={toggleTerminal}
        >
          <SquareTerminal size={13} strokeWidth={1.5} />
          Terminal
        </button>
        <span className="status-bar-item">
          {rootName ?? "No folder opened"}
        </span>
        {isRepo && branch && (
          <button
            className="status-bar-button"
            title="Switch / manage branches"
            onClick={() => setBranchPickerOpen((open) => !open)}
          >
            <GitBranch size={13} strokeWidth={1.5} />
            {branch}
            {hasUpstream && (ahead > 0 || behind > 0) && (
              <span className="status-bar-aheadbehind">
                {ahead > 0 && `↑${ahead}`}
                {ahead > 0 && behind > 0 && " "}
                {behind > 0 && `↓${behind}`}
              </span>
            )}
          </button>
        )}
        <button
          className="status-bar-button status-bar-problems"
          title="Problems — errors and warnings (click to open)"
          onClick={() => useUiStore.getState().setBottomPanel("problems")}
        >
          <CircleX size={12} strokeWidth={1.75} />
          {problems.errors}
          <TriangleAlert size={12} strokeWidth={1.75} />
          {problems.warnings}
        </button>
        {isRepo && hasRemote && (
          <button
            className="status-bar-button"
            title="Sync (pull, then push)"
            disabled={isSyncing}
            onClick={() => sync()}
          >
            <RefreshCw
              size={13}
              strokeWidth={1.5}
              className={isSyncing ? "spinning" : undefined}
            />
          </button>
        )}
      </div>
      {currentFilePath && (
        <span className="status-bar-filepath" title={lastFilePath ?? undefined}>
          {currentFilePath}
        </span>
      )}
      {updateProgress && (
        <span className="status-bar-update" title="Sable is updating — it restarts when done">
          <RefreshCw size={12} strokeWidth={1.75} className="spinning" />
          {updateProgress}
        </span>
      )}
      {!lastError && statusMessage && (
        <span className="status-bar-message">{statusMessage}</span>
      )}
      {lastError && (
        <button
          className="status-bar-error"
          title="Dismiss"
          onClick={() => setLastError(null)}
        >
          {lastError}
        </button>
      )}
      <div className="status-bar-group">
        {isDebugging && (
          <button
            className="status-bar-button debugging"
            title="Run and Debug"
            onClick={() => useUiStore.getState().setSidebarView("debug")}
          >
            <Bug size={13} strokeWidth={1.5} />
            {isPaused ? "Paused" : "Debugging"}
          </button>
        )}
        {activeKind === "file" && cursorPosition && (
          <span className="status-bar-item">
            Ln {cursorPosition.line}, Col {cursorPosition.column}
          </span>
        )}
        {activeKind === "file" && editorInfo && (
          <>
            <button
              className="status-bar-button"
              title="Indentation (configure in Settings)"
              onClick={() => useTabsStore.getState().openSettings()}
            >
              {editorInfo.insertSpaces ? "Spaces" : "Tab Size"}: {editorInfo.tabSize}
            </button>
            <span className="status-bar-item">
              {LANGUAGE_NAMES[editorInfo.language] ?? editorInfo.language}
            </span>
          </>
        )}
        {showInterpreter && (
          <button
            className="status-bar-button"
            title="Select Python Interpreter (used by Run)"
            onClick={() => setPickerOpen((open) => !open)}
          >
            {interpreterLabel}
          </button>
        )}
        {lspStatus && <span className="status-bar-item">{lspStatus}</span>}
        <PluginStatusItems />
        {hasActiveTab && autoSave && (
          <span className="status-bar-item">Auto Save</span>
        )}
        <button
          className={agentVisible ? "status-bar-button active" : "status-bar-button"}
          title="AI Agent (⌘L)"
          onClick={toggleAgent}
        >
          <Sparkles size={13} strokeWidth={1.5} />
          Agent
        </button>
        <button
          className="status-bar-button"
          title="Settings (⌘,)"
          onClick={() => useTabsStore.getState().openSettings()}
        >
          <Settings size={13} strokeWidth={1.5} />
        </button>
      </div>
      {pickerOpen && (
        <InterpreterPicker onClose={() => setPickerOpen(false)} />
      )}
      {branchPickerOpen && (
        <BranchPicker onClose={() => setBranchPickerOpen(false)} />
      )}
    </footer>
  );
}

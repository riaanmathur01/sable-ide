import { useState } from "react";
import { GitBranch, RefreshCw, SquareTerminal } from "lucide-react";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { useGitStore } from "../../store/gitStore";
import { useInterpreterStore } from "../../store/interpreterStore";
import { InterpreterPicker } from "./InterpreterPicker";
import { BranchPicker } from "./BranchPicker";
import "./StatusBar.css";

/** Languages that show an interpreter selector in the status bar. */
const INTERPRETER_EXTENSIONS = new Set(["py", "pyi"]);

/**
 * Status bar pinned to the bottom of the window: workspace name on the
 * left, transient errors in the middle, app version on the right.
 */
export function StatusBar() {
  const rootName = useWorkspaceStore((state) => state.rootName);
  const lastError = useUiStore((state) => state.lastError);
  const setLastError = useUiStore((state) => state.setLastError);
  const cursorPosition = useUiStore((state) => state.cursorPosition);
  const lspStatus = useUiStore((state) => state.lspStatus);
  const terminalVisible = useUiStore((state) => state.terminalVisible);
  const toggleTerminal = useUiStore((state) => state.toggleTerminal);
  const activePath = useTabsStore((state) => state.activePath);
  const hasActiveTab = activePath !== null;
  const blameEnabled = useUiStore((state) => state.blameEnabled);
  const toggleBlame = useUiStore((state) => state.toggleBlame);
  const isRepo = useGitStore((state) => state.isRepo);
  const branch = useGitStore((state) => state.branch);
  const ahead = useGitStore((state) => state.ahead);
  const behind = useGitStore((state) => state.behind);
  const hasUpstream = useGitStore((state) => state.hasUpstream);
  const hasRemote = useGitStore((state) => state.hasRemote);
  const isSyncing = useGitStore((state) => state.isSyncing);
  const sync = useGitStore((state) => state.sync);

  const interpreters = useInterpreterStore((state) => state.interpreters);
  const selectedPath = useInterpreterStore((state) => state.selectedPath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);

  const activeExtension = activePath?.split(".").pop()?.toLowerCase() ?? "";
  const showInterpreter = INTERPRETER_EXTENSIONS.has(activeExtension);
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
        {hasActiveTab && cursorPosition && (
          <span className="status-bar-item">
            Ln {cursorPosition.line}, Col {cursorPosition.column}
          </span>
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
        {hasActiveTab && (
          <button
            className={
              blameEnabled
                ? "status-bar-button active"
                : "status-bar-button"
            }
            title="Toggle Git Blame"
            onClick={toggleBlame}
          >
            Blame
          </button>
        )}
        {lspStatus && <span className="status-bar-item">{lspStatus}</span>}
        {hasActiveTab && <span className="status-bar-item">Auto Save</span>}
        <span className="status-bar-item">Sable 0.1.0</span>
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

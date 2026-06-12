import { SquareTerminal } from "lucide-react";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import "./StatusBar.css";

/**
 * Status bar pinned to the bottom of the window: workspace name on the
 * left, transient errors in the middle, app version on the right.
 */
export function StatusBar() {
  const rootName = useWorkspaceStore((state) => state.rootName);
  const lastError = useUiStore((state) => state.lastError);
  const setLastError = useUiStore((state) => state.setLastError);
  const cursorPosition = useUiStore((state) => state.cursorPosition);
  const terminalVisible = useUiStore((state) => state.terminalVisible);
  const toggleTerminal = useUiStore((state) => state.toggleTerminal);
  const hasActiveTab = useTabsStore((state) => state.activePath !== null);

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
        {hasActiveTab && <span className="status-bar-item">Auto Save</span>}
        <span className="status-bar-item">Sable 0.1.0</span>
      </div>
    </footer>
  );
}

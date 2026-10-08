import { Suspense, lazy, useEffect, useState } from "react";
import { Plus, RotateCw, SquareTerminal, Trash2, X } from "lucide-react";
import { useUiStore } from "../../store/uiStore";
import { useTerminalStore } from "../../store/terminalStore";
import { useDebugStore } from "../../store/debugStore";
import { DebugConsole } from "../Debug/DebugConsole";
import { ProblemsPanel } from "../Problems/ProblemsPanel";
import { useProblemCounts } from "../../store/problemsStore";
import { useNavigationStore } from "../../store/navigationStore";
import { UsagesPanel } from "../Navigation/UsagesPanel";
import { CallHierarchyPanel } from "../Navigation/CallHierarchyPanel";
import { TestsPanel } from "../Tests/TestsPanel";
import { useTestStore } from "../../store/testStore";
import "./TerminalPanel.css";

const TerminalView = lazy(() => import("./TerminalView"));

/**
 * Bottom panel host with three tabs: terminals, problems, and the debug
 * console. xterm loads the first time a terminal is shown; after that
 * every session's view stays mounted (hidden with CSS) so shells and
 * scrollback survive toggling and switching. With several terminals, a
 * list on the right switches between them (like VS Code). Restarting
 * changes a session's id, which (via the key) remounts its view.
 */
export function TerminalPanel() {
  const panelVisible = useUiStore((state) => state.terminalVisible);
  const bottomPanel = useUiStore((state) => state.bottomPanel);
  const setBottomPanel = useUiStore((state) => state.setBottomPanel);
  const setTerminalVisible = useUiStore((state) => state.setTerminalVisible);
  const height = useUiStore((state) => state.panelSizes.panelHeight);
  const sessions = useTerminalStore((state) => state.sessions);
  const activeId = useTerminalStore((state) => state.activeId);
  const { newTerminal, closeTerminal, restartSession, setActive } =
    useTerminalStore.getState();
  const clearConsole = useDebugStore((state) => state.clearConsole);
  const [terminalEverShown, setTerminalEverShown] = useState(false);
  const problemCounts = useProblemCounts();
  const problemTotal = problemCounts.errors + problemCounts.warnings;
  // Usages and Call Hierarchy tabs appear once they have something to show.
  const hasUsages = useNavigationStore((state) => state.usages !== null);
  const hasHierarchy = useNavigationStore((state) => state.hierarchy !== null);
  const usageCount = useNavigationStore((state) => state.usages?.usages.length ?? 0);
  const { clearUsages, clearHierarchy } = useNavigationStore.getState();
  const hasTestRun = useTestStore((state) => state.run !== null);
  const failedTests = useTestStore((state) => state.lastResults.filter((result) => result.status === "failed").length);
  const testsRunning = useTestStore((state) => state.run?.running ?? false);

  const terminalShown = panelVisible && bottomPanel === "terminal";
  useEffect(() => {
    if (terminalShown) setTerminalEverShown(true);
  }, [terminalShown]);

  if (!panelVisible && !terminalEverShown) return null;

  return (
    <div
      className={panelVisible ? "terminal-panel" : "terminal-panel hidden"}
      style={{ height }}
    >
      <div className="terminal-panel-header">
        <div className="terminal-panel-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={bottomPanel === "terminal"}
            className={bottomPanel === "terminal" ? "active" : undefined}
            onClick={() => setBottomPanel("terminal")}
          >
            Terminal
          </button>
          <button
            role="tab"
            aria-selected={bottomPanel === "problems"}
            className={bottomPanel === "problems" ? "active" : undefined}
            onClick={() => setBottomPanel("problems")}
          >
            Problems
            {problemTotal > 0 && (
              <span className="terminal-panel-badge">{problemTotal}</span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={bottomPanel === "debug"}
            className={bottomPanel === "debug" ? "active" : undefined}
            onClick={() => setBottomPanel("debug")}
          >
            Debug Console
          </button>
          {(hasTestRun || bottomPanel === "tests") && (
            <button
              role="tab"
              aria-selected={bottomPanel === "tests"}
              className={bottomPanel === "tests" ? "active" : undefined}
              onClick={() => setBottomPanel("tests")}
            >
              Tests
              {testsRunning ? (
                <span className="terminal-panel-badge">…</span>
              ) : (
                failedTests > 0 && <span className="terminal-panel-badge failed">{failedTests}</span>
              )}
            </button>
          )}
          {(hasUsages || bottomPanel === "usages") && (
            <button
              role="tab"
              aria-selected={bottomPanel === "usages"}
              className={bottomPanel === "usages" ? "active" : undefined}
              onClick={() => setBottomPanel("usages")}
            >
              Usages
              {usageCount > 0 && <span className="terminal-panel-badge">{usageCount}</span>}
            </button>
          )}
          {(hasHierarchy || bottomPanel === "hierarchy") && (
            <button
              role="tab"
              aria-selected={bottomPanel === "hierarchy"}
              className={bottomPanel === "hierarchy" ? "active" : undefined}
              onClick={() => setBottomPanel("hierarchy")}
            >
              Call Hierarchy
            </button>
          )}
        </div>
        <div className="terminal-panel-actions">
          {bottomPanel === "tests" ? null : bottomPanel === "usages" || bottomPanel === "hierarchy" ? (
            <button
              className="terminal-panel-action"
              title="Clear"
              onClick={() => {
                if (bottomPanel === "usages") clearUsages();
                else clearHierarchy();
                setBottomPanel("terminal");
              }}
            >
              <Trash2 size={13} strokeWidth={1.5} />
            </button>
          ) : bottomPanel === "problems" ? null : bottomPanel === "terminal" ? (
            <>
              <button
                className="terminal-panel-action"
                title="New Terminal (⌃⇧`)"
                onClick={() => newTerminal()}
              >
                <Plus size={14} strokeWidth={1.5} />
              </button>
              <button
                className="terminal-panel-action"
                title="Restart Terminal"
                onClick={() => restartSession()}
              >
                <RotateCw size={13} strokeWidth={1.5} />
              </button>
              <button
                className="terminal-panel-action"
                title="Kill Terminal"
                onClick={() => void closeTerminal(activeId)}
              >
                <Trash2 size={13} strokeWidth={1.5} />
              </button>
            </>
          ) : (
            <button
              className="terminal-panel-action"
              title="Clear Console"
              onClick={clearConsole}
            >
              <Trash2 size={13} strokeWidth={1.5} />
            </button>
          )}
          <button
            className="terminal-panel-action"
            title="Close Panel (⌘J)"
            onClick={() => setTerminalVisible(false)}
          >
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {terminalEverShown && (
        <div
          className="terminal-panel-body"
          style={{ display: bottomPanel === "terminal" ? "flex" : "none" }}
        >
          <div className="terminal-panel-views">
            <Suspense fallback={null}>
              {sessions.map((session) => (
                <TerminalView
                  key={session.id}
                  terminalId={session.id}
                  isActive={session.id === activeId}
                />
              ))}
            </Suspense>
          </div>
          {sessions.length > 1 && (
            <div className="terminal-list" role="tablist" aria-label="Terminals">
              {sessions.map((session, index) => (
                <div
                  key={session.id}
                  role="tab"
                  aria-selected={session.id === activeId}
                  className={
                    session.id === activeId ? "terminal-list-item active" : "terminal-list-item"
                  }
                  onClick={() => setActive(session.id)}
                  title={session.title || "Terminal"}
                >
                  <SquareTerminal size={13} strokeWidth={1.5} />
                  <span className="terminal-list-title">
                    {index + 1}: {session.title || "Terminal"}
                  </span>
                  <button
                    className="terminal-list-close"
                    title="Kill Terminal"
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTerminal(session.id);
                    }}
                  >
                    <X size={12} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {bottomPanel === "debug" && <DebugConsole />}
      {bottomPanel === "problems" && <ProblemsPanel />}
      {bottomPanel === "usages" && <UsagesPanel />}
      {bottomPanel === "tests" && <TestsPanel />}
      {bottomPanel === "hierarchy" && <CallHierarchyPanel />}
    </div>
  );
}

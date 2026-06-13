import { Suspense, lazy, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { useUiStore } from "../../store/uiStore";
import { useTerminalStore } from "../../store/terminalStore";
import "./TerminalPanel.css";

const TerminalView = lazy(() => import("./TerminalView"));

/**
 * Bottom panel host. xterm loads the first time the panel opens; after
 * that the panel is hidden with CSS (not unmounted) so the shell session
 * and scrollback survive toggling. Restarting changes the session id,
 * which (via the key) remounts the view with a fresh shell.
 */
export function TerminalPanel() {
  const terminalVisible = useUiStore((state) => state.terminalVisible);
  const terminalId = useTerminalStore((state) => state.terminalId);
  const restartSession = useTerminalStore((state) => state.restartSession);
  const [hasEverOpened, setHasEverOpened] = useState(false);

  useEffect(() => {
    if (terminalVisible) setHasEverOpened(true);
  }, [terminalVisible]);

  if (!hasEverOpened) return null;

  return (
    <div className={terminalVisible ? "terminal-panel" : "terminal-panel hidden"}>
      <div className="terminal-panel-header">
        <span>Terminal</span>
        <button
          className="terminal-panel-action"
          title="Restart Terminal"
          onClick={() => restartSession()}
        >
          <RotateCw size={13} strokeWidth={1.5} />
        </button>
      </div>
      <Suspense fallback={null}>
        <TerminalView key={terminalId} terminalId={terminalId} />
      </Suspense>
    </div>
  );
}

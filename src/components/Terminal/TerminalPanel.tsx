import { Suspense, lazy, useEffect, useState } from "react";
import { useUiStore } from "../../store/uiStore";
import "./TerminalPanel.css";

const TerminalView = lazy(() => import("./TerminalView"));

/**
 * Bottom panel host. xterm loads the first time the panel opens; after
 * that the panel is hidden with CSS (not unmounted) so the shell session
 * and scrollback survive toggling.
 */
export function TerminalPanel() {
  const terminalVisible = useUiStore((state) => state.terminalVisible);
  const [hasEverOpened, setHasEverOpened] = useState(false);

  useEffect(() => {
    if (terminalVisible) setHasEverOpened(true);
  }, [terminalVisible]);

  if (!hasEverOpened) return null;

  return (
    <div className={terminalVisible ? "terminal-panel" : "terminal-panel hidden"}>
      <div className="terminal-panel-header">Terminal</div>
      <Suspense fallback={null}>
        <TerminalView />
      </Suspense>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { useTerminalStore } from "../../store/terminalStore";
import { resizeTerminal, writeTerminal } from "../../lib/ipc";
import { useUiStore } from "../../store/uiStore";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  /** Session id this view is bound to. Remounting with a new id (via the
   * parent's key) starts a fresh shell. */
  terminalId: string;
}

/**
 * The xterm.js surface, bridged to the Rust PTY:
 *   keystrokes  → xterm onData   → write_terminal command
 *   shell bytes → terminal:output event → xterm.write
 *
 * Lazy-loaded (like Monaco) so xterm's bundle is only fetched the first
 * time the panel opens. The component stays mounted while the panel is
 * hidden, so the shell session survives toggling.
 */
export default function TerminalView({ terminalId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalVisible = useUiStore((state) => state.terminalVisible);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", "Cascadia Code", monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: {
        background: "#161618",
        foreground: "#e6e6e9",
        cursor: "#7c93ff",
        cursorAccent: "#161618",
        selectionBackground: "#7c93ff33",
        black: "#161618",
        brightBlack: "#8a8a93",
        white: "#e6e6e9",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    const { ensureSession, markSessionEnded } =
      useTerminalStore.getState();

    // PTY starts (or already exists) before any listener misses output:
    // create first, then sync the real size.
    ensureSession().then(() => {
      resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(
        () => {},
      );
    });

    const inputDisposable = terminal.onData((data) => {
      writeTerminal(terminalId, data).catch(() => {});
    });

    const unlistenOutput = listen<{ id: string; data: string }>(
      "terminal:output",
      (event) => {
        if (event.payload.id === terminalId) {
          terminal.write(event.payload.data);
        }
      },
    );
    const unlistenExit = listen<string>("terminal:exit", (event) => {
      if (event.payload === terminalId) {
        markSessionEnded();
        terminal.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
      }
    });

    // Refit when the panel (or window) resizes, and tell the PTY so
    // full-screen programs (vim, htop) reflow correctly.
    const resizeObserver = new ResizeObserver(() => {
      if (container.clientHeight === 0) return; // hidden
      fitAddon.fit();
      resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(
        () => {},
      );
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unlistenOutput.then((unlisten) => unlisten());
      unlistenExit.then((unlisten) => unlisten());
      terminal.dispose();
    };
    // terminalId is fixed per mount (the parent keys this component on it,
    // so a new session id means a fresh component instance).
  }, [terminalId]);

  // Hidden panels have zero size; refit and focus when shown again.
  useEffect(() => {
    if (terminalVisible) {
      requestAnimationFrame(() => fitAddonRef.current?.fit());
    }
  }, [terminalVisible]);

  // Flush a queued "Run" command. This runs only after the mount effect
  // above has attached the output listener, so the command's output is
  // never missed — the fix for Cmd+R losing output when the panel was
  // closed and lazy-loaded.
  const pendingCommand = useTerminalStore((state) => state.pendingCommand);
  useEffect(() => {
    if (!pendingCommand) return;
    const { ensureSession, clearPendingCommand } =
      useTerminalStore.getState();
    void (async () => {
      await ensureSession();
      await writeTerminal(terminalId, `${pendingCommand}\r`).catch(() => {});
      clearPendingCommand();
    })();
  }, [pendingCommand, terminalId]);

  return <div ref={containerRef} className="terminal-view" />;
}

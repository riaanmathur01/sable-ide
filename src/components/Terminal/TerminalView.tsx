import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { useTerminalStore } from "../../store/terminalStore";
import { resizeTerminal, writeTerminal } from "../../lib/ipc";
import { useUiStore } from "../../store/uiStore";
import { useColorTheme, useSetting } from "../../store/settingsStore";
import { themeById } from "../../lib/themes";

/** xterm theme for a color theme; the background matches the panel so
 *  the terminal blends into it. */
function terminalTheme(themeId: string) {
  const theme = themeById(themeId);
  return {
    ...theme.terminal,
    background: theme.ui["--bg-panel"],
    cursorAccent: theme.ui["--bg-panel"],
  };
}
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  /** Session id this view is bound to. Remounting with a new id (via the
   * parent's key) starts a fresh shell. */
  terminalId: string;
  /** The visible tab (others stay mounted, hidden, so shells survive). */
  isActive: boolean;
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
export default function TerminalView({ terminalId, isActive }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  /** Resolves once output listeners are attached and the PTY exists. */
  const sessionReadyRef = useRef<Promise<void>>(Promise.resolve());
  const panelShown = useUiStore(
    (state) => state.terminalVisible && state.bottomPanel === "terminal",
  );
  const terminalShown = panelShown && isActive;
  const fontSize = useSetting("terminal.fontSize");
  const fontFamily = useSetting("terminal.fontFamily");
  const cursorBlink = useSetting("terminal.cursorBlink");
  const colorTheme = useColorTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      fontFamily,
      fontSize,
      lineHeight: 1.35,
      cursorBlink,
      theme: terminalTheme(colorTheme),
    });
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminalRef.current = terminal;
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    // xterm measures its cell size once, at open. If the bundled font
    // wasn't loaded yet, nudge the size so it re-measures with the real
    // glyphs, then refit.
    let disposed = false;
    const fontSpec = `${fontSize}px ${fontFamily}`;
    if (!document.fonts.check(fontSpec)) {
      void document.fonts.load(fontSpec).then(() => {
        if (disposed) return;
        const size = terminal.options.fontSize ?? fontSize;
        terminal.options.fontSize = size + 0.5;
        terminal.options.fontSize = size;
        fitAddon.fit();
      });
    }

    // Backspace fix for macOS WebKit. With inline predictive text on,
    // WKWebView reports keys in a text field as "composing" (keyCode
    // 229); xterm then waits for a textarea change that never comes —
    // its helper textarea is always empty — so Backspace sent nothing.
    // 1) Opt the helper textarea out of writing suggestions/autocorrect.
    const helper = terminal.textarea;
    if (helper) {
      helper.setAttribute("writingsuggestions", "false");
      helper.setAttribute("autocorrect", "off");
      helper.setAttribute("autocapitalize", "off");
      helper.spellcheck = false;
    }
    // 2) Handle Backspace ourselves, with the same bytes macOS terminals
    //    send. Skipped during real IME composition (the textarea then
    //    holds the composing text, and Backspace must edit that).
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.key !== "Backspace") return true;
      if (terminal.textarea && terminal.textarea.value !== "") return true;
      event.preventDefault();
      const sequence = event.metaKey
        ? "\x15" // ⌘⌫: delete to start of line (^U)
        : event.altKey
          ? "\x1b\x7f" // ⌥⌫: delete previous word
          : event.ctrlKey
            ? "\b"
            : "\x7f";
      terminal.scrollToBottom();
      writeTerminal(terminalId, sequence).catch(() => {});
      return false;
    });

    const { ensureSession, markSessionEnded, setTitle } =
      useTerminalStore.getState();
    // Tab title: the shell/program's own title (OSC 0/2), e.g. "vim".
    const titleDisposable = terminal.onTitleChange((title) => setTitle(terminalId, title));

    const inputDisposable = terminal.onData((data) => {
      writeTerminal(terminalId, data).catch(() => {});
    });

    // Order matters: the shell prints its prompt within milliseconds of
    // starting, so the output listeners must be registered *before* the
    // PTY exists — otherwise the first prompt is emitted to nobody and
    // the terminal sits blank until the next command.
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
        markSessionEnded(terminalId);
        terminal.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
      }
    });
    // Then start the PTY at the size xterm actually fitted to (shells
    // draw the first prompt line at the starting width).
    sessionReadyRef.current = Promise.all([unlistenOutput, unlistenExit])
      .then(() => ensureSession(terminalId, { cols: terminal.cols, rows: terminal.rows }))
      .then(() => resizeTerminal(terminalId, terminal.cols, terminal.rows))
      .catch(() => {});

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
      disposed = true;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      titleDisposable.dispose();
      unlistenOutput.then((unlisten) => unlisten());
      unlistenExit.then((unlisten) => unlisten());
      terminal.dispose();
    };
    // terminalId is fixed per mount (the parent keys this component on it,
    // so a new session id means a fresh component instance). Font
    // settings apply live via the effect below, not by remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Settings changes apply to the live terminal, then refit (cell size
  // changed) and tell the PTY the new geometry.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    terminal.options.fontFamily = fontFamily;
    terminal.options.cursorBlink = cursorBlink;
    terminal.options.theme = terminalTheme(colorTheme);
    if (containerRef.current?.clientHeight) {
      fitAddonRef.current?.fit();
      resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(() => {});
    }
  }, [fontSize, fontFamily, cursorBlink, colorTheme, terminalId]);

  // Hidden panels have zero size; refit and focus when shown again.
  useEffect(() => {
    if (terminalShown) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      });
    }
  }, [terminalShown]);

  // Flush a queued "Run" command once the listeners are attached and the
  // PTY exists, so neither the prompt nor the command's output is missed
  // (the panel may have been closed and just lazy-loaded).
  const pendingCommand = useTerminalStore((state) =>
    state.pendingCommand?.terminalId === terminalId ? state.pendingCommand.commandLine : null,
  );
  useEffect(() => {
    if (!pendingCommand) return;
    const { clearPendingCommand } = useTerminalStore.getState();
    void (async () => {
      await sessionReadyRef.current;
      await writeTerminal(terminalId, `${pendingCommand}\r`).catch(() => {});
      clearPendingCommand();
    })();
  }, [pendingCommand, terminalId]);

  return (
    <div
      ref={containerRef}
      className="terminal-view"
      style={{ display: isActive ? undefined : "none" }}
    />
  );
}

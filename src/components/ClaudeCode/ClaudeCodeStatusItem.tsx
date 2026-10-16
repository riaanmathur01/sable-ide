import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SquareTerminal, X } from "lucide-react";
import { useClaudeCodeStore } from "../../lib/claudeCode/store";
import { findCli } from "../../lib/claudeCode/backend";
import { focusClaudeTerminal, INSTALL_PAGE, installCommand, runClaudeCode } from "../../lib/claudeCode/launch";
import { useTerminalStore } from "../../store/terminalStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { getSetting } from "../../store/settingsStore";
import "./ClaudeCode.css";

/**
 * Status bar: "Claude Code connected" while Anthropic's CLI is connected
 * to this window (click: show its terminal). Also hosts the install help
 * panel, shown when the CLI isn't installed.
 */
export function ClaudeCodeStatusItem() {
  const clients = useClaudeCodeStore((state) => state.clients);
  const installOpen = useClaudeCodeStore((state) => state.installOpen);
  return (
    <>
      {clients > 0 && (
        <button
          className="status-bar-button claude-code-status"
          title="Claude Code (Anthropic's CLI) is connected to this window — click to show its terminal"
          onClick={() => {
            if (!focusClaudeTerminal()) useUiStore.getState().setBottomPanel("terminal");
          }}
        >
          <SquareTerminal size={13} strokeWidth={1.5} />
          Claude Code connected
        </button>
      )}
      {installOpen && createPortal(<InstallPanel />, document.body)}
    </>
  );
}

/** Claude Code isn't installed: what it is, and Anthropic's ways to get it. */
function InstallPanel() {
  const error = useClaudeCodeStore((state) => state.installError);
  const hide = useClaudeCodeStore((state) => state.hideInstall);
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const command = installCommand();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide]);

  const runInstall = () => {
    // In a terminal you can see, only now that you've asked for it.
    const terminals = useTerminalStore.getState();
    terminals.newTerminal();
    terminals.enqueueCommand(command);
    hide();
  };

  const checkAgain = async () => {
    setChecking(true);
    setNotFound(false);
    const cli = await findCli(getSetting("claudeCode.path").trim() || null).catch(() => null);
    setChecking(false);
    if (!cli) {
      setNotFound(true);
      return;
    }
    hide();
    void runClaudeCode();
  };

  return (
    <div className="claude-install-backdrop" onMouseDown={(event) => event.target === event.currentTarget && hide()}>
      <div className="claude-install" role="dialog" aria-label="Install Claude Code">
        <div className="claude-install-title">
          <SquareTerminal size={16} strokeWidth={1.5} />
          <span>Claude Code isn't installed</span>
          <button className="claude-install-close" title="Close" onClick={hide}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        {error && <div className="claude-install-error">{error}</div>}
        <p>
          Claude Code is Anthropic's command-line coding agent. Sable runs it in its terminal and connects to it as its editor
          (diff review, selection, problems), but doesn't include it: install it from Anthropic first.
        </p>
        <p>Anthropic's install command:</p>
        <pre className="claude-install-command">{command}</pre>
        <p className="claude-install-note">
          Then sign in inside Claude Code with its own <code>/login</code> — Sable never sees or stores your Claude credentials.
          If it's installed somewhere Sable doesn't look, set its path in Settings.
        </p>
        {notFound && <div className="claude-install-error">Still not found. A new install may need a new terminal, or its path in Settings.</div>}
        <div className="claude-install-actions">
          <button onClick={() => void openUrl(INSTALL_PAGE).catch((reason) => useUiStore.getState().setLastError(String(reason)))}>Open install instructions</button>
          <button
            onClick={() => {
              hide();
              useTabsStore.getState().openSettings();
            }}
          >
            Set path…
          </button>
          <button disabled={checking} onClick={() => void checkAgain()}>
            {checking ? "Checking…" : "Check again"}
          </button>
          <button className="primary" onClick={runInstall} title="Runs Anthropic's install command in a new terminal">
            Install in a terminal
          </button>
        </div>
      </div>
    </div>
  );
}

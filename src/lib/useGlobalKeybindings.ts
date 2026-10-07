import { useEffect } from "react";
import { useTabsStore } from "../store/tabsStore";
import { useUiStore } from "../store/uiStore";
import { useDebugStore } from "../store/debugStore";
import { useBreakpointsStore } from "../store/breakpointsStore";
import { useTerminalStore } from "../store/terminalStore";
import { DEFAULT_SETTINGS, useSettingsStore } from "../store/settingsStore";
import { getEditor } from "./editorRegistry";
import { runActiveFile } from "./runFile";
import { openFolderDialog } from "./openFolder";

/**
 * App-wide keyboard shortcuts, registered once at the App level in the
 * *capture* phase so they win over Monaco/xterm regardless of focus.
 * Handled keys stop propagating, so the editor never double-handles them.
 * (Displayed in Settings → Keyboard Shortcuts; keep KEYBINDINGS in sync.)
 */
export const KEYBINDINGS: { keys: string; action: string }[] = [
  { keys: "⇧⌘P", action: "Command palette" },
  { keys: "⌘P", action: "Go to file" },
  { keys: "⌘,", action: "Open settings" },
  { keys: "⌘L", action: "Focus AI agent" },
  { keys: "⌥⌘B", action: "Toggle AI agent panel" },
  { keys: "⌘S", action: "Save (auto-save also runs after typing stops)" },
  { keys: "⌘R", action: "Run active file" },
  { keys: "⌘J  /  ⌘`", action: "Toggle bottom panel" },
  { keys: "⌃⇧`", action: "New terminal" },
  { keys: "⌘B", action: "Toggle sidebar" },
  { keys: "⌘O", action: "Open folder" },
  { keys: "⌘W", action: "Close tab" },
  { keys: "⌘\\", action: "Split editor right" },
  { keys: "⌥⌘←  /  ⌥⌘→", action: "Focus previous / next editor group" },
  { keys: "⇧⌘T", action: "Reopen closed tab" },
  { keys: "⌃Tab  /  ⌃⇧Tab", action: "Next / previous tab" },
  { keys: "⇧⌘]  /  ⇧⌘[", action: "Next / previous tab" },
  { keys: "⌘1 … ⌘9", action: "Go to tab N (⌘9 = last)" },
  { keys: "⌘=  /  ⌘-  /  ⌘0", action: "Editor zoom in / out / reset" },
  { keys: "⌥Z", action: "Toggle word wrap" },
  { keys: "⌘.", action: "Quick fix (on a squiggle: server fixes + Fix with Agent)" },
  { keys: "F8  /  ⇧F8", action: "Next / previous problem" },
  { keys: "F12  /  ⌘-click", action: "Go to definition (Python, TS/JS, Java, Rust, Go, C/C++)" },
  { keys: "⇧⌘F", action: "Search in workspace" },
  { keys: "⇧⌘G", action: "Source control" },
  { keys: "⇧⌘D", action: "Run and debug view" },
  { keys: "F5", action: "Start debugging / continue" },
  { keys: "⇧F5", action: "Stop debugging" },
  { keys: "⇧⌘F5", action: "Restart debugging" },
  { keys: "F6", action: "Pause" },
  { keys: "F9", action: "Toggle breakpoint" },
  { keys: "F10  /  F11  /  ⇧F11", action: "Step over / into / out" },
];

/** Function keys are debug controls — except inside the terminal, where
 *  programs like htop/vim use them. */
function handleFunctionKey(event: KeyboardEvent): boolean {
  if ((event.target as HTMLElement | null)?.closest?.(".terminal-view")) {
    return false;
  }
  const debug = useDebugStore.getState();
  const cmd = event.metaKey || event.ctrlKey;
  switch (event.key) {
    case "F5":
      if (cmd && event.shiftKey) void debug.restart();
      else if (event.shiftKey) void debug.stop();
      else void debug.start();
      return true;
    case "F6":
      void debug.pause();
      return true;
    case "F9": {
      const path = useTabsStore.getState().lastFilePath;
      const line = getEditor()?.getPosition()?.lineNumber;
      if (path && line) useBreakpointsStore.getState().toggle(path, line);
      return true;
    }
    case "F10":
      void debug.stepOver();
      return true;
    case "F11":
      if (event.shiftKey) void debug.stepOut();
      else void debug.stepInto();
      return true;
  }
  return false;
}

function zoomEditor(delta: number | null) {
  const { values, set } = useSettingsStore.getState();
  set(
    "editor.fontSize",
    delta === null
      ? DEFAULT_SETTINGS["editor.fontSize"]
      : values["editor.fontSize"] + delta,
  );
}

export function useGlobalKeybindings() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const handled = dispatch(event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    /** Returns true if the key was an app shortcut. */
    function dispatch(event: KeyboardEvent): boolean {
      if (/^F\d+$/.test(event.key)) return handleFunctionKey(event);

      const ui = useUiStore.getState();
      const tabs = useTabsStore.getState();

      // Ctrl+Tab cycles tabs on every platform.
      if (event.ctrlKey && !event.metaKey && event.key === "Tab") {
        tabs.cycleTab(event.shiftKey ? -1 : 1);
        return true;
      }

      if (!(event.metaKey || event.ctrlKey)) return false;
      const key = event.key.toLowerCase();

      // ⌃⇧` — new terminal (VS Code's binding).
      if (event.ctrlKey && event.shiftKey && event.code === "Backquote") {
        useTerminalStore.getState().newTerminal();
        return true;
      }

      if (event.shiftKey) {
        // Shift combos: event.key is uppercase/shifted, so match on
        // lowercase key or physical code.
        switch (key) {
          case "f":
            ui.setSidebarView("search");
            return true;
          case "g":
            ui.setSidebarView("git");
            return true;
          case "d":
            ui.setSidebarView("debug");
            return true;
          case "p":
            ui.openPalette("commands");
            return true;
          case "t":
            void tabs.reopenClosedTab();
            return true;
        }
        if (event.code === "BracketRight") {
          tabs.cycleTab(1);
          return true;
        }
        if (event.code === "BracketLeft") {
          tabs.cycleTab(-1);
          return true;
        }
        return false;
      }

      if (event.altKey) {
        // ⌥ changes event.key on macOS (⌥B = "∫"), so match the code.
        if (event.code === "KeyB") {
          ui.toggleAgent();
          return true;
        }
        // ⌥⌘←/→: move focus between split editor groups. Only when
        // split — otherwise leave the keys to the editor.
        if (tabs.groups.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          tabs.focusAdjacentGroup(event.key === "ArrowLeft" ? -1 : 1);
          return true;
        }
        return false;
      }

      if (/^[1-9]$/.test(event.key)) {
        tabs.activateTabAt(Number(event.key) - 1);
        return true;
      }

      switch (key) {
        case "p":
          ui.openPalette("files");
          return true;
        case "s":
          if (tabs.activePath) void tabs.saveTab(tabs.activePath);
          return true;
        case "r":
          // Also stops a webview reload.
          void runActiveFile();
          return true;
        case "`":
        case "j":
          ui.toggleTerminal();
          return true;
        case "b":
          ui.toggleSidebar();
          return true;
        case "w":
          if (tabs.activePath) void tabs.closeTab(tabs.activePath);
          return true;
        case "o":
          // Override the webview's open dialog.
          void openFolderDialog();
          return true;
        case ",":
          tabs.openSettings();
          return true;
        case "\\":
          void tabs.splitRight();
          return true;
        case "l":
          ui.focusAgent();
          return true;
        case "=":
        case "+":
          zoomEditor(1);
          return true;
        case "-":
          zoomEditor(-1);
          return true;
        case "0":
          zoomEditor(null);
          return true;
      }
      return false;
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}

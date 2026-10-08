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
import { useNavigationStore } from "../store/navigationStore";
import { useTestStore } from "../store/testStore";
import { refactor, refactorThis } from "./refactor";

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
  { keys: "⌥⌘A", action: "Toggle AI agent panel" },
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
  { keys: "F2  /  ⇧F6", action: "Rename symbol (every reference in the project)" },
  { keys: "⌘[  /  ⌘]", action: "Navigate back / forward (also ⌃- / ⌃⇧- and mouse back/forward buttons)" },
  { keys: "⌃⇧R  /  ⌃⇧D", action: "Run / debug the test at the cursor" },
  { keys: "⇧ ⇧", action: "Search Everywhere (files, symbols, actions)" },
  { keys: "⌥⌘O  /  ⌘T", action: "Go to symbol in the project" },
  { keys: "⌘F12  /  ⇧⌘O", action: "File structure (go to a symbol in this file)" },
  { keys: "⌘E  /  ⇧⌘E", action: "Recent files / recent locations" },
  { keys: "⌥F7", action: "Find usages (every use in the project)" },
  { keys: "⇧F12", action: "Peek usages inline" },
  { keys: "⌥⌘B  /  ⇧⌘B", action: "Go to implementation / type declaration" },
  { keys: "⌃⌥H", action: "Call hierarchy (callers / callees)" },
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
      // Shift+F6 is rename (as in JetBrains IDEs); leave it to the editor.
      if (event.shiftKey) return false;
      void debug.pause();
      return true;
    case "F7":
      // ⌥F7: Find Usages (JetBrains).
      if (!event.altKey) return false;
      void useNavigationStore.getState().findUsagesAtCursor();
      return true;
    case "F12":
      // ⌘F12: File Structure (JetBrains). Plain F12 / ⇧F12 stay the
      // editor's (go to definition / peek usages).
      if (!event.metaKey) return false;
      useUiStore.getState().openPalette("structure");
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

      // ⌃- / ⌃⇧-: back / forward (VS Code's binding on macOS).
      if (event.ctrlKey && !event.metaKey && !event.altKey && (event.code === "Minus")) {
        const navigation = useNavigationStore.getState();
        void (event.shiftKey ? navigation.goForward() : navigation.goBack());
        return true;
      }

      // ⌃⇧` — new terminal (VS Code's binding).
      if (event.ctrlKey && event.shiftKey && event.code === "Backquote") {
        useTerminalStore.getState().newTerminal();
        return true;
      }

      if (event.shiftKey) {
        // Shift combos: event.key is uppercase/shifted, so match on
        // lowercase key or physical code.
        // ⌃⇧R / ⌃⇧D: run / debug the test at the cursor (JetBrains).
        if (event.ctrlKey && !event.metaKey && (event.code === "KeyR" || event.code === "KeyD")) {
          void useTestStore.getState().atCursor(event.code === "KeyD");
          return true;
        }
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
          case "e":
            ui.openPalette("recentLocations");
            return true;
          case "b":
            void useNavigationStore.getState().goToAtCursor("typeDefinition");
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
        // ⌥⌘V / ⌥⌘M / ⌥⌘C / ⌥⌘N: extract variable / method / constant,
        // inline (JetBrains). Only in the editor — elsewhere ⌥⌘C etc.
        // mean nothing to Sable, so leave them to the system.
        if (event.metaKey && !event.ctrlKey && inEditor(event)) {
          const refactoring = ({ KeyV: "extractVariable", KeyM: "extractMethod", KeyC: "extractConstant", KeyN: "inline" } as const)[
            event.code as "KeyV" | "KeyM" | "KeyC" | "KeyN"
          ];
          if (refactoring) {
            void refactor(refactoring);
            return true;
          }
        }
        // ⌥ changes event.key on macOS (⌥B = "∫"), so match the code.
        // ⌥⌘B: Go to Implementation (JetBrains); the agent panel moved
        // to ⌥⌘A.
        if (event.code === "KeyB") {
          void useNavigationStore.getState().goToAtCursor("implementation");
          return true;
        }
        if (event.code === "KeyA") {
          ui.toggleAgent();
          return true;
        }
        if (event.code === "KeyO") {
          ui.openPalette("symbols");
          return true;
        }
        // ⌃⌥H: Call Hierarchy.
        if (event.code === "KeyH" && event.ctrlKey) {
          void useNavigationStore.getState().showCallHierarchy();
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

      // ⌃T: Refactor This (JetBrains, macOS — elsewhere Ctrl is ⌘).
      if (event.ctrlKey && !event.metaKey && event.code === "KeyT" && isMacPlatform() && inEditor(event)) {
        refactorThis();
        return true;
      }

      if (/^[1-9]$/.test(event.key)) {
        tabs.activateTabAt(Number(event.key) - 1);
        return true;
      }

      switch (key) {
        case "p":
          ui.openPalette("files");
          return true;
        case "e":
          ui.openPalette("recentFiles");
          return true;
        case "t":
          ui.openPalette("symbols");
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
        case "[":
          // ⌘[ / ⌘]: back / forward (JetBrains' macOS binding).
          void useNavigationStore.getState().goBack();
          return true;
        case "]":
          void useNavigationStore.getState().goForward();
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

    // Double Shift: Search Everywhere (JetBrains). Two Shift presses on
    // their own, within 400 ms, with nothing typed in between.
    let lastShiftUp = 0;
    let otherKeySinceShift = false;
    function onShiftKeyDown(event: KeyboardEvent) {
      if (event.key !== "Shift") otherKeySinceShift = true;
    }
    function onShiftKeyUp(event: KeyboardEvent) {
      if (event.key !== "Shift") return;
      const now = performance.now();
      if (!otherKeySinceShift && now - lastShiftUp < 400) {
        lastShiftUp = 0;
        useUiStore.getState().openPalette("everywhere");
        return;
      }
      lastShiftUp = otherKeySinceShift ? 0 : now;
      otherKeySinceShift = false;
    }

    // Mouse back/forward buttons.
    function onMouseUp(event: MouseEvent) {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      const navigation = useNavigationStore.getState();
      void (event.button === 3 ? navigation.goBack() : navigation.goForward());
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("mouseup", onMouseUp, { capture: true });
    window.addEventListener("keydown", onShiftKeyDown, { capture: true });
    window.addEventListener("keyup", onShiftKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("mouseup", onMouseUp, { capture: true });
      window.removeEventListener("keydown", onShiftKeyDown, { capture: true });
      window.removeEventListener("keyup", onShiftKeyUp, { capture: true });
    };
  }, []);
}

/** Whether the key went to a code editor (not the terminal, a text box, …). */
function inEditor(event: KeyboardEvent): boolean {
  return event.target instanceof Element && !!event.target.closest(".monaco-editor");
}

function isMacPlatform(): boolean {
  return /mac/i.test(navigator.userAgent);
}

import { useEffect } from "react";
import { useTabsStore } from "../store/tabsStore";
import { useUiStore } from "../store/uiStore";
import { runActiveFile } from "./runFile";

/**
 * App-wide keyboard shortcuts, registered once at the App level so they
 * work regardless of focus (editor, tree, terminal). Monaco re-fires
 * unhandled keys up the DOM, so these still apply while typing.
 *
 *   Cmd/Ctrl+S  save active file
 *   Cmd/Ctrl+R  run active file
 *   Cmd/Ctrl+J  toggle terminal (Cmd+` is a macOS system shortcut and
 *               may never reach the app, so J is the primary binding)
 *   Cmd/Ctrl+`  toggle terminal (works when the OS lets it through)
 *   Cmd/Ctrl+B  toggle sidebar
 *   Cmd/Ctrl+W  close active tab
 *   Cmd/Ctrl+Shift+F  search in workspace
 *   Cmd/Ctrl+Shift+G  source control
 */
export function useGlobalKeybindings() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;

      // Shift combos first: event.key is uppercase when Shift is held.
      if (event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        useUiStore.getState().setSidebarView("search");
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        useUiStore.getState().setSidebarView("git");
        return;
      }

      switch (event.key) {
        case "s": {
          event.preventDefault();
          const { activePath, saveTab } = useTabsStore.getState();
          if (activePath) saveTab(activePath);
          break;
        }
        case "r": {
          event.preventDefault(); // also stops a webview reload
          runActiveFile();
          break;
        }
        case "`":
        case "j": {
          event.preventDefault();
          useUiStore.getState().toggleTerminal();
          break;
        }
        case "b": {
          event.preventDefault();
          useUiStore.getState().toggleSidebar();
          break;
        }
        case "w": {
          event.preventDefault();
          const { activePath, closeTab } = useTabsStore.getState();
          if (activePath) closeTab(activePath);
          break;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

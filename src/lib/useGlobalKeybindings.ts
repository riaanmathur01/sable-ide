import { useEffect } from "react";
import { useUiStore } from "../store/uiStore";
import { useNavigationStore } from "../store/navigationStore";
import { dispatchShortcut } from "./shortcuts";

/**
 * App-wide keyboard shortcuts, registered once at the App level in the
 * *capture* phase so they win over Monaco/xterm regardless of focus.
 * Handled keys stop propagating, so the editor never double-handles them.
 * Which key runs what is in lib/shortcuts.ts (defaults + keybindings.json).
 */
export function useGlobalKeybindings() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      // While a shortcut is being recorded (Settings → Keyboard Shortcuts).
      if ((event.target as HTMLElement | null)?.closest?.("[data-recording-shortcut]")) return;
      if (dispatchShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
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

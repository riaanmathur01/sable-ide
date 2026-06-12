import { create } from "zustand";

/**
 * UI chrome state: which panels are visible, plus transient error
 * messages surfaced in the status bar.
 */
interface CursorPosition {
  line: number;
  column: number;
}

interface UiState {
  sidebarVisible: boolean;
  terminalVisible: boolean;
  lastError: string | null;
  cursorPosition: CursorPosition | null;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  setLastError: (message: string | null) => void;
  setCursorPosition: (position: CursorPosition | null) => void;
}

let errorDismissTimer: ReturnType<typeof setTimeout> | undefined;

export const useUiStore = create<UiState>((set) => ({
  sidebarVisible: true,
  terminalVisible: false,
  lastError: null,
  cursorPosition: null,
  setCursorPosition: (position) => set({ cursorPosition: position }),
  toggleSidebar: () =>
    set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleTerminal: () =>
    set((state) => ({ terminalVisible: !state.terminalVisible })),
  setLastError: (message) => {
    set({ lastError: message });
    // Errors are transient: auto-dismiss so the status bar stays calm.
    clearTimeout(errorDismissTimer);
    if (message !== null) {
      errorDismissTimer = setTimeout(() => set({ lastError: null }), 6000);
    }
  },
}));

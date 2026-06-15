import { create } from "zustand";

/**
 * UI chrome state: which panels are visible, plus transient error
 * messages surfaced in the status bar.
 */
interface CursorPosition {
  line: number;
  column: number;
}

export type SidebarView = "files" | "search" | "git" | "history";
export type PaletteMode = "commands" | "files";

interface UiState {
  sidebarVisible: boolean;
  sidebarView: SidebarView;
  terminalVisible: boolean;
  lastError: string | null;
  cursorPosition: CursorPosition | null;
  /** Name of the connected language server, shown in the status bar. */
  lspStatus: string | null;
  /** Open command/quick-open palette, or null when closed. */
  paletteMode: PaletteMode | null;
  /** Whether git blame annotations are shown in the editor. */
  blameEnabled: boolean;
  toggleSidebar: () => void;
  setSidebarView: (view: SidebarView) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setLastError: (message: string | null) => void;
  setCursorPosition: (position: CursorPosition | null) => void;
  setLspStatus: (status: string | null) => void;
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
  toggleBlame: () => void;
}

/** Persisted across launches so the terminal panel reopens if it was open. */
const TERMINAL_VISIBLE_KEY = "sable.terminalVisible";

export function lastTerminalVisible(): boolean {
  return localStorage.getItem(TERMINAL_VISIBLE_KEY) === "true";
}

let errorDismissTimer: ReturnType<typeof setTimeout> | undefined;

export const useUiStore = create<UiState>((set) => ({
  sidebarVisible: true,
  sidebarView: "files",
  setSidebarView: (view) =>
    set({ sidebarView: view, sidebarVisible: true }),
  terminalVisible: false,
  lastError: null,
  cursorPosition: null,
  setCursorPosition: (position) => set({ cursorPosition: position }),
  lspStatus: null,
  setLspStatus: (status) => set({ lspStatus: status }),
  paletteMode: null,
  openPalette: (mode) => set({ paletteMode: mode }),
  closePalette: () => set({ paletteMode: null }),
  blameEnabled: false,
  toggleBlame: () => set((state) => ({ blameEnabled: !state.blameEnabled })),
  toggleSidebar: () =>
    set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleTerminal: () =>
    set((state) => {
      const terminalVisible = !state.terminalVisible;
      localStorage.setItem(TERMINAL_VISIBLE_KEY, String(terminalVisible));
      return { terminalVisible };
    }),
  setTerminalVisible: (visible) => {
    localStorage.setItem(TERMINAL_VISIBLE_KEY, String(visible));
    set({ terminalVisible: visible });
  },
  setLastError: (message) => {
    set({ lastError: message });
    // Errors are transient: auto-dismiss so the status bar stays calm.
    clearTimeout(errorDismissTimer);
    if (message !== null) {
      errorDismissTimer = setTimeout(() => set({ lastError: null }), 6000);
    }
  },
}));

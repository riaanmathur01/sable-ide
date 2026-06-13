import { create } from "zustand";

/**
 * UI chrome state: which panels are visible, plus transient error
 * messages surfaced in the status bar.
 */
interface CursorPosition {
  line: number;
  column: number;
}

export type SidebarView = "files" | "search";

interface UiState {
  sidebarVisible: boolean;
  sidebarView: SidebarView;
  terminalVisible: boolean;
  lastError: string | null;
  cursorPosition: CursorPosition | null;
  /** Name of the connected language server, shown in the status bar. */
  lspStatus: string | null;
  toggleSidebar: () => void;
  setSidebarView: (view: SidebarView) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setLastError: (message: string | null) => void;
  setCursorPosition: (position: CursorPosition | null) => void;
  setLspStatus: (status: string | null) => void;
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
  toggleSidebar: () =>
    set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleTerminal: () =>
    set((state) => ({ terminalVisible: !state.terminalVisible })),
  setTerminalVisible: (visible) => set({ terminalVisible: visible }),
  setLastError: (message) => {
    set({ lastError: message });
    // Errors are transient: auto-dismiss so the status bar stays calm.
    clearTimeout(errorDismissTimer);
    if (message !== null) {
      errorDismissTimer = setTimeout(() => set({ lastError: null }), 6000);
    }
  },
}));

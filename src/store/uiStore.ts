import { create } from "zustand";

/**
 * UI chrome state: which panels are visible. Editor/tab and workspace
 * state will live in their own stores (added in later phases).
 */
interface UiState {
  sidebarVisible: boolean;
  terminalVisible: boolean;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarVisible: true,
  terminalVisible: false,
  toggleSidebar: () =>
    set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleTerminal: () =>
    set((state) => ({ terminalVisible: !state.terminalVisible })),
}));

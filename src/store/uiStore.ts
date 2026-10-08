import { create } from "zustand";

/**
 * UI chrome state: which panels are visible, plus transient error
 * messages surfaced in the status bar.
 */
interface CursorPosition {
  line: number;
  column: number;
}

export type SidebarView = "files" | "search" | "git" | "history" | "debug";
export type BottomPanel = "terminal" | "debug" | "problems" | "usages" | "hierarchy" | "tests";

/** Draggable panel sizes, in pixels. */
export interface PanelSizes {
  sidebarWidth: number;
  panelHeight: number;
  agentWidth: number;
}
export type PaletteMode =
  | "commands"
  | "files"
  /** File Structure (⌘F12): the current file's symbols. */
  | "structure"
  /** Go to Symbol (⌥⌘O / ⌘T): symbols across the project. */
  | "symbols"
  /** Search Everywhere (double Shift): files, symbols and commands. */
  | "everywhere"
  /** Recent Files (⌘E). */
  | "recentFiles"
  /** Recent Locations (⇧⌘E). */
  | "recentLocations";

/** What the status bar shows about the active editor. */
export interface EditorInfo {
  language: string;
  tabSize: number;
  insertSpaces: boolean;
}

interface UiState {
  sidebarVisible: boolean;
  sidebarView: SidebarView;
  terminalVisible: boolean;
  lastError: string | null;
  /** Transient non-error notice (e.g. "Installed requests"). */
  statusMessage: string | null;
  showStatus: (message: string) => void;
  cursorPosition: CursorPosition | null;
  editorInfo: EditorInfo | null;
  setEditorInfo: (info: EditorInfo | null) => void;
  /** Name of the connected language server, shown in the status bar. */
  /** Each language server's status label ("gopls", "Java (jdtls)…"),
   *  by server id; the status bar shows the active file's. */
  lspStatus: Record<string, string>;
  /** Open command/quick-open palette, or null when closed. */
  paletteMode: PaletteMode | null;
  /** Whether git blame annotations are shown in the editor. */
  blameEnabled: boolean;
  /** Which tab the bottom panel shows (terminal or debug console). */
  bottomPanel: BottomPanel;
  /** Right-hand AI agent panel. */
  agentVisible: boolean;
  /** Bumped to ask the agent input to take focus. */
  agentFocusRequest: number;
  panelSizes: PanelSizes;
  toggleSidebar: () => void;
  setSidebarView: (view: SidebarView) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setLastError: (message: string | null) => void;
  setCursorPosition: (position: CursorPosition | null) => void;
  /** Set (or with null, clear) one server's label; no id clears all. */
  setLspStatus: (serverId: string | null, status: string | null) => void;
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
  toggleBlame: () => void;
  setBottomPanel: (panel: BottomPanel) => void;
  toggleAgent: () => void;
  /** Open the agent panel and focus its input. */
  focusAgent: () => void;
  setPanelSize: (key: keyof PanelSizes, size: number) => void;
}

const PANEL_SIZES_KEY = "sable.panelSizes";
const AGENT_VISIBLE_KEY = "sable.agentVisible";
const DEFAULT_PANEL_SIZES: PanelSizes = {
  sidebarWidth: 240,
  panelHeight: 240,
  agentWidth: 380,
};

/** Clamp ranges for each draggable size. */
export const PANEL_SIZE_LIMITS: Record<keyof PanelSizes, [number, number]> = {
  sidebarWidth: [170, 600],
  panelHeight: [100, 900],
  agentWidth: [280, 900],
};

function loadPanelSizes(): PanelSizes {
  try {
    const raw = localStorage.getItem(PANEL_SIZES_KEY);
    if (raw) return { ...DEFAULT_PANEL_SIZES, ...JSON.parse(raw) };
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_PANEL_SIZES;
}

/** Persisted across launches so the terminal panel reopens if it was open. */
const TERMINAL_VISIBLE_KEY = "sable.terminalVisible";

export function lastTerminalVisible(): boolean {
  return localStorage.getItem(TERMINAL_VISIBLE_KEY) === "true";
}

let errorDismissTimer: ReturnType<typeof setTimeout> | undefined;
let statusDismissTimer: ReturnType<typeof setTimeout> | undefined;

export const useUiStore = create<UiState>((set) => ({
  sidebarVisible: true,
  sidebarView: "files",
  setSidebarView: (view) =>
    set({ sidebarView: view, sidebarVisible: true }),
  terminalVisible: false,
  lastError: null,
  statusMessage: null,
  showStatus: (message) => {
    set({ statusMessage: message });
    clearTimeout(statusDismissTimer);
    statusDismissTimer = setTimeout(() => set({ statusMessage: null }), 5000);
  },
  cursorPosition: null,
  setCursorPosition: (position) => set({ cursorPosition: position }),
  editorInfo: null,
  setEditorInfo: (info) => set({ editorInfo: info }),
  lspStatus: {},
  setLspStatus: (serverId, status) =>
    set((state) => {
      if (serverId === null) return { lspStatus: {} };
      const lspStatus = { ...state.lspStatus };
      if (status === null) delete lspStatus[serverId];
      else lspStatus[serverId] = status;
      return { lspStatus };
    }),
  paletteMode: null,
  openPalette: (mode) => set({ paletteMode: mode }),
  closePalette: () => set({ paletteMode: null }),
  blameEnabled: false,
  toggleBlame: () => set((state) => ({ blameEnabled: !state.blameEnabled })),
  bottomPanel: "terminal",
  setBottomPanel: (panel) => {
    localStorage.setItem(TERMINAL_VISIBLE_KEY, "true");
    set({ bottomPanel: panel, terminalVisible: true });
  },
  agentVisible: localStorage.getItem(AGENT_VISIBLE_KEY) === "true",
  agentFocusRequest: 0,
  toggleAgent: () =>
    set((state) => {
      const agentVisible = !state.agentVisible;
      localStorage.setItem(AGENT_VISIBLE_KEY, String(agentVisible));
      return {
        agentVisible,
        agentFocusRequest: agentVisible
          ? state.agentFocusRequest + 1
          : state.agentFocusRequest,
      };
    }),
  focusAgent: () => {
    localStorage.setItem(AGENT_VISIBLE_KEY, "true");
    set((state) => ({
      agentVisible: true,
      agentFocusRequest: state.agentFocusRequest + 1,
    }));
  },
  panelSizes: loadPanelSizes(),
  setPanelSize: (key, size) =>
    set((state) => {
      const [min, max] = PANEL_SIZE_LIMITS[key];
      const panelSizes = {
        ...state.panelSizes,
        [key]: Math.round(Math.min(max, Math.max(min, size))),
      };
      localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(panelSizes));
      return { panelSizes };
    }),
  toggleSidebar: () =>
    set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleTerminal: () =>
    set((state) => {
      // Panel open on another tab (debug console) → switch to the
      // terminal rather than closing.
      if (state.terminalVisible && state.bottomPanel !== "terminal") {
        return { bottomPanel: "terminal" };
      }
      const terminalVisible = !state.terminalVisible;
      localStorage.setItem(TERMINAL_VISIBLE_KEY, String(terminalVisible));
      return { terminalVisible, bottomPanel: "terminal" };
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

import { create } from "zustand";
import { getEditor, pathFromUri, revealPosition } from "../lib/editorRegistry";
import {
  callHierarchyCalls,
  findUsages,
  goToLocations,
  linePreviews,
  prepareCallHierarchy,
  serverSupports,
  type CallHierarchyItem,
} from "../lib/lsp/navigation";
import { useTabsStore } from "./tabsStore";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Navigation state: Find Usages results, the call hierarchy tree, and
 * the recent files / recent locations lists (⌘E / ⇧⌘E), which are kept
 * per project across launches.
 */

export interface Usage {
  path: string;
  line: number;
  column: number;
  endColumn: number;
  /** The line's text, for the results list. */
  preview: string;
}

export interface UsagesResult {
  /** The symbol searched for. */
  symbol: string;
  usages: Usage[];
}

export interface HierarchyNode {
  id: string;
  item: CallHierarchyItem;
  /** Undefined until expanded and loaded. */
  children?: HierarchyNode[];
  expanded: boolean;
  loading: boolean;
}

export interface RecentLocation {
  path: string;
  line: number;
  column: number;
  preview: string;
}

const MAX_RECENT = 50;
/** Back/Forward history length. */
const MAX_HISTORY = 100;
/** A cursor move of more than this many lines is a jump (a new place). */
const JUMP_LINES = 10;
/** Set while Back/Forward moves the cursor, so the move isn't recorded. */
let navigatingHistory = false;

export interface Place {
  path: string;
  line: number;
  column: number;
}
let nodeId = 0;

/** Where the cursor is in the focused editor. */
export function cursorContext(): { path: string; position: { lineNumber: number; column: number }; word: string } | null {
  const editor = getEditor();
  const model = editor?.getModel();
  const position = editor?.getPosition();
  if (!editor || !model || !position) return null;
  return {
    path: pathFromUri(model.uri),
    position,
    word: model.getWordAtPosition(position)?.word ?? "",
  };
}

/** Open a file at a position (1-based). */
export async function goTo(path: string, line: number, column = 1): Promise<void> {
  await useTabsStore.getState().openFile(path);
  revealPosition(path, line, column);
}

interface NavigationState {
  usages: UsagesResult | null;
  usagesLoading: boolean;
  hierarchy: { direction: "incoming" | "outgoing"; roots: HierarchyNode[] } | null;
  recentFiles: string[];
  recentLocations: RecentLocation[];

  /** Find Usages (⌥F7) of the symbol at the cursor. */
  findUsagesAtCursor: () => Promise<void>;
  /** Go to Implementation (⌥⌘B) / Type Declaration (⇧⌘B). */
  goToAtCursor: (kind: "implementation" | "typeDefinition") => Promise<void>;
  /** Call Hierarchy (⌃⌥H) of the function at the cursor. */
  showCallHierarchy: (direction?: "incoming" | "outgoing") => Promise<void>;
  setHierarchyDirection: (direction: "incoming" | "outgoing") => Promise<void>;
  toggleHierarchyNode: (id: string) => Promise<void>;
  clearUsages: () => void;
  clearHierarchy: () => void;

  /** Back/Forward history and the current entry in it. */
  history: Place[];
  historyIndex: number;
  /** Called on every cursor move; jumps become new history entries. */
  recordPosition: (place: Place) => void;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;

  recordFile: (path: string) => void;
  recordLocation: (location: RecentLocation) => void;
  loadRecent: (root: string | null) => void;
}

const storageKey = (root: string) => `sable.recent:${root}`;

function persist(state: Pick<NavigationState, "recentFiles" | "recentLocations">) {
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) return;
  try {
    localStorage.setItem(
      storageKey(root),
      JSON.stringify({ files: state.recentFiles, locations: state.recentLocations }),
    );
  } catch {
    /* storage unavailable — recent lists just won't survive a restart */
  }
}

function mapNodes(nodes: HierarchyNode[], id: string, update: (node: HierarchyNode) => HierarchyNode): HierarchyNode[] {
  return nodes.map((node) =>
    node.id === id
      ? update(node)
      : node.children
        ? { ...node, children: mapNodes(node.children, id, update) }
        : node,
  );
}

function findNode(nodes: HierarchyNode[], id: string): HierarchyNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children && findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

const newNode = (item: CallHierarchyItem): HierarchyNode => ({
  id: String(++nodeId),
  item,
  expanded: false,
  loading: false,
});

/** A message when the focused file's language server can't do something. */
function unsupported(path: string, feature: string): boolean {
  const capability: Record<string, string> = {
    usages: "referencesProvider",
    implementation: "implementationProvider",
    typeDefinition: "typeDefinitionProvider",
    hierarchy: "callHierarchyProvider",
  };
  if (serverSupports(path, capability[feature])) return false;
  useUiStore
    .getState()
    .showStatus("This needs a language server for this file's language (Python, JS/TS, Java, Go, Rust or C/C++)");
  return true;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  usages: null,
  usagesLoading: false,
  hierarchy: null,
  recentFiles: [],
  recentLocations: [],

  findUsagesAtCursor: async () => {
    const context = cursorContext();
    if (!context || unsupported(context.path, "usages")) return;
    set({ usagesLoading: true, usages: { symbol: context.word, usages: [] } });
    useUiStore.getState().setBottomPanel("usages");
    try {
      const locations = await findUsages(context.path, context.position);
      const previews = await linePreviews(locations);
      set({
        usages: {
          symbol: context.word,
          usages: locations.map((location) => ({
            path: location.path,
            line: location.line,
            column: location.column,
            endColumn: location.endLine === location.line ? location.endColumn : location.column,
            preview: previews.get(location.path)?.[location.line - 1] ?? "",
          })),
        },
      });
    } finally {
      set({ usagesLoading: false });
    }
  },

  goToAtCursor: async (kind) => {
    const context = cursorContext();
    if (!context || unsupported(context.path, kind)) return;
    const locations = await goToLocations(
      kind === "implementation" ? "textDocument/implementation" : "textDocument/typeDefinition",
      context.path,
      context.position,
    );
    if (locations.length === 0) {
      useUiStore.getState().showStatus(kind === "implementation" ? "No implementations found" : "No type declaration found");
    } else if (locations.length === 1) {
      await goTo(locations[0].path, locations[0].line, locations[0].column);
    } else {
      // Several: list them like Find Usages.
      const previews = await linePreviews(locations);
      set({
        usages: {
          symbol: `${context.word} — ${kind === "implementation" ? "implementations" : "type declarations"}`,
          usages: locations.map((location) => ({
            path: location.path,
            line: location.line,
            column: location.column,
            endColumn: location.endLine === location.line ? location.endColumn : location.column,
            preview: previews.get(location.path)?.[location.line - 1] ?? "",
          })),
        },
      });
      useUiStore.getState().setBottomPanel("usages");
    }
  },

  showCallHierarchy: async (direction = "incoming") => {
    const context = cursorContext();
    if (!context || unsupported(context.path, "hierarchy")) return;
    const roots = await prepareCallHierarchy(context.path, context.position);
    if (roots.length === 0) {
      useUiStore.getState().showStatus("Put the cursor on a function or method to see its call hierarchy");
      return;
    }
    set({ hierarchy: { direction, roots: roots.map(newNode) } });
    useUiStore.getState().setBottomPanel("hierarchy");
    // Show the first level straight away.
    for (const root of get().hierarchy!.roots) await get().toggleHierarchyNode(root.id);
  },

  setHierarchyDirection: async (direction) => {
    const hierarchy = get().hierarchy;
    if (!hierarchy || hierarchy.direction === direction) return;
    set({ hierarchy: { direction, roots: hierarchy.roots.map((root) => newNode(root.item)) } });
    for (const root of get().hierarchy!.roots) await get().toggleHierarchyNode(root.id);
  },

  toggleHierarchyNode: async (id) => {
    const hierarchy = get().hierarchy;
    const node = hierarchy && findNode(hierarchy.roots, id);
    if (!hierarchy || !node) return;
    if (node.expanded) {
      set({ hierarchy: { ...hierarchy, roots: mapNodes(hierarchy.roots, id, (n) => ({ ...n, expanded: false })) } });
      return;
    }
    if (node.children) {
      set({ hierarchy: { ...hierarchy, roots: mapNodes(hierarchy.roots, id, (n) => ({ ...n, expanded: true })) } });
      return;
    }
    set({ hierarchy: { ...hierarchy, roots: mapNodes(hierarchy.roots, id, (n) => ({ ...n, loading: true })) } });
    const calls = await callHierarchyCalls(node.item, hierarchy.direction);
    const current = get().hierarchy;
    if (!current || current.direction !== hierarchy.direction) return;
    set({
      hierarchy: {
        ...current,
        roots: mapNodes(current.roots, id, (n) => ({
          ...n,
          loading: false,
          expanded: true,
          children: calls.map(newNode),
        })),
      },
    });
  },

  clearUsages: () => set({ usages: null }),
  clearHierarchy: () => set({ hierarchy: null }),

  history: [],
  historyIndex: -1,

  recordPosition: (place) => {
    if (navigatingHistory) return;
    const { history, historyIndex } = get();
    const current = history[historyIndex];
    if (current && current.path === place.path && Math.abs(current.line - place.line) <= JUMP_LINES) {
      // Still the same place: follow the cursor within it.
      const updated = [...history];
      updated[historyIndex] = place;
      set({ history: updated });
      return;
    }
    // A jump: drop any Forward entries, then add the new place.
    const next = [...history.slice(0, historyIndex + 1), place].slice(-MAX_HISTORY);
    set({ history: next, historyIndex: next.length - 1 });
  },

  goBack: async () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    await navigateHistory(history[historyIndex - 1], historyIndex - 1);
  },

  goForward: async () => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    await navigateHistory(history[historyIndex + 1], historyIndex + 1);
  },

  recordFile: (path) => {
    const recentFiles = [path, ...get().recentFiles.filter((existing) => existing !== path)].slice(0, MAX_RECENT);
    set({ recentFiles });
    persist(get());
  },

  recordLocation: (location) => {
    // A new spot replaces any nearby one in the same file (JetBrains
    // keeps one entry per place, not one per cursor move).
    const rest = get().recentLocations.filter(
      (existing) => !(existing.path === location.path && Math.abs(existing.line - location.line) <= 5),
    );
    set({ recentLocations: [location, ...rest].slice(0, MAX_RECENT) });
    persist(get());
  },

  loadRecent: (root) => {
    if (!root) {
      set({ recentFiles: [], recentLocations: [] });
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(root)) ?? "{}") as {
        files?: string[];
        locations?: RecentLocation[];
      };
      set({ recentFiles: saved.files ?? [], recentLocations: saved.locations ?? [] });
    } catch {
      set({ recentFiles: [], recentLocations: [] });
    }
  },
}));

// Recent lists belong to a project: reload them when the folder changes.
useNavigationStore.getState().loadRecent(useWorkspaceStore.getState().rootPath);
useWorkspaceStore.subscribe((state, previous) => {
  if (state.rootPath !== previous.rootPath) useNavigationStore.getState().loadRecent(state.rootPath);
});

/** Move to a history entry without recording the move as a new one. */
async function navigateHistory(place: Place, index: number) {
  navigatingHistory = true;
  useNavigationStore.setState({ historyIndex: index });
  try {
    await goTo(place.path, place.line, place.column);
    // The editor reports the move a frame or two later.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    navigatingHistory = false;
  }
}

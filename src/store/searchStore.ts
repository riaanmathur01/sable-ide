import { create } from "zustand";
import { searchWorkspace, type SearchMatch } from "../lib/ipc";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/**
 * Project-wide search state. Matches stream in from Rust in batches;
 * events tagged with a stale search id are ignored, so fast retyping
 * never interleaves results from different queries.
 */
interface SearchStoreState {
  query: string;
  activeSearchId: number | null;
  matches: SearchMatch[];
  isSearching: boolean;
  limitHit: boolean;
  setQuery: (query: string) => void;
  runSearch: () => Promise<void>;
  receiveBatch: (searchId: number, batch: SearchMatch[]) => void;
  finishSearch: (searchId: number, limitHit: boolean) => void;
}

let searchIdCounter = 0;
function nextSearchId(): number {
  searchIdCounter += 1;
  return searchIdCounter;
}

export const useSearchStore = create<SearchStoreState>((set, get) => ({
  query: "",
  activeSearchId: null,
  matches: [],
  isSearching: false,
  limitHit: false,

  setQuery: (query) => set({ query }),

  runSearch: async () => {
    const rootPath = useWorkspaceStore.getState().rootPath;
    const { query } = get();
    if (!rootPath) return;
    // The id is minted here and set *before* invoking Rust: result
    // batches can arrive faster than the invoke promise resolves, and
    // they must not be mistaken for a stale search.
    const searchId = nextSearchId();
    set({
      activeSearchId: searchId,
      matches: [],
      isSearching: query.trim().length > 0,
      limitHit: false,
    });
    try {
      await searchWorkspace(rootPath, query, searchId);
    } catch (error) {
      set({ isSearching: false });
      useUiStore.getState().setLastError(String(error));
    }
  },

  receiveBatch: (searchId, batch) => {
    if (searchId !== get().activeSearchId) return; // stale search
    set((state) => ({ matches: [...state.matches, ...batch] }));
  },

  finishSearch: (searchId, limitHit) => {
    if (searchId !== get().activeSearchId) return;
    set({ isSearching: false, limitHit });
  },
}));

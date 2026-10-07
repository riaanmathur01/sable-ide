import { create } from "zustand";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { filesWithMatches, searchWorkspace, type SearchMatch } from "../lib/ipc";
import { replaceInText, type SearchOptions } from "../lib/replace";
import { readCurrentText, writeFileContents } from "../lib/fileContents";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/**
 * Project-wide search and replace. Matches stream in from Rust in
 * batches; events tagged with a stale search id are ignored, so fast
 * retyping never interleaves results from different queries.
 *
 * Replacing edits files the way the editor sees them (lib/fileContents):
 * open files change through their model (undoable with ⌘Z, unsaved edits
 * respected), others on disk.
 */
interface SearchStoreState {
  query: string;
  replacement: string;
  /** Whether the replace field is shown. */
  showReplace: boolean;
  /** Match Case toggle: on = case-sensitive, off = smart case. */
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  activeSearchId: number | null;
  matches: SearchMatch[];
  isSearching: boolean;
  limitHit: boolean;
  /** Invalid regex etc. — shown under the input instead of results. */
  error: string | null;
  isReplacing: boolean;
  setQuery: (query: string) => void;
  setReplacement: (replacement: string) => void;
  toggleReplace: () => void;
  toggleOption: (option: "matchCase" | "wholeWord" | "useRegex") => void;
  runSearch: () => Promise<void>;
  receiveBatch: (searchId: number, batch: SearchMatch[]) => void;
  finishSearch: (searchId: number, limitHit: boolean) => void;
  /** Replace in every matching file in the workspace (asks first). */
  replaceAll: () => Promise<void>;
  /** Replace every match in one file. */
  replaceInFile: (path: string) => Promise<void>;
  /** Replace the matches on one line of one file. */
  replaceInLine: (path: string, lineNumber: number) => Promise<void>;
  reset: () => void;
}

let searchIdCounter = 0;
function nextSearchId(): number {
  searchIdCounter += 1;
  return searchIdCounter;
}

export const useSearchStore = create<SearchStoreState>((set, get) => {
  function options(): SearchOptions {
    const { matchCase, wholeWord, useRegex } = get();
    return { caseSensitive: matchCase ? true : null, wholeWord, isRegex: useRegex };
  }

  /** Replace in one file; returns how many matches changed. */
  async function replaceFile(path: string, onlyLine?: number): Promise<number> {
    const { query, replacement } = get();
    const before = await readCurrentText(path);
    if (before === null) return 0;
    const { text, count } = replaceInText(before, query, replacement, options(), onlyLine);
    if (count > 0 && text !== before) await writeFileContents(path, text);
    return count;
  }

  async function guarded(work: () => Promise<void>) {
    if (get().isReplacing) return;
    set({ isReplacing: true });
    try {
      await work();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    } finally {
      set({ isReplacing: false });
      // Results are stale now.
      void get().runSearch();
    }
  }

  return {
    query: "",
    replacement: "",
    showReplace: false,
    matchCase: false,
    wholeWord: false,
    useRegex: false,
    activeSearchId: null,
    matches: [],
    isSearching: false,
    limitHit: false,
    error: null,
    isReplacing: false,

    setQuery: (query) => set({ query }),
    setReplacement: (replacement) => set({ replacement }),
    toggleReplace: () => set((state) => ({ showReplace: !state.showReplace })),
    toggleOption: (option) => {
      set((state) => ({ [option]: !state[option] }) as Partial<SearchStoreState>);
      void get().runSearch();
    },

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
        error: null,
      });
      try {
        await searchWorkspace(rootPath, query, searchId, options());
      } catch (error) {
        // Most likely an invalid regex while typing — show it inline.
        set({ isSearching: false, error: String(error) });
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

    replaceAll: () =>
      guarded(async () => {
        const root = useWorkspaceStore.getState().rootPath;
        const { query, replacement } = get();
        if (!root || !query) return;
        // Every matching file — not just the (capped) result list.
        const files = await filesWithMatches(root, query, options());
        if (files.length === 0) return;
        const confirmed = await confirmNative(
          `Replace all matches of “${query}” with “${replacement}” in ${files.length} file${files.length === 1 ? "" : "s"}?`,
          { title: "Replace All", kind: "warning" },
        );
        if (!confirmed) return;
        let total = 0;
        for (const file of files) total += await replaceFile(file);
        useUiStore
          .getState()
          .showStatus(`Replaced ${total} match${total === 1 ? "" : "es"} in ${files.length} file${files.length === 1 ? "" : "s"}`);
      }),

    replaceInFile: (path) =>
      guarded(async () => {
        const count = await replaceFile(path);
        useUiStore.getState().showStatus(`Replaced ${count} match${count === 1 ? "" : "es"}`);
      }),

    replaceInLine: (path, lineNumber) =>
      guarded(async () => {
        await replaceFile(path, lineNumber);
      }),

    reset: () =>
      set({
        query: "",
        activeSearchId: null,
        matches: [],
        isSearching: false,
        limitHit: false,
        error: null,
      }),
  };
});

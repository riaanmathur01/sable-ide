import { create } from "zustand";

/**
 * Editor breakpoints, keyed by absolute file path → sorted 1-based line
 * numbers.
 *
 *   - Saved per workspace (localStorage — a small list of paths/lines) and
 *     restored when the folder reopens.
 *   - They move with edits: while a file is open, the editor tracks each
 *     breakpoint as a decoration (which Monaco shifts as lines are added
 *     or removed) and reports the new lines back via `setLines`.
 *   - They follow renames/moves (`remapPath`) and disappear with deleted
 *     files (`removeUnder`).
 */
interface BreakpointsState {
  breakpointsByFile: Record<string, number[]>;
  toggle: (file: string, line: number) => void;
  /** Replace a file's lines (editor tracking). */
  setLines: (file: string, lines: number[]) => void;
  /** A file or folder moved: carry its breakpoints along. */
  remapPath: (oldPath: string, newPath: string) => void;
  /** A file or folder was deleted. */
  removeUnder: (path: string) => void;
  clearAll: () => void;
  /** Load the breakpoints saved for a workspace (null = none open). */
  loadWorkspace: (root: string | null) => void;
}

const STORAGE_PREFIX = "sable.breakpoints:";
/** The workspace whose breakpoints are loaded (saves go there). */
let workspaceRoot: string | null = null;

function isSameOrInside(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`);
}

/** Sorted, de-duplicated, positive line numbers. */
function normalize(lines: number[]): number[] {
  return [...new Set(lines.filter((line) => Number.isInteger(line) && line > 0))].sort(
    (a, b) => a - b,
  );
}

function withFile(
  all: Record<string, number[]>,
  file: string,
  lines: number[],
): Record<string, number[]> {
  const next = { ...all };
  if (lines.length > 0) next[file] = lines;
  else delete next[file];
  return next;
}

export const useBreakpointsStore = create<BreakpointsState>((set) => ({
  breakpointsByFile: {},

  toggle: (file, line) =>
    set((state) => {
      const current = state.breakpointsByFile[file] ?? [];
      const next = current.includes(line)
        ? current.filter((existing) => existing !== line)
        : normalize([...current, line]);
      return { breakpointsByFile: withFile(state.breakpointsByFile, file, next) };
    }),

  setLines: (file, lines) =>
    set((state) => {
      const next = normalize(lines);
      const current = state.breakpointsByFile[file] ?? [];
      if (next.length === current.length && next.every((line, index) => line === current[index])) {
        return state; // unchanged — skip the re-render (and the decoration rebuild)
      }
      return { breakpointsByFile: withFile(state.breakpointsByFile, file, next) };
    }),

  remapPath: (oldPath, newPath) =>
    set((state) => {
      let changed = false;
      const breakpointsByFile: Record<string, number[]> = {};
      for (const [file, lines] of Object.entries(state.breakpointsByFile)) {
        if (isSameOrInside(file, oldPath)) {
          breakpointsByFile[newPath + file.slice(oldPath.length)] = lines;
          changed = true;
        } else {
          breakpointsByFile[file] = lines;
        }
      }
      return changed ? { breakpointsByFile } : state;
    }),

  removeUnder: (path) =>
    set((state) => {
      const kept = Object.entries(state.breakpointsByFile).filter(
        ([file]) => !isSameOrInside(file, path),
      );
      return kept.length === Object.keys(state.breakpointsByFile).length
        ? state
        : { breakpointsByFile: Object.fromEntries(kept) };
    }),

  clearAll: () => set({ breakpointsByFile: {} }),

  loadWorkspace: (root) => {
    workspaceRoot = root;
    let breakpointsByFile: Record<string, number[]> = {};
    if (root) {
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + root);
        if (raw) {
          for (const [file, lines] of Object.entries(JSON.parse(raw) as Record<string, number[]>)) {
            const clean = normalize(Array.isArray(lines) ? lines : []);
            if (clean.length > 0) breakpointsByFile[file] = clean;
          }
        }
      } catch {
        breakpointsByFile = {};
      }
    }
    set({ breakpointsByFile });
  },
}));

// Persist every change for the current workspace.
useBreakpointsStore.subscribe((state, previous) => {
  if (!workspaceRoot || state.breakpointsByFile === previous.breakpointsByFile) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + workspaceRoot, JSON.stringify(state.breakpointsByFile));
  } catch {
    /* storage full/unavailable — breakpoints just won't persist */
  }
});

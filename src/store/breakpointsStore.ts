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
/** What a breakpoint does beyond stopping (all optional). */
export interface BreakpointOptions {
  /** Stop only when this expression is true. */
  condition?: string;
  /** Stop on this hit (the adapter's syntax; e.g. "3", ">= 3"). */
  hitCondition?: string;
  /** A logpoint: print this ({expressions} interpolated), don't stop. */
  logMessage?: string;
}

interface BreakpointsState {
  breakpointsByFile: Record<string, number[]>;
  /** Options by file → line (only breakpoints that have any). */
  optionsByFile: Record<string, Record<number, BreakpointOptions>>;
  /** Set (or clear, with null) a breakpoint's options; adds the breakpoint. */
  setOptions: (file: string, line: number, options: BreakpointOptions | null) => void;
  /** The breakpoint editor (right-click in the gutter), if open. */
  editing: { file: string; line: number; x: number; y: number } | null;
  edit: (file: string, line: number, x: number, y: number) => void;
  closeEditor: () => void;
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
const OPTIONS_PREFIX = "sable.breakpointOptions:";

/** Options with empty fields removed; null when nothing's left. */
function cleanOptions(options: BreakpointOptions | null): BreakpointOptions | null {
  if (!options) return null;
  const clean: BreakpointOptions = {};
  for (const key of ["condition", "hitCondition", "logMessage"] as const) {
    const value = options[key]?.trim();
    if (value) clean[key] = value;
  }
  return Object.keys(clean).length ? clean : null;
}

function withLineOptions(
  all: Record<string, Record<number, BreakpointOptions>>,
  file: string,
  line: number,
  options: BreakpointOptions | null,
): Record<string, Record<number, BreakpointOptions>> {
  const forFile = { ...(all[file] ?? {}) };
  if (options) forFile[line] = options;
  else delete forFile[line];
  const next = { ...all };
  if (Object.keys(forFile).length) next[file] = forFile;
  else delete next[file];
  return next;
}

/** A file's breakpoints as DAP SourceBreakpoints. */
export function sourceBreakpoints(file: string): ({ line: number } & BreakpointOptions)[] {
  const { breakpointsByFile, optionsByFile } = useBreakpointsStore.getState();
  return (breakpointsByFile[file] ?? []).map((line) => ({ line, ...(optionsByFile[file]?.[line] ?? {}) }));
}
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
  optionsByFile: {},
  editing: null,

  toggle: (file, line) =>
    set((state) => {
      const current = state.breakpointsByFile[file] ?? [];
      const removing = current.includes(line);
      const next = removing ? current.filter((existing) => existing !== line) : normalize([...current, line]);
      return {
        breakpointsByFile: withFile(state.breakpointsByFile, file, next),
        optionsByFile: removing ? withLineOptions(state.optionsByFile, file, line, null) : state.optionsByFile,
      };
    }),

  setOptions: (file, line, options) =>
    set((state) => {
      const current = state.breakpointsByFile[file] ?? [];
      return {
        breakpointsByFile: current.includes(line)
          ? state.breakpointsByFile
          : withFile(state.breakpointsByFile, file, normalize([...current, line])),
        optionsByFile: withLineOptions(state.optionsByFile, file, line, cleanOptions(options)),
      };
    }),

  edit: (file, line, x, y) => set({ editing: { file, line, x, y } }),
  closeEditor: () => set({ editing: null }),

  setLines: (file, lines) =>
    set((state) => {
      const next = normalize(lines);
      const current = state.breakpointsByFile[file] ?? [];
      if (next.length === current.length && next.every((line, index) => line === current[index])) {
        return state; // unchanged — skip the re-render (and the decoration rebuild)
      }
      // Options move with their breakpoints: the tracked lines come back
      // in the same order, so match them up by position.
      const options = state.optionsByFile[file];
      let optionsByFile = state.optionsByFile;
      if (options) {
        const moved: Record<number, BreakpointOptions> = {};
        if (next.length === current.length) {
          current.forEach((line, index) => {
            if (options[line]) moved[next[index]] = options[line];
          });
        } else {
          for (const line of next) if (options[line]) moved[line] = options[line];
        }
        optionsByFile = { ...state.optionsByFile };
        if (Object.keys(moved).length) optionsByFile[file] = moved;
        else delete optionsByFile[file];
      }
      return { breakpointsByFile: withFile(state.breakpointsByFile, file, next), optionsByFile };
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
      if (!changed) return state;
      const optionsByFile: Record<string, Record<number, BreakpointOptions>> = {};
      for (const [file, options] of Object.entries(state.optionsByFile)) {
        optionsByFile[isSameOrInside(file, oldPath) ? newPath + file.slice(oldPath.length) : file] = options;
      }
      return { breakpointsByFile, optionsByFile };
    }),

  removeUnder: (path) =>
    set((state) => {
      const kept = Object.entries(state.breakpointsByFile).filter(
        ([file]) => !isSameOrInside(file, path),
      );
      return kept.length === Object.keys(state.breakpointsByFile).length
        ? state
        : {
            breakpointsByFile: Object.fromEntries(kept),
            optionsByFile: Object.fromEntries(
              Object.entries(state.optionsByFile).filter(([file]) => !isSameOrInside(file, path)),
            ),
          };
    }),

  clearAll: () => set({ breakpointsByFile: {}, optionsByFile: {} }),

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
    let optionsByFile: Record<string, Record<number, BreakpointOptions>> = {};
    if (root) {
      try {
        optionsByFile = JSON.parse(localStorage.getItem(OPTIONS_PREFIX + root) ?? "{}");
      } catch {
        optionsByFile = {};
      }
    }
    set({ breakpointsByFile, optionsByFile, editing: null });
  },
}));

// Persist every change for the current workspace.
useBreakpointsStore.subscribe((state, previous) => {
  if (!workspaceRoot) return;
  try {
    if (state.breakpointsByFile !== previous.breakpointsByFile) {
      localStorage.setItem(STORAGE_PREFIX + workspaceRoot, JSON.stringify(state.breakpointsByFile));
    }
    if (state.optionsByFile !== previous.optionsByFile) {
      localStorage.setItem(OPTIONS_PREFIX + workspaceRoot, JSON.stringify(state.optionsByFile));
    }
  } catch {
    /* storage full/unavailable — breakpoints just won't persist */
  }
});

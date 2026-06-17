import { create } from "zustand";

/**
 * Editor breakpoints, keyed by absolute file path → sorted 1-based line
 * numbers. In-memory for now (persistence is Stage E).
 */
interface BreakpointsState {
  breakpointsByFile: Record<string, number[]>;
  toggle: (file: string, line: number) => void;
}

export const useBreakpointsStore = create<BreakpointsState>((set) => ({
  breakpointsByFile: {},
  toggle: (file, line) =>
    set((state) => {
      const current = state.breakpointsByFile[file] ?? [];
      const next = current.includes(line)
        ? current.filter((existing) => existing !== line)
        : [...current, line].sort((a, b) => a - b);
      const breakpointsByFile = { ...state.breakpointsByFile };
      if (next.length > 0) {
        breakpointsByFile[file] = next;
      } else {
        delete breakpointsByFile[file];
      }
      return { breakpointsByFile };
    }),
}));

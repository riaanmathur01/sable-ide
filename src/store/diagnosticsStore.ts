import { create } from "zustand";

/**
 * Per-file error counts, fed by the language server's diagnostics. The
 * file tree reads this to mark files that currently have errors.
 *
 * Only files the server has analyzed appear here — i.e. files opened at
 * least once this session, since that's when `didOpen` is sent.
 */
interface DiagnosticsState {
  /** Absolute path → number of error-severity diagnostics (>0 only). */
  errorCountByPath: Record<string, number>;
  setFileErrorCount: (path: string, count: number) => void;
}

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  errorCountByPath: {},
  setFileErrorCount: (path, count) =>
    set((state) => {
      const current = state.errorCountByPath[path] ?? 0;
      if (current === count) return state; // no change — skip re-render
      const errorCountByPath = { ...state.errorCountByPath };
      if (count > 0) {
        errorCountByPath[path] = count;
      } else {
        delete errorCountByPath[path];
      }
      return { errorCountByPath };
    }),
}));

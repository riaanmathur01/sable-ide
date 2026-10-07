import { create } from "zustand";
import type { LspDiagnostic } from "../lib/editorRegistry";

/**
 * Every error/warning in the workspace, for the Problems panel and the
 * status-bar counts. Two sources, merged per file:
 *   - Monaco's markers for files with a model (open files). These cover
 *     everything drawn as a squiggle: LSP diagnostics *and* Monaco's own
 *     language services (TypeScript, JSON, CSS, …).
 *   - Raw LSP diagnostics for files without a model — Pyright analyzes
 *     the whole workspace, so unopened files can have problems too.
 * Hints (e.g. "unused variable", drawn faded) are left out, as in VS Code.
 */

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  path: string;
  /** 1-based, like the editor. */
  line: number;
  column: number;
  severity: ProblemSeverity;
  message: string;
  source?: string;
  code?: string;
}

interface ProblemsState {
  lspByPath: Record<string, Problem[]>;
  /** Present only while the file has a Monaco model. */
  markersByPath: Record<string, Problem[]>;
  setLspDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void;
  /** `null` = the file no longer has a model. */
  setMarkers: (path: string, problems: Problem[] | null) => void;
  clear: () => void;
}

const SEVERITY_ORDER: Record<ProblemSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function lspSeverity(severity: number | undefined): ProblemSeverity | null {
  switch (severity ?? 1) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    default:
      return null; // hint
  }
}

function sortProblems(problems: Problem[]): Problem[] {
  return problems.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.line - b.line ||
      a.column - b.column,
  );
}

export const useProblemsStore = create<ProblemsState>((set) => ({
  lspByPath: {},
  markersByPath: {},

  setLspDiagnostics: (path, diagnostics) =>
    set((state) => {
      const problems: Problem[] = [];
      for (const diagnostic of diagnostics) {
        const severity = lspSeverity(diagnostic.severity);
        if (!severity) continue;
        problems.push({
          path,
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          severity,
          message: diagnostic.message,
          source: diagnostic.source,
          code: diagnostic.code != null ? String(diagnostic.code) : undefined,
        });
      }
      const lspByPath = { ...state.lspByPath };
      if (problems.length > 0) lspByPath[path] = sortProblems(problems);
      else delete lspByPath[path];
      return { lspByPath };
    }),

  setMarkers: (path, problems) =>
    set((state) => {
      const markersByPath = { ...state.markersByPath };
      if (problems === null) delete markersByPath[path];
      else markersByPath[path] = sortProblems(problems);
      return { markersByPath };
    }),

  clear: () => set({ lspByPath: {}, markersByPath: {} }),
}));

/** Merged problems per file (open files: live markers; others: LSP). */
export function mergeProblems(state: ProblemsState): Record<string, Problem[]> {
  const merged: Record<string, Problem[]> = { ...state.lspByPath };
  for (const [path, problems] of Object.entries(state.markersByPath)) {
    if (problems.length > 0) merged[path] = problems;
    else delete merged[path];
  }
  return merged;
}

function countSeverity(state: ProblemsState, severity: ProblemSeverity): number {
  let count = 0;
  for (const problems of Object.values(mergeProblems(state))) {
    for (const problem of problems) if (problem.severity === severity) count++;
  }
  return count;
}

/** Error/warning totals for the status bar (numbers, so re-renders only
 *  happen when a count actually changes). */
export function useProblemCounts(): { errors: number; warnings: number } {
  const errors = useProblemsStore((state) => countSeverity(state, "error"));
  const warnings = useProblemsStore((state) => countSeverity(state, "warning"));
  return { errors, warnings };
}

import { create } from "zustand";
import { coveragePercent, type FileCoverage } from "../lib/testing/coverage";

/**
 * The last coverage run: which lines ran, per file (shown in the editor
 * gutter while `visible`), and the overall percentage.
 */
interface CoverageState {
  byFile: Record<string, FileCoverage>;
  percent: number | null;
  visible: boolean;
  set: (files: FileCoverage[]) => void;
  hide: () => void;
}

export const useCoverageStore = create<CoverageState>((set) => ({
  byFile: {},
  percent: null,
  visible: false,
  set: (files) =>
    set({
      byFile: Object.fromEntries(files.map((file) => [file.file, file])),
      percent: coveragePercent(files),
      visible: true,
    }),
  hide: () => set({ visible: false, byFile: {}, percent: null }),
}));

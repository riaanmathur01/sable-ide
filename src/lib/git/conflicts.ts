/**
 * Git's conflict markers in a file. Pure (no I/O), so it can be unit-tested.
 *
 *   <<<<<<< ours-label
 *   ours
 *   ||||||| base-label      (only with merge.conflictStyle diff3/zdiff3)
 *   base
 *   =======
 *   theirs
 *   >>>>>>> theirs-label
 */

export interface Conflict {
  /** 1-based lines of the markers. */
  startLine: number;
  baseLine: number | null;
  separatorLine: number;
  endLine: number;
  ours: string[];
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

export type Resolution = "ours" | "theirs" | "both" | "none";

export function parseConflicts(lines: string[]): Conflict[] {
  const conflicts: Conflict[] = [];
  let open: { start: number; base: number | null; separator: number | null; label: string } | null = null;
  lines.forEach((line, index) => {
    const number = index + 1;
    if (line.startsWith("<<<<<<<") && (line.length === 7 || line[7] === " ")) {
      open = { start: number, base: null, separator: null, label: line.slice(8).trim() };
    } else if (open && open.separator === null && line.startsWith("|||||||") && (line.length === 7 || line[7] === " ")) {
      open.base = number;
    } else if (open && open.separator === null && line === "=======") {
      open.separator = number;
    } else if (open && open.separator !== null && line.startsWith(">>>>>>>") && (line.length === 7 || line[7] === " ")) {
      const oursEnd = open.base ?? open.separator;
      conflicts.push({
        startLine: open.start,
        baseLine: open.base,
        separatorLine: open.separator,
        endLine: number,
        ours: lines.slice(open.start, oursEnd - 1),
        base: open.base !== null ? lines.slice(open.base, open.separator - 1) : null,
        theirs: lines.slice(open.separator, number - 1),
        oursLabel: open.label,
        theirsLabel: line.slice(8).trim(),
      });
      open = null;
    }
  });
  return conflicts;
}

/** The lines that replace a conflict (markers included) for a choice. */
export function resolvedLines(conflict: Conflict, resolution: Resolution): string[] {
  switch (resolution) {
    case "ours":
      return conflict.ours;
    case "theirs":
      return conflict.theirs;
    case "both":
      return [...conflict.ours, ...conflict.theirs];
    case "none":
      return conflict.base ?? [];
  }
}

/** Resolve every conflict in the file the same way. */
export function resolveAll(lines: string[], resolution: Resolution): string[] {
  const conflicts = parseConflicts(lines);
  const result: string[] = [];
  let next = 1;
  for (const conflict of conflicts) {
    result.push(...lines.slice(next - 1, conflict.startLine - 1), ...resolvedLines(conflict, resolution));
    next = conflict.endLine + 1;
  }
  result.push(...lines.slice(next - 1));
  return result;
}

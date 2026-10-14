/**
 * Line diffs for the Refactoring Preview, and minimal LSP edits from
 * whole-file contents (so applying keeps open editors' cursors, folds and
 * undo sane).
 */

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
  /** Line number in the old (removed/context) or new (added) text, 1-based. */
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/** Longest-common-subsequence line diff (the changed middle only). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "context", text: a[i], oldLine: i + 1, newLine: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000) {
    // Too big to align: all of one, then all of the other.
    midA.forEach((text, i) => out.push({ kind: "removed", text, oldLine: start + i + 1 }));
    midB.forEach((text, i) => out.push({ kind: "added", text, newLine: start + i + 1 }));
  } else {
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: "context", text: midA[i], oldLine: start + i + 1, newLine: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
        // Removed lines before the lines replacing them.
        out.push({ kind: "removed", text: midA[i], oldLine: start + i + 1 });
        i++;
      } else {
        out.push({ kind: "added", text: midB[j], newLine: start + j + 1 });
        j++;
      }
    }
  }
  const tailA = endA;
  const tailB = endB;
  for (let k = 0; tailA + k < a.length; k++) {
    out.push({ kind: "context", text: a[tailA + k], oldLine: tailA + k + 1, newLine: tailB + k + 1 });
  }
  return out;
}

/** The changed lines with `context` lines around them, as hunks. */
export function hunks(before: string, after: string, context = 2): Hunk[] {
  const lines = diffLines(before, after);
  const changed = lines.flatMap((line, index) => (line.kind === "context" ? [] : [index]));
  const result: Hunk[] = [];
  let group: number[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const first = Math.max(group[0] - context, 0);
    const last = Math.min(group[group.length - 1] + context, lines.length - 1);
    const slice = lines.slice(first, last + 1);
    result.push({
      oldStart: slice.find((line) => line.oldLine !== undefined)?.oldLine ?? 1,
      newStart: slice.find((line) => line.newLine !== undefined)?.newLine ?? 1,
      lines: slice,
    });
    group = [];
  };
  for (const index of changed) {
    if (group.length > 0 && index - group[group.length - 1] > context * 2 + 1) flush();
    group.push(index);
  }
  flush();
  return result;
}

export function countChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffLines(before, after)) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { added, removed };
}

interface LspEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

/** Edits turning `before` into `after`: one per run of changed lines. */
export function minimalEdits(before: string, after: string): LspEdit[] {
  if (before === after) return [];
  const lines = diffLines(before, after);
  const edits: LspEdit[] = [];
  let index = 0;
  const oldLineCount = before.split("\n").length;
  while (index < lines.length) {
    if (lines[index].kind === "context") {
      index++;
      continue;
    }
    // The run of removed/added lines, and where it sits in the old text.
    let oldFrom = -1;
    const added: string[] = [];
    let removedCount = 0;
    // Old line the run starts at: the next context/removed line's old number.
    for (let k = index; k < lines.length; k++) {
      if (lines[k].oldLine !== undefined) {
        oldFrom = lines[k].oldLine! - 1;
        break;
      }
    }
    if (oldFrom < 0) oldFrom = oldLineCount;
    while (index < lines.length && lines[index].kind !== "context") {
      if (lines[index].kind === "added") added.push(lines[index].text);
      else removedCount++;
      index++;
    }
    const oldTo = oldFrom + removedCount; // exclusive
    if (oldTo < oldLineCount) {
      edits.push({
        range: { start: { line: oldFrom, character: 0 }, end: { line: oldTo, character: 0 } },
        newText: added.map((line) => line + "\n").join(""),
      });
    } else if (oldFrom > 0) {
      // Reaches the end: replace from the end of the line before.
      const oldLines = before.split("\n");
      edits.push({
        range: {
          start: { line: oldFrom - 1, character: oldLines[oldFrom - 1].length },
          end: { line: oldLineCount - 1, character: oldLines[oldLineCount - 1].length },
        },
        newText: added.map((line) => "\n" + line).join(""),
      });
    } else {
      const oldLines = before.split("\n");
      edits.push({
        range: { start: { line: 0, character: 0 }, end: { line: oldLineCount - 1, character: oldLines[oldLineCount - 1].length } },
        newText: added.join("\n"),
      });
    }
  }
  return edits;
}

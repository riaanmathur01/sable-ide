/**
 * Staging and unstaging single hunks. Pure (no I/O), so it can be unit-tested.
 *
 * A hunk is one of Monaco's diff line changes (what the diff view draws),
 * so what you click is exactly what's staged:
 *   - stage a hunk:   new index = the index with that change applied
 *                     (original = index, modified = working file);
 *   - unstage a hunk: new index = HEAD with every *other* staged change
 *                     applied (original = HEAD, modified = index).
 */

/** Monaco's ILineChange: 1-based, inclusive; an end of 0 means "none". */
export interface LineChange {
  /** For an insertion (originalEndLineNumber 0): the line it comes after. */
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  /** For a deletion (modifiedEndLineNumber 0): the line it comes after. */
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** The original text with just `changes` taken from the modified text. */
export function applyLineChanges(original: string[], modified: string[], changes: LineChange[]): string[] {
  const sorted = [...changes].sort((a, b) => a.originalStartLineNumber - b.originalStartLineNumber);
  const result: string[] = [];
  let next = 1; // the next original line to copy (1-based)
  for (const change of sorted) {
    const inserting = change.originalEndLineNumber === 0;
    const from = inserting ? change.originalStartLineNumber + 1 : change.originalStartLineNumber;
    const to = inserting ? change.originalStartLineNumber : change.originalEndLineNumber;
    result.push(...original.slice(next - 1, from - 1));
    if (change.modifiedEndLineNumber !== 0) {
      result.push(...modified.slice(change.modifiedStartLineNumber - 1, change.modifiedEndLineNumber));
    }
    next = to + 1;
  }
  result.push(...original.slice(next - 1));
  return result;
}

/** The index text after staging `hunk` of the unstaged diff. */
export function stageHunk(index: string[], working: string[], hunk: LineChange): string[] {
  return applyLineChanges(index, working, [hunk]);
}

/** The index text after unstaging `hunk` of the staged diff. */
export function unstageHunk(head: string[], index: string[], all: LineChange[], hunk: LineChange): string[] {
  return applyLineChanges(head, index, all.filter((change) => !sameChange(change, hunk)));
}

export function sameChange(a: LineChange, b: LineChange): boolean {
  return (
    a.originalStartLineNumber === b.originalStartLineNumber &&
    a.originalEndLineNumber === b.originalEndLineNumber &&
    a.modifiedStartLineNumber === b.modifiedStartLineNumber &&
    a.modifiedEndLineNumber === b.modifiedEndLineNumber
  );
}

/**
 * A plain line diff (longest common subsequence), as LineChanges — for
 * highlighting what each side of a merge changed. Quadratic, so callers
 * skip it for very large files.
 */
export function diffLines(original: string[], modified: string[]): LineChange[] {
  const n = original.length;
  const m = modified.length;
  // Trim the common start and end first: usually most of the file.
  let start = 0;
  while (start < n && start < m && original[start] === modified[start]) start++;
  let endOriginal = n;
  let endModified = m;
  while (endOriginal > start && endModified > start && original[endOriginal - 1] === modified[endModified - 1]) {
    endOriginal--;
    endModified--;
  }
  const a = original.slice(start, endOriginal);
  const b = modified.slice(start, endModified);
  // lengths[i][j]: LCS length of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const fromI = i;
    const fromJ = j;
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (j >= b.length || (i < a.length && lengths[i + 1][j] >= lengths[i][j + 1])) i++;
      else j++;
    }
    const removed = i - fromI;
    const added = j - fromJ;
    changes.push({
      originalStartLineNumber: start + (removed ? fromI + 1 : fromI),
      originalEndLineNumber: removed ? start + i : 0,
      modifiedStartLineNumber: start + (added ? fromJ + 1 : fromJ),
      modifiedEndLineNumber: added ? start + j : 0,
    });
  }
  return changes;
}

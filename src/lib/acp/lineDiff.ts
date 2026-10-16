import { applyLineChanges, type LineChange } from "../git/hunks";

/**
 * Line diffs for reviewing an agent's edits: Myers' O(ND) algorithm,
 * producing changes in Monaco's ILineChange shape (so the same hunk
 * helpers as the git diff view apply: lib/git/hunks.ts) and the rows a
 * diff card draws. Pure.
 */

export type { LineChange };

export const splitLines = (text: string): string[] => (text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Edit script between two line arrays, as Monaco-style line changes. */
export function diffLines(a: string[], b: string[]): LineChange[] {
  // Trim the common start and end: most edits are local.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = myers(a.slice(start, endA), b.slice(start, endB));
  // Group runs of deletions/insertions into changes.
  const changes: LineChange[] = [];
  let i = 0; // index into a (sliced)
  let j = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === "=") {
      i++;
      j++;
      k++;
      continue;
    }
    const fromA = i;
    const fromB = j;
    while (k < ops.length && ops[k] !== "=") {
      if (ops[k] === "-") i++;
      else j++;
      k++;
    }
    const deleted = i - fromA;
    const inserted = j - fromB;
    changes.push({
      originalStartLineNumber: deleted ? start + fromA + 1 : start + fromA,
      originalEndLineNumber: deleted ? start + i : 0,
      modifiedStartLineNumber: inserted ? start + fromB + 1 : start + fromB,
      modifiedEndLineNumber: inserted ? start + j : 0,
    });
  }
  return changes;
}

type Op = "=" | "-" | "+";

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array(m).fill("+");
  if (m === 0) return Array(n).fill("-");
  const max = n + m;
  // Very different large texts: one replacement (cheaper than a perfect diff).
  const limit = Math.min(max, 4000);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return [...Array(n).fill("-"), ...Array(m).fill("+")];
  // Walk back.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("+");
      y--;
    } else {
      ops.push("-");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x--;
    y--;
  }
  return ops.reverse();
}

export interface DiffRow {
  kind: "context" | "removed" | "added";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface Hunk {
  /** Indexes into the changes it shows. */
  changes: number[];
  rows: DiffRow[];
  oldStart: number;
  newStart: number;
}

/** Rows for a unified diff with `context` lines around each change. */
export function hunks(a: string[], b: string[], changes: LineChange[], context = 3): Hunk[] {
  const result: Hunk[] = [];
  let current: Hunk | null = null;
  let lastOld = 0; // last original line emitted
  let lastNew = 0;
  changes.forEach((change, index) => {
    const delStart = change.originalEndLineNumber ? change.originalStartLineNumber : change.originalStartLineNumber + 1;
    const delEnd = change.originalEndLineNumber || change.originalStartLineNumber;
    const addStart = change.modifiedEndLineNumber ? change.modifiedStartLineNumber : change.modifiedStartLineNumber + 1;
    const addEnd = change.modifiedEndLineNumber || change.modifiedStartLineNumber;
    const ctxFrom = Math.max(1, delStart - context);
    const offset = addStart - delStart; // new = old + offset before this change
    if (!current || ctxFrom > lastOld + 1) {
      if (current) {
        // Trailing context of the previous hunk.
        for (let line = lastOld + 1; line <= Math.min(a.length, lastOld + context); line++) {
          current.rows.push({ kind: "context", text: a[line - 1], oldLine: line, newLine: line + (lastNew - lastOld) });
        }
      }
      current = { changes: [], rows: [], oldStart: ctxFrom, newStart: ctxFrom + offset };
      result.push(current);
      lastOld = ctxFrom - 1;
      lastNew = lastOld + offset;
    }
    for (let line = lastOld + 1; line < delStart; line++) {
      current.rows.push({ kind: "context", text: a[line - 1], oldLine: line, newLine: line + offset });
    }
    for (let line = delStart; line <= delEnd; line++) current.rows.push({ kind: "removed", text: a[line - 1], oldLine: line, newLine: null });
    for (let line = addStart; line <= addEnd; line++) current.rows.push({ kind: "added", text: b[line - 1], oldLine: null, newLine: line });
    current.changes.push(index);
    lastOld = delEnd;
    lastNew = addEnd;
  });
  if (current) {
    const hunk: Hunk = current;
    for (let line = lastOld + 1; line <= Math.min(a.length, lastOld + context); line++) {
      hunk.rows.push({ kind: "context", text: a[line - 1], oldLine: line, newLine: line + (lastNew - lastOld) });
    }
  }
  return result;
}

/** Lines added and removed. */
export function diffStats(changes: LineChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.modifiedEndLineNumber) added += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
    if (change.originalEndLineNumber) removed += change.originalEndLineNumber - change.originalStartLineNumber + 1;
  }
  return { added, removed };
}

/** Keep one change: the new baseline (original with it applied). */
export function acceptChange(original: string[], current: string[], change: LineChange): string[] {
  return applyLineChanges(original, current, [change]);
}

/** Undo one change: the current text with every other change kept. */
export function rejectChange(original: string[], current: string[], all: LineChange[], change: LineChange): string[] {
  return applyLineChanges(original, current, all.filter((other) => other !== change));
}

/** Join lines back into text, keeping the trailing newline the file had. */
export function joinLines(lines: string[], like: string): string {
  const eol = like.includes("\r\n") ? "\r\n" : "\n";
  const trailing = like === "" ? lines.length > 0 : /\n$/.test(like);
  return lines.join(eol) + (trailing && lines.length ? eol : "");
}

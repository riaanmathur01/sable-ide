/**
 * Commit graph layout: which column ("lane") each commit sits in and the
 * line segments joining rows — for the History view. Pure, so it can be
 * unit-tested. Commits come newest first, children before parents.
 */

export interface GraphSegment {
  /** Columns at the start and end; y in row heights (0 top, 0.5 the
   *  commit's dot, 1 bottom). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Lane color index. */
  color: number;
}

export interface GraphRow {
  column: number;
  color: number;
  segments: GraphSegment[];
  /** Lanes still running below this row (for drawing through an
   *  expanded row's details). */
  lanesBelow: { column: number; color: number }[];
  /** How many columns this row needs. */
  width: number;
}

export function layoutGraph(commits: { hash: string; parents: string[] }[]): GraphRow[] {
  // lanes[i]: the commit lane i is waiting for (null: free).
  let lanes: (string | null)[] = [];
  // Each lane keeps its color while it lives.
  let colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const freeLane = () => {
    const index = lanes.indexOf(null);
    return index >= 0 ? index : lanes.length;
  };

  for (const commit of commits) {
    const segments: GraphSegment[] = [];
    let column = lanes.indexOf(commit.hash);
    const isTip = column < 0;
    if (isTip) {
      // A branch tip: a new lane.
      column = freeLane();
      lanes[column] = commit.hash;
      colors[column] = nextColor++;
    }
    const color = colors[column];

    // From above: lanes waiting for this commit merge into its dot;
    // others pass straight through.
    lanes.forEach((waiting, index) => {
      if (waiting === null) return;
      if (waiting === commit.hash) {
        // (A branch tip's own lane starts at its dot.)
        if (!(isTip && index === column)) segments.push({ x1: index, y1: 0, x2: column, y2: 0.5, color: colors[index] });
      } else {
        segments.push({ x1: index, y1: 0, x2: index, y2: 1, color: colors[index] });
      }
    });
    lanes = lanes.map((waiting, index) => (waiting === commit.hash && index !== column ? null : waiting));

    // Down to the parents: the first continues this lane; others join a
    // lane already waiting for them, or start one.
    const [first, ...others] = commit.parents;
    lanes[column] = first ?? null;
    if (first) segments.push({ x1: column, y1: 0.5, x2: column, y2: 1, color });
    for (const parent of others) {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = freeLane();
        lanes[target] = parent;
        colors[target] = nextColor++;
      }
      segments.push({ x1: column, y1: 0.5, x2: target, y2: 1, color: colors[target] });
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    colors = colors.slice(0, Math.max(lanes.length, colors.length));
    const lanesBelow = lanes.flatMap((waiting, index) => (waiting ? [{ column: index, color: colors[index] }] : []));
    const width = Math.max(column + 1, ...segments.flatMap((segment) => [segment.x1 + 1, segment.x2 + 1]), lanes.length);
    rows.push({ column, color, segments, lanesBelow, width });
  }
  return rows;
}

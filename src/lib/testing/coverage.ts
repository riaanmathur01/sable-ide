/**
 * Coverage reports, per file, as covered / partly covered / uncovered
 * lines. Pure, so it's unit-tested against the tools' real output.
 */

export interface FileCoverage {
  file: string;
  covered: number[];
  /** Some of the line's code ran, some didn't (a branch, a short-circuit). */
  partial: number[];
  uncovered: number[];
}

/** Lines → state, from (line, ran?) observations. */
function fromHits(file: string, hits: Iterable<[number, boolean]>): FileCoverage {
  const state = new Map<number, { ran: boolean; missed: boolean }>();
  for (const [line, ran] of hits) {
    const entry = state.get(line) ?? { ran: false, missed: false };
    if (ran) entry.ran = true;
    else entry.missed = true;
    state.set(line, entry);
  }
  const coverage: FileCoverage = { file, covered: [], partial: [], uncovered: [] };
  for (const [line, { ran, missed }] of [...state].sort((a, b) => a[0] - b[0])) {
    (ran && missed ? coverage.partial : ran ? coverage.covered : coverage.uncovered).push(line);
  }
  return coverage;
}

/** The share of lines that ran (partly covered counts as half). */
export function coveragePercent(files: FileCoverage[]): number | null {
  let total = 0;
  let ran = 0;
  for (const file of files) {
    total += file.covered.length + file.partial.length + file.uncovered.length;
    ran += file.covered.length + file.partial.length / 2;
  }
  return total ? Math.round((ran / total) * 1000) / 10 : null;
}

const isAbsolute = (path: string) => /^([/\\]|[A-Za-z]:)/.test(path);
const join = (dir: string, path: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}${path}`;

/** coverage.py's JSON report (pytest --cov-report=json). */
export function parseCoveragePy(json: string, baseDir: string): FileCoverage[] {
  const report = JSON.parse(json) as {
    files?: Record<string, { executed_lines?: number[]; missing_lines?: number[]; missing_branches?: [number, number][] }>;
  };
  return Object.entries(report.files ?? {}).map(([path, data]) => {
    const partialLines = new Set((data.missing_branches ?? []).map(([from]) => from));
    const hits: [number, boolean][] = [
      ...(data.executed_lines ?? []).flatMap((line): [number, boolean][] =>
        partialLines.has(line) ? [[line, true], [line, false]] : [[line, true]],
      ),
      ...(data.missing_lines ?? []).map((line): [number, boolean] => [line, false]),
    ];
    return fromHits(isAbsolute(path) ? path : join(baseDir, path), hits);
  });
}

/** Istanbul's coverage-final.json (Vitest, Jest): statements by line. */
export function parseIstanbul(json: string): FileCoverage[] {
  const report = JSON.parse(json) as Record<
    string,
    { path?: string; statementMap: Record<string, { start: { line: number } }>; s: Record<string, number> }
  >;
  return Object.entries(report).map(([path, data]) =>
    fromHits(
      data.path ?? path,
      Object.entries(data.statementMap).map(([id, location]): [number, boolean] => [location.start.line, (data.s[id] ?? 0) > 0]),
    ),
  );
}

/**
 * Go's coverprofile: "importpath/file.go:12.5,15.2 3 1" per block.
 * `dirs` maps import paths to directories (`go list`).
 */
export function parseGoCoverprofile(text: string, dirs: Map<string, string>): FileCoverage[] {
  const hitsByFile = new Map<string, [number, boolean][]>();
  for (const line of text.split("\n")) {
    const match = /^(.+)\/([^/]+\.go):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(line.trim());
    if (!match) continue;
    const [, importPath, name, start, end, count] = match;
    const dir = dirs.get(importPath);
    if (!dir) continue;
    const file = join(dir, name);
    const hits = hitsByFile.get(file) ?? [];
    for (let lineNumber = Number(start); lineNumber <= Number(end); lineNumber++) {
      hits.push([lineNumber, Number(count) > 0]);
    }
    hitsByFile.set(file, hits);
  }
  return [...hitsByFile].map(([file, hits]) => fromHits(file, hits));
}

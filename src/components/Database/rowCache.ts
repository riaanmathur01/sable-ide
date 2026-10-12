import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DbValue } from "../../lib/database/api";

/** One row in a grid: its cells, and its key (rowid or primary key) when editable. */
export interface GridRow {
  cells: DbValue[];
  key: DbValue[] | null;
}

/** Where a grid's rows come from: pages on demand. `id` changing starts over. */
export interface RowSource {
  id: string;
  fetch: (offset: number, limit: number, count: boolean) => Promise<{ rows: GridRow[]; total?: number }>;
}

export const PAGE_SIZE = 200;
/** Pages kept around (the rest are fetched again when scrolled back to). */
const MAX_PAGES = 40;

export interface RowCache {
  /** Rows in all (null until the first page arrives). */
  total: number | null;
  error: string | null;
  loading: boolean;
  /** Bumps whenever rows arrive or change (for re-rendering). */
  tick: number;
  getRow: (index: number) => GridRow | undefined;
  /** Make sure rows [start, end] are loaded (or loading). */
  ensure: (start: number, end: number) => void;
  /** Replace one loaded row (after an edit). */
  patchRow: (index: number, row: GridRow) => void;
  /** Rows [start, end) (loading what's missing), for copying. */
  fetchRange: (start: number, end: number) => Promise<GridRow[]>;
  /** How long the first page took (ms), for messages. */
  firstMs: number | null;
  /** The source whose first page (and count) is in. */
  readyId: string | null;
}

/**
 * A paged window onto a large result: rows load a page (200) at a time as
 * they come into view, and only the pages near the view are kept — so a
 * table of millions of rows scrolls like a small one.
 */
export function useRowCache(source: RowSource | null): RowCache {
  const pages = useRef(new Map<number, GridRow[]>());
  const pending = useRef(new Set<number>());
  const generation = useRef(0);
  const lastPage = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [firstMs, setFirstMs] = useState<number | null>(null);
  const [readyId, setReadyId] = useState<string | null>(null);

  const load = useCallback((page: number, count: boolean) => {
    const current = sourceRef.current;
    if (!current || pending.current.has(page)) return;
    pending.current.add(page);
    const mine = generation.current;
    const started = performance.now();
    current.fetch(page * PAGE_SIZE, PAGE_SIZE, count).then(
      (result) => {
        if (generation.current !== mine) return;
        pending.current.delete(page);
        pages.current.set(page, result.rows);
        if (count) {
          setTotal(result.total ?? result.rows.length);
          setFirstMs(performance.now() - started);
          setReadyId(current.id);
        }
        // Forget the pages furthest from where the user is.
        if (pages.current.size > MAX_PAGES) {
          const far = [...pages.current.keys()].sort((a, b) => Math.abs(b - lastPage.current) - Math.abs(a - lastPage.current));
          for (const drop of far.slice(0, pages.current.size - MAX_PAGES)) pages.current.delete(drop);
        }
        setError(null);
        setTick((value) => value + 1);
      },
      (failure) => {
        if (generation.current !== mine) return;
        pending.current.delete(page);
        setError(String(failure));
        if (count) {
          setTotal(0);
          setReadyId(current.id);
        }
        setTick((value) => value + 1);
      },
    );
  }, []);

  useEffect(() => {
    generation.current += 1;
    pages.current.clear();
    pending.current.clear();
    setTotal(null);
    setError(null);
    setFirstMs(null);
    setReadyId(null);
    setTick((value) => value + 1);
    if (source) load(0, true);
  }, [source?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensure = useCallback(
    (start: number, end: number) => {
      if (total === null) return;
      const first = Math.max(0, Math.floor(start / PAGE_SIZE));
      const last = Math.min(Math.floor(Math.max(0, total - 1) / PAGE_SIZE), Math.floor(end / PAGE_SIZE));
      lastPage.current = first;
      for (let page = first; page <= last; page++) {
        if (!pages.current.has(page)) load(page, false);
      }
    },
    [total, load],
  );

  const getRow = useCallback((index: number) => pages.current.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE], []);

  const patchRow = useCallback((index: number, row: GridRow) => {
    const page = pages.current.get(Math.floor(index / PAGE_SIZE));
    if (!page) return;
    page[index % PAGE_SIZE] = row;
    setTick((value) => value + 1);
  }, []);

  const fetchRange = useCallback(async (start: number, end: number) => {
    const current = sourceRef.current;
    if (!current) return [];
    const rows: GridRow[] = [];
    for (let offset = start; offset < end; ) {
      const page = Math.floor(offset / PAGE_SIZE);
      const cached = pages.current.get(page);
      if (cached) {
        const from = offset - page * PAGE_SIZE;
        const to = Math.min(cached.length, end - page * PAGE_SIZE);
        rows.push(...cached.slice(from, to));
        offset = page * PAGE_SIZE + to;
        if (to <= from) break;
        continue;
      }
      const limit = Math.min(5000, end - offset);
      const result = await current.fetch(offset, limit, false);
      rows.push(...result.rows);
      if (result.rows.length < limit) break;
      offset += limit;
    }
    return rows;
  }, []);

  return useMemo(
    () => ({ total, error, loading: total === null && !!source, tick, getRow, ensure, patchRow, fetchRange, firstMs, readyId }),
    [total, error, source, tick, getRow, ensure, patchRow, fetchRange, firstMs, readyId],
  );
}

/** A source over rows already in hand (a statement's results). */
export function staticSource(id: string, rows: GridRow[]): RowSource {
  return {
    id,
    fetch: async (offset, limit) => ({ rows: rows.slice(offset, offset + limit), total: rows.length }),
  };
}

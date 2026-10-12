import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Eraser, Eye, PanelRight, RefreshCw, Rows3, Search, Table2, Trash2, X } from "lucide-react";
import { db, type DbValue, type TableInfo } from "../../lib/database/api";
import { browsable, edited, toast, update, useDatabaseStore, type BrowseState } from "../../lib/database/databaseStore";
import { formatCount, isBlob, keyId, valueText } from "../../lib/database/values";
import { DataGrid, normalizeSelection, type GridColumn, type GridHandle, type Selection } from "./DataGrid";
import { useRowCache, type GridRow, type RowSource } from "./rowCache";
import { EditCellPane } from "./EditCellPane";

const EMPTY: BrowseState = { sort: null, filters: {}, search: "", widths: {} };

/** `value`, once it has settled for `delay` ms — at once when `key` (the table) changes. */
function useDebounced<T>(value: T, delay: number, key: unknown): T {
  const [settled, setSettled] = useState({ value, key });
  useEffect(() => {
    if (settled.key !== key) {
      setSettled({ value, key });
      return;
    }
    const timer = setTimeout(() => setSettled({ value, key }), delay);
    return () => clearTimeout(timer);
  }, [value, delay, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return settled.key === key ? settled.value : value;
}

/** The grid's columns for a table: types, keys, what can't be edited. */
export function gridColumns(table: TableInfo | undefined): GridColumn[] {
  if (!table) return [];
  const single = new Map<string, { table: string; column: string | null }>();
  const counts = new Map<number, number>();
  for (const key of table.foreignKeys) counts.set(key.id, (counts.get(key.id) ?? 0) + 1);
  for (const key of table.foreignKeys) if (counts.get(key.id) === 1) single.set(key.from, { table: key.table, column: key.to });
  return table.columns
    .filter((column) => column.hidden !== 1)
    .map((column) => ({
      name: column.name,
      type: column.type,
      pk: column.pk > 0,
      fk: single.get(column.name),
      readOnly: table.type === "view" || column.hidden >= 2,
    }));
}

/** Pick a table or view to browse. */
function TablePicker({ tables, value, onChange }: { tables: TableInfo[]; value: string | null; onChange: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const current = tables.find((table) => table.name === value);
  const shown = tables.filter((table) => table.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="db-picker" ref={root}>
      <button
        className="db-picker-button"
        onClick={() => {
          setQuery("");
          setOpen((state) => !state);
        }}
        title="Table or view to browse"
      >
        {current?.type === "view" ? <Eye size={13} strokeWidth={1.6} /> : <Table2 size={13} strokeWidth={1.6} />}
        <span className="db-picker-name">{value ?? "No tables"}</span>
        <ChevronDown size={12} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="db-menu db-picker-menu" onKeyDown={(event) => event.stopPropagation()}>
          <input
            className="db-picker-search"
            autoFocus
            placeholder="Find a table…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && shown[0]) {
                onChange(shown[0].name);
                setOpen(false);
              }
              if (event.key === "Escape") setOpen(false);
            }}
          />
          <div className="db-picker-list">
            {shown.map((table) => (
              <button
                key={`${table.type}:${table.name}`}
                className={table.name === value ? "selected" : ""}
                onClick={() => {
                  onChange(table.name);
                  setOpen(false);
                }}
              >
                {table.type === "view" ? <Eye size={13} strokeWidth={1.6} /> : <Table2 size={13} strokeWidth={1.6} />}
                <span className="db-picker-item-name">{table.name}</span>
                <span className="db-picker-item-detail">{table.type === "view" ? "view" : table.rowCount !== null ? formatCount(table.rowCount) : ""}</span>
              </button>
            ))}
            {shown.length === 0 && <div className="db-menu-note">No match</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Browse Data: a table or view in a grid — sort, filter per column or
 * across all, edit cells inline or in the Edit Cell pane, add and delete
 * records, follow foreign keys.
 */
export function BrowseTab({ path, active }: { path: string; active: boolean }) {
  const schema = useDatabaseStore((state) => state.docs[path]?.schema ?? null);
  const tableName = useDatabaseStore((state) => state.docs[path]?.table ?? null);
  const browseState = useDatabaseStore((state) => (tableName ? state.docs[path]?.browse[tableName] : undefined)) ?? EMPTY;
  const dataVersion = useDatabaseStore((state) => state.docs[path]?.dataVersion ?? 0);
  const readOnly = useDatabaseStore((state) => state.docs[path]?.readOnly ?? false);
  const editPane = useDatabaseStore((state) => state.docs[path]?.editPane ?? false);
  const [selection, setSelection] = useState<Selection | null>(null);
  /** After New Record: the new row's key, to select it once rows reload. */
  const [reveal, setReveal] = useState<DbValue[] | null>(null);
  const grid = useRef<GridHandle>(null);

  const tables = useMemo(() => browsable(schema), [schema]);
  const table = tables.find((candidate) => candidate.name === tableName);
  const columns = useMemo(() => gridColumns(table), [table]);
  const editable = !!table && table.type === "table" && !readOnly;
  const filters = useDebounced(browseState.filters, 250, tableName);
  const search = useDebounced(browseState.search, 250, tableName);

  const setBrowse = (patch: Partial<BrowseState>) => {
    if (!tableName) return;
    update(path, (doc) => ({ browse: { ...doc.browse, [tableName]: { ...(doc.browse[tableName] ?? EMPTY), ...patch } } }));
  };

  const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => value.trim()));
  const sourceId = JSON.stringify([tableName, browseState.sort, activeFilters, search.trim(), dataVersion]);
  const source = useMemo<RowSource | null>(
    () =>
      tableName
        ? {
            id: sourceId,
            fetch: async (offset, limit, count) => {
              const page = await db.query(path, {
                table: tableName,
                offset,
                limit,
                count,
                sort: browseState.sort ? [browseState.sort] : undefined,
                filters: activeFilters,
                search: search.trim() || undefined,
              });
              return { rows: page.rows.map((cells, index) => ({ cells, key: page.keys[index]?.length ? page.keys[index] : null })), total: page.total };
            },
          }
        : null,
    [sourceId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const cache = useRowCache(source);

  // A new table, sort or filter: nothing selected.
  useEffect(() => setSelection(null), [tableName, sourceId]);

  // After New Record: find the new row (usually the last) and select it.
  useEffect(() => {
    if (!reveal || !source || cache.readyId !== source.id || cache.total === null) return;
    const wanted = keyId(reveal);
    setReveal(null);
    const total = cache.total;
    if (total === 0) return;
    const show = (row: number) => {
      grid.current?.scrollToRow(row);
      setSelection({ anchor: { row, col: 0 }, focus: { row, col: 0 } });
      grid.current?.focus();
    };
    // Look from the end (a new rowid sorts last), then everywhere (up to 50,000 rows).
    void (async () => {
      const tail = Math.max(0, total - 200);
      const last = await cache.fetchRange(tail, total);
      const atEnd = last.findIndex((row) => keyId(row.key) === wanted);
      if (atEnd >= 0) return show(tail + atEnd);
      const all = await cache.fetchRange(0, Math.min(total, 50_000));
      const index = all.findIndex((row) => keyId(row.key) === wanted);
      show(index >= 0 ? index : total - 1);
    })();
  }, [reveal, cache.readyId, cache.total]); // eslint-disable-line react-hooks/exhaustive-deps

  const focused = selection?.focus ?? null;
  const focusedRow = focused ? cache.getRow(focused.row) : undefined;
  const focusedValue: DbValue | undefined = focused && focusedRow ? focusedRow.cells[focused.col] : undefined;

  /** Store a value in a cell; patch the grid with what SQLite kept. */
  const store = async (row: number, col: number, value: DbValue | { text: string }): Promise<boolean> => {
    const current = cache.getRow(row);
    const column = columns[col];
    if (!current || !column || !tableName) return false;
    if (!current.key) {
      toast(path, `Rows of ${tableName} can't be edited here (no rowid or primary key).`, "error");
      return false;
    }
    try {
      const result = await db.updateCell(path, tableName, current.key, column.name, value);
      const cells = [...current.cells];
      cells[col] = result.value;
      const next: GridRow = { cells, key: result.key ?? current.key };
      cache.patchRow(row, next);
      edited(path, result.dirty);
      return true;
    } catch (error) {
      toast(path, String(error), "error");
      return false;
    }
  };

  const commitEdit = async (row: number, col: number, text: string) => {
    const current = cache.getRow(row)?.cells[col];
    // Unchanged (a NULL left empty stays NULL).
    if (current !== undefined && ((current === null && text === "") || (!isBlob(current) && current !== null && valueText(current) === text))) return true;
    return store(row, col, { text });
  };

  const followKey = (row: number, col: number) => {
    const column = columns[col];
    const value = cache.getRow(row)?.cells[col];
    if (!column?.fk || value === undefined || value === null) return;
    const target = tables.find((candidate) => candidate.name.toLowerCase() === column.fk!.table.toLowerCase());
    if (!target) {
      toast(path, `No table ${column.fk.table}`, "error");
      return;
    }
    const targetColumn = column.fk.column ?? target.columns.find((candidate) => candidate.pk > 0)?.name ?? "rowid";
    update(path, (doc) => ({
      table: target.name,
      browse: { ...doc.browse, [target.name]: { ...(doc.browse[target.name] ?? EMPTY), filters: { [targetColumn]: `=${valueText(value)}` }, search: "" } },
    }));
  };

  const newRecord = async () => {
    if (!tableName) return;
    try {
      const result = await db.insertRow(path, tableName);
      edited(path, result.dirty, true);
      setReveal(result.key ?? []);
    } catch (error) {
      toast(path, String(error), "error");
    }
  };

  const deleteRecords = async () => {
    if (!selection || !tableName) return;
    const { top, bottom } = normalizeSelection(selection);
    const rows = await cache.fetchRange(top, bottom + 1);
    const keys = rows.map((row) => row.key).filter((key): key is DbValue[] => !!key);
    if (keys.length === 0) return;
    try {
      const result = await db.deleteRows(path, tableName, keys);
      edited(path, result.dirty, true);
      toast(path, `Deleted ${formatCount(result.deleted)} record${result.deleted === 1 ? "" : "s"}. Write Changes to keep it, or Revert.`);
    } catch (error) {
      toast(path, String(error), "error");
    }
  };

  const total = cache.total;
  const filtered = Object.keys(activeFilters).length > 0 || !!search.trim();
  const range = selection ? normalizeSelection(selection) : null;
  const selectedRows = range ? range.bottom - range.top + 1 : 0;
  const selectedCells = range ? selectedRows * (range.right - range.left + 1) : 0;

  if (!schema) return null;
  if (tables.length === 0) {
    return (
      <div className="db-empty-page">
        <Rows3 size={26} strokeWidth={1.2} />
        <p>This database has no tables yet.</p>
        <button className="db-button" onClick={() => update(path, { dialog: { kind: "createTable" } })}>
          Create Table…
        </button>
      </div>
    );
  }

  return (
    <div className="db-browse" data-ready={source && cache.readyId === source.id ? tableName : ""}>
      <div className="db-subbar">
        <TablePicker tables={tables} value={tableName} onChange={(name) => update(path, { table: name })} />
        <button className="db-tool" title="Refresh" onClick={() => update(path, (doc) => ({ dataVersion: doc.dataVersion + 1 }))}>
          <RefreshCw size={13} strokeWidth={1.6} />
        </button>
        <div className="db-search">
          <Search size={12} strokeWidth={1.8} />
          <input
            placeholder="Filter in any column"
            value={browseState.search}
            spellCheck={false}
            onChange={(event) => setBrowse({ search: event.target.value })}
            onKeyDown={(event) => event.key === "Escape" && setBrowse({ search: "" })}
          />
          {browseState.search && (
            <button title="Clear" onClick={() => setBrowse({ search: "" })}>
              <X size={11} strokeWidth={2} />
            </button>
          )}
        </div>
        <button className="db-tool" title="Clear all filters" disabled={!filtered && !browseState.sort} onClick={() => setBrowse({ filters: {}, search: "", sort: null })}>
          <Eraser size={13} strokeWidth={1.6} />
        </button>
        <div className="db-toolbar-spacer" />
        <button className="db-tool" title="Add a record (defaults for its columns)" disabled={!editable} onClick={() => void newRecord()}>
          <Rows3 size={13} strokeWidth={1.6} />
          <span>New Record</span>
        </button>
        <button className="db-tool" title="Delete the selected records" disabled={!editable || !selection} onClick={() => void deleteRecords()}>
          <Trash2 size={13} strokeWidth={1.6} />
          <span>Delete Record</span>
        </button>
        <div className="db-toolbar-separator" />
        <button className={editPane ? "db-tool on" : "db-tool"} title="Edit Cell pane" onClick={() => update(path, { editPane: !editPane })}>
          <PanelRight size={14} strokeWidth={1.6} />
          <span>Edit Cell</span>
        </button>
      </div>
      <div className="db-browse-body">
        <DataGrid
          ref={grid}
          columns={columns}
          cache={cache}
          sort={browseState.sort}
          onSort={(column) => {
            const sort = browseState.sort;
            setBrowse({ sort: sort?.column !== column ? { column, desc: false } : sort.desc ? null : { column, desc: true } });
          }}
          filters={browseState.filters}
          onFilter={(column, value) => setBrowse({ filters: { ...browseState.filters, [column]: value } })}
          widths={browseState.widths}
          onWidths={(widths) => setBrowse({ widths })}
          editable={editable}
          onCommitEdit={commitEdit}
          onFollowKey={followKey}
          selection={selection}
          onSelection={setSelection}
          emptyMessage={filtered ? "No rows match the filters" : "No rows"}
          className={active ? "active" : ""}
        />
        {editPane && (
          <EditCellPane
            path={path}
            table={tableName}
            column={focused ? columns[focused.col] : undefined}
            value={focusedValue}
            rowKey={focusedRow?.key ?? null}
            editable={editable && !!focusedRow?.key && !columns[focused?.col ?? -1]?.readOnly}
            onStore={(value) => (focused ? store(focused.row, focused.col, value) : Promise.resolve(false))}
            onClose={() => update(path, { editPane: false })}
          />
        )}
      </div>
      <div className="db-status">
        <span>
          {total === null ? "Loading…" : `${formatCount(total)} row${total === 1 ? "" : "s"}`}
          {filtered && table?.rowCount != null && total !== null && <span className="db-status-dim"> (filtered from {formatCount(table.rowCount)})</span>}
        </span>
        {selection && selectedCells > 0 && (
          <span>
            · {selectedRows > 1 || selectedCells > 1 ? `${formatCount(selectedRows)} row${selectedRows === 1 ? "" : "s"}, ${formatCount(selectedCells)} cell${selectedCells === 1 ? "" : "s"} selected` : `Row ${formatCount(selection.focus.row + 1)}, ${columns[selection.focus.col]?.name ?? ""}`}
          </span>
        )}
        {browseState.sort && <span className="db-status-dim">· sorted by {browseState.sort.column} {browseState.sort.desc ? "↓" : "↑"}</span>}
        <span className="db-toolbar-spacer" />
        {table && table.type === "view" && <span className="db-status-dim">View (read-only)</span>}
        {table?.withoutRowid && <span className="db-status-dim">WITHOUT ROWID</span>}
        {cache.firstMs !== null && <span className="db-status-dim">{Math.max(1, Math.round(cache.firstMs))} ms</span>}
      </div>
    </div>
  );
}

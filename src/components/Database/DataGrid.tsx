import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, KeyRound, Link2 } from "lucide-react";
import type { DbValue, SortSpec } from "../../lib/database/api";
import { formatBytes, imageUrl, isBlob, kindOf, valueText } from "../../lib/database/values";
import type { RowCache } from "./rowCache";

export interface GridColumn {
  name: string;
  type?: string;
  pk?: boolean;
  /** A foreign key: where its values point. */
  fk?: { table: string; column: string | null };
  /** Generated columns and views can't be edited. */
  readOnly?: boolean;
}

export interface Cell {
  row: number;
  col: number;
}

export interface Selection {
  anchor: Cell;
  focus: Cell;
}

export interface GridHandle {
  focus: () => void;
  scrollToRow: (row: number) => void;
  /** Start editing the focused cell. */
  edit: () => void;
}

interface DataGridProps {
  columns: GridColumn[];
  cache: RowCache;
  sort?: SortSpec | null;
  onSort?: (column: string) => void;
  filters?: Record<string, string> | null;
  onFilter?: (column: string, value: string) => void;
  widths: Record<string, number>;
  onWidths: (widths: Record<string, number>) => void;
  editable: boolean;
  /** Commit an inline edit; resolve false to keep editing. */
  onCommitEdit?: (row: number, col: number, text: string) => Promise<boolean>;
  onFollowKey?: (row: number, col: number) => void;
  selection: Selection | null;
  onSelection: (selection: Selection | null) => void;
  emptyMessage?: string;
  /** Notice in the corner above the rows (e.g. "Loading…"). */
  className?: string;
}

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 27;
const FILTER_HEIGHT = 27;
/** Browsers cap element heights; beyond this the scrollbar maps proportionally. */
const MAX_SCROLL_HEIGHT = 8_000_000;
const MIN_WIDTH = 48;
const isMac = navigator.platform.toLowerCase().includes("mac");

export function defaultWidth(column: GridColumn): number {
  const type = (column.type ?? "").toUpperCase();
  const base = Math.max(column.name.length * 7.5 + (column.pk || column.fk ? 46 : 32), 70);
  if (type.includes("INT") || type.includes("REAL") || type.includes("NUM") || type.includes("BOOL")) return Math.min(Math.max(base, 80), 140);
  return Math.min(Math.max(base, 150), 260);
}

export const normalizeSelection = (selection: Selection) => ({
  top: Math.min(selection.anchor.row, selection.focus.row),
  bottom: Math.max(selection.anchor.row, selection.focus.row),
  left: Math.min(selection.anchor.col, selection.focus.col),
  right: Math.max(selection.anchor.col, selection.focus.col),
});

/** One cell's content. */
const CellContent = memo(function CellContent({ value, column, onFollow }: { value: DbValue; column: GridColumn; onFollow?: () => void }) {
  const kind = kindOf(value);
  if (kind === "null") return <span className="dbg-null">NULL</span>;
  if (isBlob(value)) {
    const image = imageUrl(value);
    return image ? (
      <span className="dbg-blob">
        <img className="dbg-thumb" src={image} alt="" draggable={false} />
        <span>{formatBytes(value.b)}</span>
      </span>
    ) : (
      <span className="dbg-blob">BLOB ({formatBytes(value.b)})</span>
    );
  }
  const text = valueText(value);
  const shown = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  return (
    <>
      <span className="dbg-text">{shown.replace(/\r?\n/g, " ⏎ ")}</span>
      {column.fk && onFollow && (
        <button
          className="dbg-follow"
          title={`Go to ${column.fk.table}${column.fk.column ? `.${column.fk.column}` : ""} = ${shown}`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onFollow();
          }}
        >
          <ArrowUpRight size={11} strokeWidth={2} />
        </button>
      )}
    </>
  );
});

/**
 * A spreadsheet-like grid over a paged row source: virtualized (only the
 * rows in view render; pages load as you scroll), sortable headers with a
 * filter under each, row numbers, keyboard navigation, rectangular
 * selection, copy as TSV, and inline editing (double-click, Enter, or
 * just type; Esc cancels).
 */
export const DataGrid = forwardRef<GridHandle, DataGridProps>(function DataGrid(props, ref) {
  const { columns, cache, sort, onSort, filters, onFilter, widths, onWidths, editable, onCommitEdit, onFollowKey, selection, onSelection, emptyMessage } = props;
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [editing, setEditing] = useState<{ cell: Cell; text: string; select: boolean } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const total = cache.total ?? 0;
  const showFilters = !!filters && !!onFilter;
  const headerHeight = HEADER_HEIGHT + (showFilters ? FILTER_HEIGHT : 0);
  const numberWidth = Math.max(44, String(total).length * 7.5 + 22);
  // Columns fit their first rows' content (until resized by hand).
  const [fitted, setFitted] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!cache.readyId) return;
    const next: Record<string, number> = {};
    const count = Math.min(cache.total ?? 0, 150);
    columns.forEach((column, index) => {
      let longest = 0;
      for (let row = 0; row < count; row++) {
        const value = cache.getRow(row)?.cells[index];
        if (value === undefined) continue;
        const text = isBlob(value) ? (imageUrl(value) ? "xxxxxxx 88 bytes" : `BLOB (${formatBytes(value.b)})`) : value === null ? "NULL" : valueText(value);
        longest = Math.max(longest, Math.min(text.length, 60));
      }
      const header = column.name.length * 7.6 + (column.pk || column.fk ? 46 : 30);
      next[column.name] = Math.round(Math.min(Math.max(longest * 7.3 + 22, header, 64), 380));
    });
    setFitted(next);
  }, [cache.readyId]); // eslint-disable-line react-hooks/exhaustive-deps
  const columnWidths = columns.map((column) => widths[column.name] ?? fitted[column.name] ?? defaultWidth(column));
  const offsets: number[] = [];
  let totalWidth = numberWidth;
  for (const width of columnWidths) {
    offsets.push(totalWidth);
    totalWidth += width;
  }

  // Scroll mapping (proportional beyond MAX_SCROLL_HEIGHT).
  const rowsHeight = total * ROW_HEIGHT;
  const contentHeight = Math.min(rowsHeight, MAX_SCROLL_HEIGHT);
  const bodyHeight = Math.max(0, viewport.height - headerHeight);
  const maxScroll = Math.max(0, contentHeight - bodyHeight);
  const realMax = Math.max(0, rowsHeight - bodyHeight);
  const realTop = maxScroll > 0 ? (Math.min(viewport.top, maxScroll) * realMax) / maxScroll : 0;
  const scrollFor = (real: number) => (realMax > 0 ? (real * maxScroll) / realMax : 0);
  const firstRow = Math.max(0, Math.floor(realTop / ROW_HEIGHT));
  const visibleCount = Math.ceil(bodyHeight / ROW_HEIGHT) + 1;
  const lastRow = Math.min(total - 1, firstRow + visibleCount);
  const { ensure } = cache;

  useEffect(() => {
    ensure(firstRow - 20, lastRow + 40);
  }, [firstRow, lastRow, ensure]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new source: back to the top.
  useEffect(() => {
    if (cache.total === null && scroller.current) {
      scroller.current.scrollTop = 0;
      setViewport((current) => ({ ...current, top: 0 }));
    }
  }, [cache.total]);

  const scrollToCell = useCallback(
    (cell: Cell) => {
      const element = scroller.current;
      if (!element) return;
      const rowTop = cell.row * ROW_HEIGHT;
      if (rowTop < realTop) element.scrollTop = Math.floor(scrollFor(rowTop));
      else if (rowTop + ROW_HEIGHT > realTop + bodyHeight) element.scrollTop = Math.ceil(scrollFor(rowTop + ROW_HEIGHT - bodyHeight));
      if (cell.col >= 0 && cell.col < columns.length) {
        const left = offsets[cell.col];
        const right = left + columnWidths[cell.col];
        if (left - numberWidth < element.scrollLeft) element.scrollLeft = left - numberWidth;
        else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [realTop, bodyHeight, maxScroll, realMax, columns.length, widths],
  );

  const startEdit = useCallback(
    (cell: Cell, initial?: string) => {
      if (!editable || !onCommitEdit || columns[cell.col]?.readOnly) return;
      const row = cache.getRow(cell.row);
      if (!row) return;
      const value = row.cells[cell.col];
      if (isBlob(value)) return;
      setEditing({ cell, text: initial ?? valueText(value), select: initial === undefined });
    },
    [editable, onCommitEdit, columns, cache],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => root.current?.focus({ preventScroll: true }),
      scrollToRow: (row: number) => {
        const element = scroller.current;
        if (!element) return;
        element.scrollTop = Math.max(0, scrollFor(row * ROW_HEIGHT - bodyHeight / 3));
        setViewport({ top: element.scrollTop, height: element.clientHeight });
      },
      edit: () => selection && startEdit(selection.focus),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bodyHeight, maxScroll, realMax, selection, startEdit],
  );

  const select = (cell: Cell, extend: boolean) => {
    const clamped = { row: Math.max(0, Math.min(total - 1, cell.row)), col: Math.max(0, Math.min(columns.length - 1, cell.col)) };
    onSelection(extend && selection ? { anchor: selection.anchor, focus: clamped } : { anchor: clamped, focus: clamped });
    scrollToCell(clamped);
  };

  const commitEdit = async (move?: Cell) => {
    const current = editingRef.current;
    if (!current || !onCommitEdit) return;
    const ok = await onCommitEdit(current.cell.row, current.cell.col, current.text);
    if (!ok) return;
    setEditing(null);
    if (move) select(move, false);
    root.current?.focus({ preventScroll: true });
  };

  const copySelection = async () => {
    if (!selection) return;
    const { top, bottom, left, right } = normalizeSelection(selection);
    const count = Math.min(bottom - top + 1, 100_000);
    const rows = await cache.fetchRange(top, top + count);
    const lines = rows.map((row) =>
      row.cells
        .slice(left, right + 1)
        .map((value) => {
          const text = isBlob(value) ? "" : valueText(value);
          return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join("\t"),
    );
    if (top === bottom && left === right) {
      await navigator.clipboard.writeText(isBlob(rows[0]?.cells[left] ?? null) ? "" : valueText(rows[0]?.cells[left] ?? null));
    } else {
      await navigator.clipboard.writeText(lines.join("\n"));
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editing || (event.target as HTMLElement).closest("input, textarea")) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const focus = selection?.focus ?? { row: 0, col: 0 };
    const page = Math.max(1, visibleCount - 2);
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (total === 0 || columns.length === 0) return;
    switch (event.key) {
      case "ArrowUp":
        handled();
        return select({ row: mod ? 0 : focus.row - 1, col: focus.col }, event.shiftKey);
      case "ArrowDown":
        handled();
        return select({ row: mod ? total - 1 : focus.row + 1, col: focus.col }, event.shiftKey);
      case "ArrowLeft":
        handled();
        return select({ row: focus.row, col: mod ? 0 : focus.col - 1 }, event.shiftKey);
      case "ArrowRight":
        handled();
        return select({ row: focus.row, col: mod ? columns.length - 1 : focus.col + 1 }, event.shiftKey);
      case "PageUp":
        handled();
        return select({ row: focus.row - page, col: focus.col }, event.shiftKey);
      case "PageDown":
        handled();
        return select({ row: focus.row + page, col: focus.col }, event.shiftKey);
      case "Home":
        handled();
        return select(mod ? { row: 0, col: 0 } : { row: focus.row, col: 0 }, event.shiftKey);
      case "End":
        handled();
        return select(mod ? { row: total - 1, col: columns.length - 1 } : { row: focus.row, col: columns.length - 1 }, event.shiftKey);
      case "Tab":
        handled();
        return select({ row: focus.row, col: focus.col + (event.shiftKey ? -1 : 1) }, false);
      case "Enter":
      case "F2":
        handled();
        if (selection) startEdit(selection.focus);
        return;
    }
    if (mod && event.key.toLowerCase() === "c") {
      handled();
      void copySelection();
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      handled();
      onSelection({ anchor: { row: 0, col: 0 }, focus: { row: total - 1, col: columns.length - 1 } });
      return;
    }
    // Typing starts editing with what was typed (like a spreadsheet).
    if (selection && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      handled();
      startEdit(selection.focus, event.key);
    }
  };

  const startResize = (event: React.MouseEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const start = columnWidths[index];
    const name = columns[index].name;
    const move = (moveEvent: MouseEvent) => onWidths({ ...widths, [name]: Math.max(MIN_WIDTH, start + moveEvent.clientX - startX) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const dragSelect = (event: React.MouseEvent, cell: Cell, wholeRow = false) => {
    if (event.button !== 0) return;
    root.current?.focus({ preventScroll: true });
    const make = (target: Cell): Cell => (wholeRow ? { row: target.row, col: columns.length - 1 } : target);
    const anchor = wholeRow ? { row: cell.row, col: 0 } : cell;
    const base = event.shiftKey && selection ? selection.anchor : anchor;
    onSelection({ anchor: base, focus: make(cell) });
    const cellAt = (moveEvent: MouseEvent): Cell | null => {
      const element = scroller.current;
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const y = moveEvent.clientY - box.top - headerHeight;
      const x = moveEvent.clientX - box.left + element.scrollLeft;
      const row = Math.max(0, Math.min(total - 1, Math.floor((realTop + y) / ROW_HEIGHT)));
      let col = columns.length - 1;
      for (let index = 0; index < columns.length; index++) {
        if (x < offsets[index] + columnWidths[index]) {
          col = index;
          break;
        }
      }
      return { row, col };
    };
    const move = (moveEvent: MouseEvent) => {
      const target = cellAt(moveEvent);
      if (target) onSelection({ anchor: base, focus: make(target) });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const range = selection ? normalizeSelection(selection) : null;
  const rows: React.ReactNode[] = [];
  for (let index = firstRow; index <= lastRow; index++) {
    const row = cache.getRow(index);
    // Inside the window at the scroll position: small offsets, however far down.
    const y = index * ROW_HEIGHT - realTop;
    const rowSelected = !!range && index >= range.top && index <= range.bottom;
    rows.push(
      <div key={index} className={`dbg-row${index % 2 ? " odd" : ""}${rowSelected ? " in-selection" : ""}`} style={{ top: y, width: totalWidth }} role="row" aria-rowindex={index + 1}>
        <div
          className={`dbg-rownum${rowSelected ? " selected" : ""}`}
          style={{ width: numberWidth }}
          onMouseDown={(event) => dragSelect(event, { row: index, col: 0 }, true)}
        >
          {index + 1}
        </div>
        {columns.map((column, col) => {
          const selected = !!range && rowSelected && col >= range.left && col <= range.right;
          const focused = selection?.focus.row === index && selection.focus.col === col;
          const isEditing = editing?.cell.row === index && editing.cell.col === col;
          const value = row?.cells[col];
          const kind = row ? kindOf(value ?? null) : "loading";
          return (
            <div
              key={col}
              className={`dbg-cell k-${kind}${selected ? " selected" : ""}${focused ? " focused" : ""}${isEditing ? " editing" : ""}`}
              style={{ left: offsets[col], width: columnWidths[col] }}
              onMouseDown={(event) => dragSelect(event, { row: index, col })}
              onDoubleClick={() => startEdit({ row: index, col })}
              role="gridcell"
            >
              {isEditing ? (
                <input
                  className="dbg-editor"
                  autoFocus
                  value={editing.text}
                  ref={(input) => {
                    if (input && editing.select && document.activeElement !== input) {
                      input.focus();
                      input.select();
                    }
                  }}
                  onFocus={(event) => (editing.select ? event.target.select() : undefined)}
                  onChange={(event) => setEditing({ ...editing, text: event.target.value, select: false })}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(null);
                      root.current?.focus({ preventScroll: true });
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      void commitEdit({ row: index + 1 < total ? index + 1 : index, col });
                    } else if (event.key === "Tab") {
                      event.preventDefault();
                      void commitEdit({ row: index, col: Math.max(0, Math.min(columns.length - 1, col + (event.shiftKey ? -1 : 1))) });
                    }
                  }}
                  onBlur={() => {
                    if (editingRef.current?.cell.row === index && editingRef.current.cell.col === col) void commitEdit();
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                />
              ) : row ? (
                <CellContent value={value ?? null} column={column} onFollow={onFollowKey && value !== null ? () => onFollowKey(index, col) : undefined} />
              ) : (
                <span className="dbg-loading" />
              )}
            </div>
          );
        })}
      </div>,
    );
  }

  return (
    <div className={`dbg-root ${props.className ?? ""}`} ref={root} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-rowcount={total}>
      <div
        className="dbg-scroll"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          setViewport({ top: element.scrollTop, height: element.clientHeight });
        }}
      >
        <div className="dbg-sizer" style={{ width: totalWidth, minWidth: "100%", height: headerHeight + contentHeight }}>
          <div className="dbg-header" style={{ minWidth: totalWidth, height: headerHeight }}>
            <div className="dbg-corner" style={{ width: numberWidth, height: headerHeight }} title="Select all" onMouseDown={() => total > 0 && onSelection({ anchor: { row: 0, col: 0 }, focus: { row: total - 1, col: columns.length - 1 } })} />
            {columns.map((column, col) => {
              const sorted = sort?.column === column.name ? sort : null;
              return (
                <div key={column.name + col} className={`dbg-head${range && col >= range.left && col <= range.right ? " in-selection" : ""}`} style={{ left: offsets[col], width: columnWidths[col] }}>
                  <div
                    className={`dbg-head-title${onSort ? " sortable" : ""}`}
                    style={{ height: HEADER_HEIGHT }}
                    title={`${column.name}${column.type ? ` — ${column.type}` : ""}${column.fk ? `\nReferences ${column.fk.table}${column.fk.column ? `(${column.fk.column})` : ""}` : ""}${onSort ? "\nClick to sort" : ""}`}
                    onClick={() => onSort?.(column.name)}
                  >
                    {column.pk && <KeyRound size={11} strokeWidth={2} className="dbg-head-icon pk" />}
                    {column.fk && <Link2 size={11} strokeWidth={2} className="dbg-head-icon fk" />}
                    <span className="dbg-head-name">{column.name}</span>
                    {sorted && (sorted.desc ? <ArrowDown size={12} strokeWidth={2} className="dbg-sort" /> : <ArrowUp size={12} strokeWidth={2} className="dbg-sort" />)}
                  </div>
                  {showFilters && (
                    <div className="dbg-filter" style={{ height: FILTER_HEIGHT }}>
                      <input
                        value={filters[column.name] ?? ""}
                        placeholder="Filter"
                        spellCheck={false}
                        onChange={(event) => onFilter(column.name, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") onFilter(column.name, "");
                          if (event.key === "Enter" || event.key === "ArrowDown") {
                            event.preventDefault();
                            root.current?.focus();
                          }
                        }}
                        title={"Filter this column:\ntext — contains\n=x  <>x  >x  <x  >=x  <=x — compare\nx~y — between\nNULL / NOT NULL"}
                      />
                    </div>
                  )}
                  <div className="dbg-resize" onMouseDown={(event) => startResize(event, col)} />
                </div>
              );
            })}
          </div>
          <div className="dbg-body" style={{ top: headerHeight, height: contentHeight, width: totalWidth }}>
            <div className="dbg-window" style={{ top: Math.min(viewport.top, maxScroll), width: totalWidth }}>
              {rows}
            </div>
          </div>
        </div>
        {cache.total === 0 && !cache.error && <div className="dbg-empty" style={{ top: headerHeight }}>{emptyMessage ?? "No rows"}</div>}
        {cache.error && <div className="dbg-empty error" style={{ top: headerHeight }}>{cache.error}</div>}
      </div>
    </div>
  );
});

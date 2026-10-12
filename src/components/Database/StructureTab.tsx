import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Eye, KeyRound, Link2, ListPlus, Pencil, Plus, Table2, Trash2, Zap, Hash, Columns3 } from "lucide-react";
import { monaco } from "../../lib/monacoSetup";
import { db, type ColumnInfo, type IndexInfo, type TableInfo, type TriggerInfo } from "../../lib/database/api";
import { ask, edited, refreshSchema, toast, update, useDatabaseStore } from "../../lib/database/databaseStore";
import { quoteIdent } from "../../lib/database/sql";
import { formatCount } from "../../lib/database/values";

type ObjectKind = "table" | "view" | "index" | "trigger";

/** SQL, colored by Monaco's tokenizer. */
export function SqlBlock({ sql, className }: { sql: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void monaco.editor.colorize(sql, "sql", { tabSize: 4 }).then((result) => !cancelled && setHtml(result));
    return () => {
      cancelled = true;
    };
  }, [sql]);
  return html === null ? <pre className={`db-sql ${className ?? ""}`}>{sql}</pre> : <pre className={`db-sql ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

const oneLine = (sql: string | null) => (sql ?? "").replace(/\s+/g, " ").trim();
const plural = (count: number, one: string, many = `${one}s`) => `${formatCount(count)} ${count === 1 ? one : many}`;

function ColumnMarkers({ column, table }: { column: ColumnInfo; table: TableInfo }) {
  const fk = table.foreignKeys.find((key) => key.from === column.name);
  return (
    <span className="db-markers">
      {column.pk > 0 && <span className="db-marker pk" title="Primary key">PK</span>}
      {column.autoincrement && <span className="db-marker" title="Autoincrement">AI</span>}
      {column.notnull && <span className="db-marker" title="Not null">NN</span>}
      {column.unique && <span className="db-marker" title="Unique">U</span>}
      {column.hidden >= 2 && <span className="db-marker" title="Generated column">GEN</span>}
      {fk && (
        <span className="db-marker fk" title={`Foreign key → ${fk.table}${fk.to ? `(${fk.to})` : ""}`}>
          → {fk.table}
          {fk.to ? `.${fk.to}` : ""}
        </span>
      )}
      {column.default !== null && <span className="db-default" title="Default value">= {column.default}</span>}
    </span>
  );
}

/**
 * Database Structure: tables (with their columns), indexes, views and
 * triggers, each with its CREATE statement; create, modify and delete
 * them.
 */
export function StructureTab({ path }: { path: string }) {
  const schema = useDatabaseStore((state) => state.docs[path]?.schema ?? null);
  const selected = useDatabaseStore((state) => state.docs[path]?.selected ?? null);
  const readOnly = useDatabaseStore((state) => state.docs[path]?.readOnly ?? false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ "group:system": true });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const objects = useMemo(() => {
    const map = new Map<string, TableInfo | IndexInfo | TriggerInfo>();
    if (!schema) return map;
    for (const table of schema.tables) map.set(`table:${table.name}`, table);
    for (const view of schema.views) map.set(`view:${view.name}`, view);
    for (const index of schema.indexes) map.set(`index:${index.name}`, index);
    for (const trigger of schema.triggers) map.set(`trigger:${trigger.name}`, trigger);
    return map;
  }, [schema]);

  if (!schema) return null;
  const current = selected ? objects.get(selected) : undefined;
  const currentKind = selected?.split(":")[0] as ObjectKind | undefined;
  const select = (key: string) => update(path, { selected: key });

  const deleteObject = async () => {
    if (!current || !currentKind) return;
    const label = currentKind === "index" ? "index" : currentKind;
    const choice = await ask(path, `Delete ${label}`, `Delete the ${label} "${current.name}"?`, [
      { label: "Cancel", value: "cancel" },
      { label: "Delete", value: "delete", danger: true, primary: true },
    ], currentKind === "table" ? "Its rows, indexes and triggers go too. Until you Write Changes this can be reverted." : "Until you Write Changes this can be reverted.");
    if (choice !== "delete") return;
    const keyword = currentKind.toUpperCase();
    try {
      const result = await db.execute(path, `DROP ${keyword} ${quoteIdent(current.name)};`);
      const failed = result.statements.find((statement) => statement.kind === "error");
      if (failed) throw failed.error;
      edited(path, result.dirty);
      update(path, { selected: null });
      await refreshSchema(path, true);
      toast(path, `Deleted ${label} ${current.name}.`);
    } catch (error) {
      toast(path, String(error), "error");
    }
  };

  const copyCreate = () => {
    if (!current?.sql) return;
    void navigator.clipboard.writeText(`${current.sql.trim()};`);
    toast(path, "CREATE statement copied.");
  };

  const userTables = schema.tables.filter((table) => !table.system && !table.shadow);
  const systemTables = schema.tables.filter((table) => table.system || table.shadow);
  const groups: { id: string; label: string; icon: typeof Table2; items: (TableInfo | IndexInfo | TriggerInfo)[]; kind: ObjectKind }[] = [
    { id: "group:tables", label: "Tables", icon: Table2, items: userTables, kind: "table" },
    { id: "group:indexes", label: "Indices", icon: Hash, items: schema.indexes, kind: "index" },
    { id: "group:views", label: "Views", icon: Eye, items: schema.views, kind: "view" },
    { id: "group:triggers", label: "Triggers", icon: Zap, items: schema.triggers, kind: "trigger" },
  ];
  if (systemTables.length > 0) groups.push({ id: "group:system", label: "System tables", icon: Table2, items: systemTables, kind: "table" });

  const rows: React.ReactNode[] = [];
  for (const group of groups) {
    const isCollapsed = !!collapsed[group.id];
    const GroupIcon = group.icon;
    rows.push(
      <div key={group.id} className="db-tree-row group" onClick={() => setCollapsed((state) => ({ ...state, [group.id]: !isCollapsed }))}>
        <span className="db-tree-name" style={{ paddingLeft: 6 }}>
          {isCollapsed ? <ChevronRight size={13} strokeWidth={1.8} /> : <ChevronDown size={13} strokeWidth={1.8} />}
          <GroupIcon size={13} strokeWidth={1.6} className="db-tree-icon" />
          {group.label} <span className="db-tree-count">({group.items.length})</span>
        </span>
        <span />
        <span />
      </div>,
    );
    if (isCollapsed) continue;
    for (const item of group.items) {
      const key = `${item.type}:${item.name}`;
      const hasColumns = item.type === "table" || item.type === "view";
      const open = hasColumns && !!expanded[key];
      const Icon = item.type === "view" ? Eye : item.type === "index" ? Hash : item.type === "trigger" ? Zap : Table2;
      const detail =
        item.type === "table"
          ? `${(item as TableInfo).rowCount !== null ? `${formatCount((item as TableInfo).rowCount!)} rows` : ""}${(item as TableInfo).withoutRowid ? " · WITHOUT ROWID" : ""}${(item as TableInfo).virtual ? " · virtual" : ""}`
          : item.type === "index" || item.type === "trigger"
            ? `on ${(item as IndexInfo).table}`
            : "";
      rows.push(
        <div
          key={key}
          className={`db-tree-row object${selected === key ? " selected" : ""}`}
          data-key={key}
          onClick={() => select(key)}
          onDoubleClick={() => {
            if (hasColumns) update(path, { table: item.name, tab: "browse" });
          }}
        >
          <span className="db-tree-name" style={{ paddingLeft: 20 }}>
            {hasColumns ? (
              <span
                className="db-tree-toggle"
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded((state) => ({ ...state, [key]: !open }));
                }}
              >
                {open ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
              </span>
            ) : (
              <span className="db-tree-toggle" />
            )}
            <Icon size={13} strokeWidth={1.6} className={`db-tree-icon ${item.type}`} />
            <span className="db-tree-label">{item.name}</span>
          </span>
          <span className="db-tree-type">{detail}</span>
          <span className="db-tree-schema" title={item.sql ?? ""}>{oneLine(item.sql)}</span>
        </div>,
      );
      if (open) {
        const table = item as TableInfo;
        for (const column of table.columns.filter((candidate) => candidate.hidden !== 1)) {
          const fk = table.foreignKeys.some((foreign) => foreign.from === column.name);
          rows.push(
            <div key={`${key}/${column.name}`} className={`db-tree-row column${selected === key ? " parent-selected" : ""}`} onClick={() => select(key)}>
              <span className="db-tree-name" style={{ paddingLeft: 52 }}>
                {column.pk > 0 ? (
                  <KeyRound size={12} strokeWidth={1.8} className="db-tree-icon pk" />
                ) : fk ? (
                  <Link2 size={12} strokeWidth={1.8} className="db-tree-icon fk" />
                ) : (
                  <Columns3 size={12} strokeWidth={1.6} className="db-tree-icon dim" />
                )}
                <span className="db-tree-label">{column.name}</span>
              </span>
              <span className="db-tree-type mono">{column.type || <span className="db-dim">—</span>}</span>
              <span className="db-tree-schema">
                <ColumnMarkers column={column} table={table} />
              </span>
            </div>,
          );
        }
      }
    }
  }

  const canModify = !readOnly && currentKind === "table" && !(current as TableInfo | undefined)?.system && !(current as TableInfo | undefined)?.virtual;
  return (
    <div className="db-structure">
      <div className="db-subbar">
        <button className="db-tool" disabled={readOnly} title="Create a table" onClick={() => update(path, { dialog: { kind: "createTable" } })}>
          <Plus size={14} strokeWidth={1.6} /> <span>Create Table</span>
        </button>
        <button className="db-tool" disabled={readOnly || schema.tables.length === 0} title="Create an index" onClick={() => update(path, { dialog: { kind: "createIndex", table: currentKind === "table" ? current!.name : null } })}>
          <ListPlus size={14} strokeWidth={1.6} /> <span>Create Index</span>
        </button>
        <button className="db-tool" disabled={!canModify} title="Modify the selected table" onClick={() => current && update(path, { dialog: { kind: "modifyTable", table: current.name } })}>
          <Pencil size={13} strokeWidth={1.6} /> <span>Modify Table</span>
        </button>
        <button className="db-tool" disabled={readOnly || !current || (current as TableInfo).system} title="Delete the selected object" onClick={() => void deleteObject()}>
          <Trash2 size={13} strokeWidth={1.6} /> <span>Delete</span>
        </button>
        <div className="db-toolbar-separator" />
        <button className="db-tool" disabled={!current?.sql} title="Copy the CREATE statement" onClick={copyCreate}>
          <Copy size={13} strokeWidth={1.6} /> <span>Copy Create Statement</span>
        </button>
        <div className="db-toolbar-spacer" />
        <span className="db-subbar-note">
          {plural(userTables.length, "table")} · {plural(schema.indexes.length, "index", "indices")} · {plural(schema.views.length, "view")} · {plural(schema.triggers.length, "trigger")}
        </span>
      </div>
      <div className="db-tree">
        <div className="db-tree-head">
          <span>Name</span>
          <span>Type</span>
          <span>Schema</span>
        </div>
        <div className="db-tree-body">{rows}</div>
      </div>
      <div className="db-structure-sql">
        {current ? (
          <>
            <div className="db-structure-sql-head">
              <span className="db-chip">{current.type.toUpperCase()}</span>
              <span className="db-structure-sql-name">{current.name}</span>
              {"table" in current && <span className="db-dim">on {(current as IndexInfo).table}</span>}
            </div>
            <SqlBlock sql={current.sql ? `${current.sql.trim()};` : "-- An automatic index (no CREATE statement)"} />
          </>
        ) : (
          <div className="db-structure-sql-empty">Select an object to see its CREATE statement.</div>
        )}
      </div>
    </div>
  );
}

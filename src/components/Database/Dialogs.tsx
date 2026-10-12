import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, Plus, Trash2 } from "lucide-react";
import { db, type CsvOptions } from "../../lib/database/api";
import {
  defaultExportPath,
  edited,
  pickSavePath,
  refreshSchema,
  toast,
  update,
  useDatabaseStore,
  writeExport,
  type Dialog,
} from "../../lib/database/databaseStore";
import {
  COLUMN_TYPES,
  createIndexSql,
  createTableSql,
  modifyTableSql,
  newField,
  tableDefOf,
  type FieldDef,
  type IndexDef,
  type TableDef,
} from "../../lib/database/sql";
import { formatCount } from "../../lib/database/values";
import { SqlBlock } from "./StructureTab";

/** A modal over the database view. */
function Modal({ title, wide, onClose, children, footer, className }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode; footer: React.ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="db-modal-backdrop" onMouseDown={onClose}>
      <div className={`db-modal${wide ? " wide" : ""} ${className ?? ""}`} role="dialog" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="db-modal-title">{title}</div>
        <div className="db-modal-body">{children}</div>
        <div className="db-modal-footer">{footer}</div>
      </div>
    </div>
  );
}

/** Run generated SQL in the edit transaction; returns an error message or null. */
async function runSql(path: string, sql: string): Promise<string | null> {
  try {
    const result = await db.execute(path, sql);
    const failed = result.statements.find((statement) => statement.kind === "error");
    edited(path, result.dirty);
    await refreshSchema(path, true);
    return failed ? `${failed.error} (line ${failed.errorLine ?? failed.line})` : null;
  } catch (error) {
    return String(error);
  }
}

/** Create Table / Modify Table: columns with their constraints, and the SQL. */
function TableEditor({ path, modify }: { path: string; modify: string | null }) {
  const schema = useDatabaseStore((state) => state.docs[path]?.schema ?? null);
  const dirty = useDatabaseStore((state) => state.docs[path]?.dirty ?? false);
  const original = modify ? schema?.tables.find((table) => table.name === modify) : undefined;
  const initial = useMemo<TableDef>(
    () =>
      original
        ? tableDefOf(original)
        : { name: "", fields: [newField({ name: "id", type: "INTEGER", pk: true, ai: true, nn: true }), newField({ name: "", type: "TEXT" })], withoutRowid: false, strict: false, extra: [], foreignKeys: [], uniques: [] },
    [original],
  );
  const [def, setDef] = useState<TableDef>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const close = () => update(path, { dialog: null });

  const plan = useMemo(() => {
    if (!original || !schema) return { sql: createTableSql(def), rebuild: false, notes: [] as string[] };
    return modifyTableSql(original, initial, def, schema);
  }, [def, original, initial, schema]);

  const named = def.fields.filter((field) => field.name.trim());
  const duplicate = named.find((field, index) => named.findIndex((other) => other.name.trim().toLowerCase() === field.name.trim().toLowerCase()) !== index);
  const exists = !original && schema?.tables.some((table) => table.name.toLowerCase() === def.name.trim().toLowerCase());
  const problem = !def.name.trim()
    ? "Name the table."
    : named.length === 0
      ? "Add at least one field."
      : duplicate
        ? `Two fields are named ${duplicate.name}.`
        : exists
          ? `There's already a table ${def.name}.`
          : def.withoutRowid && !named.some((field) => field.pk)
            ? "A WITHOUT ROWID table needs a primary key."
            : plan.rebuild && dirty
              ? "This change rebuilds the table: Write or Revert your other changes first."
              : null;

  const setField = (id: string, patch: Partial<FieldDef>) =>
    setDef((current) => ({ ...current, fields: current.fields.map((field) => (field.id === id ? { ...field, ...patch } : field)) }));
  const move = (direction: -1 | 1) => {
    if (!selected) return;
    setDef((current) => {
      const fields = [...current.fields];
      const index = fields.findIndex((field) => field.id === selected);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= fields.length) return current;
      [fields[index], fields[target]] = [fields[target], fields[index]];
      return { ...current, fields };
    });
  };

  const submit = async () => {
    if (problem || running || (original && !plan.sql.trim())) return;
    setRunning(true);
    setError(null);
    const failure = plan.rebuild ? await runModify(path, plan.sql) : await runSql(path, plan.sql);
    setRunning(false);
    if (failure) {
      setError(failure);
      return;
    }
    close();
    toast(path, `${original ? "Modified" : "Created"} table ${def.name.trim()}. Write Changes to keep it.`);
    update(path, { selected: `table:${def.name.trim()}` });
  };

  return (
    <Modal
      title={original ? `Modify Table — ${original.name}` : "Create Table"}
      wide
      onClose={close}
      className="db-table-editor"
      footer={
        <>
          {error ? <span className="db-modal-error">{error}</span> : problem ? <span className="db-modal-hint">{problem}</span> : <span />}
          <span className="db-toolbar-spacer" />
          <button className="db-button" onClick={close}>
            Cancel
          </button>
          <button className="db-button primary" disabled={!!problem || running || (!!original && !plan.sql.trim())} onClick={() => void submit()}>
            {original ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <div className="db-form-row">
        <label className="db-field grow">
          <span>Table name</span>
          <input autoFocus={!original} value={def.name} spellCheck={false} onChange={(event) => setDef({ ...def, name: event.target.value })} placeholder="e.g. customers" />
        </label>
        <label className="db-check">
          <input type="checkbox" checked={def.withoutRowid} onChange={(event) => setDef({ ...def, withoutRowid: event.target.checked })} />
          WITHOUT ROWID
        </label>
        <label className="db-check">
          <input type="checkbox" checked={def.strict} onChange={(event) => setDef({ ...def, strict: event.target.checked })} />
          STRICT
        </label>
      </div>
      <div className="db-fields-bar">
        <span className="db-section-title">Fields</span>
        <span className="db-toolbar-spacer" />
        <button className="db-tool" onClick={() => {
          const field = newField({ name: `field${def.fields.length + 1}` });
          setDef({ ...def, fields: [...def.fields, field] });
          setSelected(field.id);
        }}>
          <Plus size={13} strokeWidth={1.8} /> <span>Add</span>
        </button>
        <button className="db-tool" disabled={!selected} onClick={() => {
          setDef({ ...def, fields: def.fields.filter((field) => field.id !== selected) });
          setSelected(null);
        }}>
          <Trash2 size={13} strokeWidth={1.6} /> <span>Remove</span>
        </button>
        <button className="db-tool" disabled={!selected} title="Move up" onClick={() => move(-1)}>
          <ArrowUp size={13} strokeWidth={1.8} />
        </button>
        <button className="db-tool" disabled={!selected} title="Move down" onClick={() => move(1)}>
          <ArrowDown size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div className="db-fields">
        <div className="db-fields-head">
          <span>Name</span>
          <span>Type</span>
          <span title="Primary key">PK</span>
          <span title="Autoincrement">AI</span>
          <span title="Not null">NN</span>
          <span title="Unique">U</span>
          <span>Default</span>
          <span>Check</span>
          <span>Collation</span>
        </div>
        <datalist id="db-types">
          {COLUMN_TYPES.map((type) => (
            <option key={type} value={type} />
          ))}
        </datalist>
        {def.fields.map((field) => (
          <div key={field.id} className={`db-fields-row${selected === field.id ? " selected" : ""}`} onMouseDown={() => setSelected(field.id)} onFocus={() => setSelected(field.id)}>
            <input value={field.name} spellCheck={false} placeholder="name" onChange={(event) => setField(field.id, { name: event.target.value })} />
            <input value={field.type} spellCheck={false} list="db-types" onChange={(event) => setField(field.id, { type: event.target.value })} />
            <input type="checkbox" checked={field.pk} onChange={(event) => setField(field.id, { pk: event.target.checked, ai: event.target.checked && field.ai })} />
            <input type="checkbox" checked={field.ai} disabled={!field.pk || !/^integer$/i.test(field.type.trim())} title="AUTOINCREMENT (INTEGER PRIMARY KEY only)" onChange={(event) => setField(field.id, { ai: event.target.checked })} />
            <input type="checkbox" checked={field.nn} onChange={(event) => setField(field.id, { nn: event.target.checked })} />
            <input type="checkbox" checked={field.unique} onChange={(event) => setField(field.id, { unique: event.target.checked })} />
            <input value={field.default} spellCheck={false} placeholder="" onChange={(event) => setField(field.id, { default: event.target.value })} />
            <input value={field.check} spellCheck={false} placeholder="" onChange={(event) => setField(field.id, { check: event.target.value })} />
            <input value={field.collate} spellCheck={false} placeholder="" list="db-collations" onChange={(event) => setField(field.id, { collate: event.target.value })} />
          </div>
        ))}
        <datalist id="db-collations">
          <option value="BINARY" />
          <option value="NOCASE" />
          <option value="RTRIM" />
        </datalist>
      </div>
      <div className="db-section-title">SQL</div>
      <SqlBlock sql={plan.sql || "-- No changes"} className="db-modal-sql" />
      {plan.notes.length > 0 && (
        <ul className="db-notes">
          {plan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** A table rebuild runs with foreign keys off (so dropping doesn't cascade). */
async function runModify(path: string, sql: string): Promise<string | null> {
  try {
    const result = await db.executeRebuild(path, sql);
    const failed = result.statements.find((statement) => statement.kind === "error");
    edited(path, result.dirty);
    await refreshSchema(path, true);
    return failed ? `${failed.error} (line ${failed.errorLine ?? failed.line})` : null;
  } catch (error) {
    return String(error);
  }
}

function CreateIndex({ path, table: initialTable }: { path: string; table: string | null }) {
  const schema = useDatabaseStore((state) => state.docs[path]?.schema ?? null);
  const tables = (schema?.tables ?? []).filter((table) => !table.system && !table.virtual);
  const [def, setDef] = useState<IndexDef>(() => ({ name: "", table: initialTable && tables.some((table) => table.name === initialTable) ? initialTable : (tables[0]?.name ?? ""), unique: false, columns: [], where: "" }));
  const [error, setError] = useState<string | null>(null);
  const table = tables.find((candidate) => candidate.name === def.table);
  const close = () => update(path, { dialog: null });
  const name = def.name.trim() || (def.columns.length ? `${def.table}_${def.columns.map((column) => column.name).join("_")}` : "");
  const sql = def.columns.length ? createIndexSql({ ...def, name }) : "";
  const problem = !def.table ? "Choose a table." : def.columns.length === 0 ? "Choose the columns to index." : null;
  const toggle = (column: string) =>
    setDef((current) => ({
      ...current,
      columns: current.columns.some((candidate) => candidate.name === column) ? current.columns.filter((candidate) => candidate.name !== column) : [...current.columns, { name: column, desc: false }],
    }));
  return (
    <Modal
      title="Create Index"
      onClose={close}
      footer={
        <>
          {error ? <span className="db-modal-error">{error}</span> : problem ? <span className="db-modal-hint">{problem}</span> : <span />}
          <span className="db-toolbar-spacer" />
          <button className="db-button" onClick={close}>
            Cancel
          </button>
          <button
            className="db-button primary"
            disabled={!!problem}
            onClick={async () => {
              const failure = await runSql(path, sql);
              if (failure) return setError(failure);
              close();
              toast(path, `Created index ${name}. Write Changes to keep it.`);
            }}
          >
            Create
          </button>
        </>
      }
    >
      <div className="db-form-row">
        <label className="db-field grow">
          <span>Index name</span>
          <input value={def.name} placeholder={name || "e.g. orders_by_date"} spellCheck={false} onChange={(event) => setDef({ ...def, name: event.target.value })} />
        </label>
        <label className="db-field">
          <span>Table</span>
          <select value={def.table} onChange={(event) => setDef({ ...def, table: event.target.value, columns: [] })}>
            {tables.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label className="db-check">
          <input type="checkbox" checked={def.unique} onChange={(event) => setDef({ ...def, unique: event.target.checked })} />
          Unique
        </label>
      </div>
      <div className="db-section-title">Columns</div>
      <div className="db-index-columns">
        {(table?.columns ?? []).filter((column) => column.hidden === 0).map((column) => {
          const chosen = def.columns.find((candidate) => candidate.name === column.name);
          const order = chosen ? def.columns.indexOf(chosen) + 1 : null;
          return (
            <div key={column.name} className={`db-index-column${chosen ? " on" : ""}`}>
              <label className="db-check">
                <input type="checkbox" checked={!!chosen} onChange={() => toggle(column.name)} />
                <span className="mono">{column.name}</span>
                <span className="db-dim">{column.type}</span>
              </label>
              <span className="db-index-order">{order ?? ""}</span>
              <select
                disabled={!chosen}
                value={chosen?.desc ? "DESC" : "ASC"}
                onChange={(event) => setDef({ ...def, columns: def.columns.map((candidate) => (candidate.name === column.name ? { ...candidate, desc: event.target.value === "DESC" } : candidate)) })}
              >
                <option>ASC</option>
                <option>DESC</option>
              </select>
            </div>
          );
        })}
      </div>
      <label className="db-field">
        <span>Partial index (WHERE, optional)</span>
        <input value={def.where} spellCheck={false} placeholder="e.g. deleted_at IS NULL" onChange={(event) => setDef({ ...def, where: event.target.value })} />
      </label>
      <div className="db-section-title">SQL</div>
      <SqlBlock sql={sql || "-- Choose columns"} className="db-modal-sql" />
    </Modal>
  );
}

const SEPARATORS: [string, string][] = [
  [",", "Comma ,"],
  [";", "Semicolon ;"],
  ["\\t", "Tab"],
  ["|", "Pipe |"],
];
const QUOTES: [string, string][] = [
  ['"', 'Double "'],
  ["'", "Single '"],
  ["", "None"],
];

function ImportCsv({ path, file, text }: { path: string; file: string; text: string | null }) {
  const schema = useDatabaseStore((state) => state.docs[path]?.schema ?? null);
  const fileName = file.split(/[/\\]/).pop() ?? file;
  const [table, setTable] = useState(fileName.replace(/\.[^.]+$/, "").replace(/[^\w]+/g, "_"));
  const [options, setOptions] = useState<CsvOptions>({ separator: fileName.toLowerCase().endsWith(".tsv") ? "\\t" : ",", quote: '"', header: true });
  const [preview, setPreview] = useState<{ columns: string[]; rows: string[][]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const input = text !== null ? { text } : { file };
  const close = () => update(path, { dialog: null });
  const existing = schema?.tables.find((candidate) => candidate.name.toLowerCase() === table.trim().toLowerCase());

  useEffect(() => {
    let cancelled = false;
    void db.csvPreview(input, options, 12).then(
      (result) => {
        if (cancelled) return;
        setPreview(result);
        setError(null);
      },
      (failure) => !cancelled && setError(String(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [options.separator, options.quote, options.header]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setRunning(true);
    try {
      const result = await db.importCsv(path, table.trim(), input, options);
      edited(path, result.dirty, true);
      await refreshSchema(path, true);
      close();
      update(path, { table: table.trim(), tab: "browse" });
      toast(path, `Imported ${formatCount(result.rows)} rows into ${result.created ? "new table " : ""}${table.trim()}. Write Changes to keep them.`);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`Import CSV — ${fileName}`}
      wide
      onClose={close}
      footer={
        <>
          {error ? <span className="db-modal-error">{error}</span> : <span className="db-modal-hint">{preview ? `${formatCount(preview.total)} rows · ${existing ? `appended to ${existing.name}` : "a new table"}` : "Reading…"}</span>}
          <span className="db-toolbar-spacer" />
          <button className="db-button" onClick={close}>
            Cancel
          </button>
          <button className="db-button primary" disabled={!table.trim() || !preview || running} onClick={() => void submit()}>
            {running ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <div className="db-form-row">
        <label className="db-field grow">
          <span>Table (new, or an existing one to append to)</span>
          <input value={table} spellCheck={false} list="db-import-tables" onChange={(event) => setTable(event.target.value)} />
          <datalist id="db-import-tables">
            {schema?.tables.filter((candidate) => !candidate.system).map((candidate) => <option key={candidate.name} value={candidate.name} />)}
          </datalist>
        </label>
      </div>
      <div className="db-form-row">
        <label className="db-check">
          <input type="checkbox" checked={options.header} onChange={(event) => setOptions({ ...options, header: event.target.checked })} />
          Column names in first line
        </label>
        <label className="db-field">
          <span>Separator</span>
          <select value={options.separator} onChange={(event) => setOptions({ ...options, separator: event.target.value })}>
            {SEPARATORS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="db-field">
          <span>Quote</span>
          <select value={options.quote} onChange={(event) => setOptions({ ...options, quote: event.target.value })}>
            {QUOTES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="db-field">
          <span>Encoding</span>
          <select value="UTF-8" disabled>
            <option>UTF-8</option>
          </select>
        </label>
      </div>
      <div className="db-section-title">Preview</div>
      <div className="db-preview">
        {preview && (
          <table>
            <thead>
              <tr>
                {preview.columns.map((column, index) => (
                  <th key={index}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, index) => (
                <tr key={index}>
                  {preview.columns.map((_, column) => (
                    <td key={column}>{row[column] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

function Export({ path, format: initialFormat, table: initialTable }: { path: string; format: "csv" | "json" | "sql"; table: string | null }) {
  const schema = useDatabaseStore((state) => state.docs[path]?.schema ?? null);
  const sources = [...(schema?.tables ?? []).filter((table) => !table.system && !table.shadow), ...(schema?.views ?? [])];
  const [format, setFormat] = useState(initialFormat);
  const [table, setTable] = useState(initialTable && sources.some((source) => source.name === initialTable) ? initialTable : (sources[0]?.name ?? ""));
  const [options, setOptions] = useState<CsvOptions>({ separator: ",", quote: '"', header: true, newline: "\n" });
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((schema?.tables ?? []).filter((candidate) => !candidate.system).map((candidate) => candidate.name)));
  const [what, setWhat] = useState<"both" | "schema" | "data">("both");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => update(path, { dialog: null });
  const allTables = (schema?.tables ?? []).filter((candidate) => !candidate.system);

  const submit = async () => {
    const stem = path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "export";
    const extension = format === "sql" ? "sql" : format;
    const file = await pickSavePath(defaultExportPath(path, format === "sql" ? stem : table, extension), format.toUpperCase(), [extension]);
    if (!file) return;
    setRunning(true);
    try {
      const rows =
        format === "csv"
          ? await writeExport((target) => db.exportCsv(path, { table }, options, target), file)
          : format === "json"
            ? await writeExport((target) => db.exportJson(path, { table }, target), file)
            : await writeExport(
                (target) =>
                  db.exportSql(
                    path,
                    { tables: chosen.size === allTables.length ? undefined : [...chosen], schema: what !== "data", data: what !== "schema" },
                    target,
                  ),
                file,
              );
      close();
      toast(path, `Exported ${formatCount(rows)} ${format === "sql" ? "INSERT statements" : "rows"} to ${file.split(/[/\\]/).pop()}.`);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title="Export"
      onClose={close}
      footer={
        <>
          {error ? <span className="db-modal-error">{error}</span> : <span />}
          <span className="db-toolbar-spacer" />
          <button className="db-button" onClick={close}>
            Cancel
          </button>
          <button className="db-button primary" disabled={running || (format !== "sql" && !table) || (format === "sql" && chosen.size === 0)} onClick={() => void submit()}>
            {running ? "Exporting…" : "Export…"}
          </button>
        </>
      }
    >
      <div className="db-seg wide">
        {(["csv", "json", "sql"] as const).map((candidate) => (
          <button key={candidate} className={format === candidate ? "on" : ""} onClick={() => setFormat(candidate)}>
            {candidate === "csv" ? "Table as CSV" : candidate === "json" ? "Table as JSON" : "Database as SQL"}
          </button>
        ))}
      </div>
      {format !== "sql" ? (
        <>
          <label className="db-field">
            <span>Table or view</span>
            <select value={table} onChange={(event) => setTable(event.target.value)}>
              {sources.map((source) => (
                <option key={source.name} value={source.name}>
                  {source.name}
                  {source.type === "view" ? " (view)" : ""}
                </option>
              ))}
            </select>
          </label>
          {format === "csv" && (
            <div className="db-form-row">
              <label className="db-check">
                <input type="checkbox" checked={options.header} onChange={(event) => setOptions({ ...options, header: event.target.checked })} />
                Column names in first line
              </label>
              <label className="db-field">
                <span>Separator</span>
                <select value={options.separator} onChange={(event) => setOptions({ ...options, separator: event.target.value })}>
                  {SEPARATORS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="db-field">
                <span>Quote</span>
                <select value={options.quote} onChange={(event) => setOptions({ ...options, quote: event.target.value })}>
                  {QUOTES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="db-field">
                <span>New line</span>
                <select value={options.newline} onChange={(event) => setOptions({ ...options, newline: event.target.value as "\n" | "\r\n" })}>
                  <option value={"\n"}>LF (Unix)</option>
                  <option value={"\r\n"}>CRLF (Windows)</option>
                </select>
              </label>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="db-section-title">Tables</div>
          <div className="db-export-tables">
            {allTables.map((candidate) => (
              <label key={candidate.name} className="db-check">
                <input
                  type="checkbox"
                  checked={chosen.has(candidate.name)}
                  onChange={(event) => {
                    const next = new Set(chosen);
                    if (event.target.checked) next.add(candidate.name);
                    else next.delete(candidate.name);
                    setChosen(next);
                  }}
                />
                <span className="mono">{candidate.name}</span>
              </label>
            ))}
          </div>
          <div className="db-form-row">
            <label className="db-field">
              <span>Export</span>
              <select value={what} onChange={(event) => setWhat(event.target.value as typeof what)}>
                <option value="both">Schema and data</option>
                <option value="schema">Schema only</option>
                <option value="data">Data only</option>
              </select>
            </label>
          </div>
        </>
      )}
    </Modal>
  );
}

function Confirm({ path, dialog }: { path: string; dialog: Extract<Dialog, { kind: "confirm" }> }) {
  const choose = (value: string) => {
    update(path, { dialog: null });
    dialog.resolve(value);
  };
  const primary = dialog.buttons.find((button) => button.primary);
  return (
    <Modal
      title={dialog.title}
      onClose={() => choose(dialog.buttons[0]?.value ?? "cancel")}
      className="db-confirm"
      footer={
        <>
          <span className="db-toolbar-spacer" />
          {dialog.buttons.map((button) => (
            <button
              key={button.value}
              className={`db-button${button.primary ? " primary" : ""}${button.danger ? " danger" : ""}`}
              autoFocus={button === primary}
              onClick={() => choose(button.value)}
            >
              {button.label}
            </button>
          ))}
        </>
      }
    >
      <p className="db-confirm-message">{dialog.message}</p>
      {dialog.detail && <p className="db-confirm-detail">{dialog.detail}</p>}
    </Modal>
  );
}

function Integrity({ path, ok, lines }: { path: string; ok: boolean; lines: string[] }) {
  const close = () => update(path, { dialog: null });
  return (
    <Modal
      title="Integrity Check"
      onClose={close}
      footer={
        <>
          <span className="db-toolbar-spacer" />
          <button className="db-button primary" autoFocus onClick={close}>
            OK
          </button>
        </>
      }
    >
      <div className={`db-integrity ${ok ? "ok" : "bad"}`}>
        {ok ? <CircleCheck size={18} strokeWidth={1.6} /> : <CircleAlert size={18} strokeWidth={1.6} />}
        <span>{ok ? "No problems found: the database file and its foreign keys are intact." : `${lines.length} problem${lines.length === 1 ? "" : "s"} found.`}</span>
      </div>
      {!ok && <pre className="db-integrity-list">{lines.join("\n")}</pre>}
    </Modal>
  );
}

/** Whichever dialog the database view has open. */
export function DatabaseDialogs({ path }: { path: string }) {
  const dialog = useDatabaseStore((state) => state.docs[path]?.dialog ?? null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "createTable":
      return <TableEditor key="create" path={path} modify={null} />;
    case "modifyTable":
      return <TableEditor key={`modify:${dialog.table}`} path={path} modify={dialog.table} />;
    case "createIndex":
      return <CreateIndex path={path} table={dialog.table} />;
    case "importCsv":
      return <ImportCsv path={path} file={dialog.file} text={dialog.text} />;
    case "export":
      return <Export path={path} format={dialog.format} table={dialog.table} />;
    case "confirm":
      return <Confirm path={path} dialog={dialog} />;
    case "integrity":
      return <Integrity path={path} ok={dialog.ok} lines={dialog.lines} />;
  }
}

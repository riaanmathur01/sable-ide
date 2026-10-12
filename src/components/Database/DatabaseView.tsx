import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Database,
  FileCode,
  FileInput,
  FileOutput,
  FolderOpen,
  FolderSearch,
  ListTree,
  Lock,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Undo2,
} from "lucide-react";
import { monaco } from "../../lib/monacoSetup";
import { useColorTheme } from "../../store/settingsStore";
import {
  ensureDatabase,
  installDatabaseSupport,
  integrityCheck,
  openSqlFile,
  refreshSchema,
  revealDatabase,
  revertChanges,
  saveSqlFile,
  startImport,
  update,
  useDatabaseStore,
  vacuum,
  writeChanges,
  type DbTab,
} from "../../lib/database/databaseStore";
import { formatBytes } from "../../lib/database/values";
import { StructureTab } from "./StructureTab";
import { BrowseTab } from "./BrowseTab";
import { ExecuteTab } from "./ExecuteTab";
import { PragmasTab } from "./PragmasTab";
import { DatabaseDialogs } from "./Dialogs";
import "./Database.css";

installDatabaseSupport();

const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";

const TABS: { id: DbTab; label: string; icon: typeof Table2 }[] = [
  { id: "structure", label: "Database Structure", icon: ListTree },
  { id: "browse", label: "Browse Data", icon: Table2 },
  { id: "pragmas", label: "Edit Pragmas", icon: SlidersHorizontal },
  { id: "execute", label: "Execute SQL", icon: Play },
];

function Tool({ title, onClick, disabled, children, label, className }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; label?: string; className?: string }) {
  return (
    <button className={`db-tool ${className ?? ""}`} title={title} onClick={onClick} disabled={disabled}>
      {children}
      {label && <span>{label}</span>}
    </button>
  );
}

/** Export ▾: the table as CSV or JSON, the database as SQL. */
function ExportMenu({ path, disabled }: { path: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const choose = (format: "csv" | "json" | "sql") => {
    setOpen(false);
    const table = useDatabaseStore.getState().docs[path]?.table ?? null;
    update(path, { dialog: { kind: "export", format, table: format === "sql" ? null : table } });
  };
  return (
    <div className="db-menu-anchor" ref={root}>
      <button className="db-tool" title="Export" disabled={disabled} onClick={() => setOpen((value) => !value)}>
        <FileOutput size={14} strokeWidth={1.6} />
        <span>Export</span>
        <ChevronDown size={11} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="db-menu">
          <button onClick={() => choose("csv")}>Table as CSV…</button>
          <button onClick={() => choose("json")}>Table as JSON…</button>
          <button onClick={() => choose("sql")}>Database as SQL…</button>
        </div>
      )}
    </div>
  );
}

/**
 * A SQLite database, like DB Browser for SQLite: its structure, its data
 * (browse, filter, edit), pragmas, and a SQL editor. Edits stay in a
 * transaction until Write Changes (⌘S); Revert Changes drops them.
 */
export default function DatabaseView({ path, active }: { path: string; active: boolean }) {
  useEffect(() => ensureDatabase(path), [path]);
  const schema = useDatabaseStore((state) => state.docs[path]?.schema ?? null);
  const error = useDatabaseStore((state) => state.docs[path]?.error ?? null);
  const dirty = useDatabaseStore((state) => state.docs[path]?.dirty ?? false);
  const readOnly = useDatabaseStore((state) => state.docs[path]?.readOnly ?? false);
  const tab = useDatabaseStore((state) => state.docs[path]?.tab ?? "browse");
  const busy = useDatabaseStore((state) => state.docs[path]?.busy ?? null);
  const toast = useDatabaseStore((state) => state.docs[path]?.toast ?? null);
  const colorTheme = useColorTheme();
  useEffect(() => monaco.editor.setTheme(colorTheme), [colorTheme]);

  if (error) {
    return (
      <div className="db-root db-message">
        <Database size={28} strokeWidth={1.2} />
        <p>{error}</p>
        <button className="db-button" onClick={() => revealDatabase(path)}>
          Reveal in Explorer
        </button>
      </div>
    );
  }
  if (!schema) {
    return <div className="db-root db-message">Opening database…</div>;
  }

  const name = path.split(/[/\\]/).pop() ?? path;
  return (
    <div className="db-root" data-tab={tab}>
      <div className="db-toolbar">
        <div className="db-toolbar-group">
          <Tool className={dirty ? "attention" : ""} title={`Write Changes (${MOD}S)`} label="Write Changes" disabled={!dirty} onClick={() => void writeChanges(path)}>
            <Save size={14} strokeWidth={1.6} />
          </Tool>
          <Tool title="Revert Changes" label="Revert Changes" disabled={!dirty} onClick={() => void revertChanges(path)}>
            <Undo2 size={14} strokeWidth={1.6} />
          </Tool>
        </div>
        <div className="db-toolbar-separator" />
        <div className="db-toolbar-group">
          <Tool title="Open SQL File… (into Execute SQL)" onClick={() => void openSqlFile(path)}>
            <FolderOpen size={14} strokeWidth={1.6} />
          </Tool>
          <Tool title="Save SQL File" onClick={() => {
            update(path, { tab: "execute" });
            void saveSqlFile(path);
          }}>
            <FileCode size={14} strokeWidth={1.6} />
          </Tool>
        </div>
        <div className="db-toolbar-separator" />
        <div className="db-toolbar-group">
          <Tool title="Import a CSV file into a table" label="Import" disabled={readOnly} onClick={() => void startImport(path)}>
            <FileInput size={14} strokeWidth={1.6} />
          </Tool>
          <ExportMenu path={path} disabled={false} />
        </div>
        <div className="db-toolbar-separator" />
        <div className="db-toolbar-group">
          <Tool title="Integrity Check" onClick={() => void integrityCheck(path)}>
            <ShieldCheck size={14} strokeWidth={1.6} />
          </Tool>
          <Tool title="Vacuum (compact the file)" disabled={readOnly} onClick={() => void vacuum(path)}>
            <Sparkles size={14} strokeWidth={1.6} />
          </Tool>
          <Tool title="Refresh" onClick={() => void refreshSchema(path, true)}>
            <RefreshCw size={13} strokeWidth={1.6} />
          </Tool>
          <Tool title="Reveal in Explorer" onClick={() => revealDatabase(path)}>
            <FolderSearch size={14} strokeWidth={1.6} />
          </Tool>
        </div>
        <div className="db-toolbar-spacer" />
        {busy && <span className="db-busy">{busy}</span>}
        <div className="db-fileinfo" title={path}>
          {readOnly && (
            <span className="db-badge" title="The file can't be written: changes are disabled">
              <Lock size={11} strokeWidth={2} /> Read-only
            </span>
          )}
          {dirty && <span className="db-badge accent">Unwritten changes</span>}
          <span className="db-fileinfo-text">
            {name}
            {schema.fileSize !== null && <> · {formatBytes(schema.fileSize)}</>}
            {schema.journalMode && <> · {schema.journalMode.toUpperCase()}</>}
            <> · SQLite {schema.sqliteVersion}</>
          </span>
        </div>
      </div>
      <div className="db-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "db-tab active" : "db-tab"} onClick={() => update(path, { tab: id })}>
            <Icon size={13} strokeWidth={1.6} />
            {label}
          </button>
        ))}
      </div>
      <div className="db-pages">
        <div className="db-page" style={{ display: tab === "structure" ? "flex" : "none" }}>
          <StructureTab path={path} />
        </div>
        <div className="db-page" style={{ display: tab === "browse" ? "flex" : "none" }}>
          <BrowseTab path={path} active={active && tab === "browse"} />
        </div>
        <div className="db-page" style={{ display: tab === "pragmas" ? "flex" : "none" }}>
          {tab === "pragmas" && <PragmasTab path={path} />}
        </div>
        <div className="db-page" style={{ display: tab === "execute" ? "flex" : "none" }}>
          <ExecuteTab path={path} active={active && tab === "execute"} />
        </div>
      </div>
      {toast && (
        <div key={toast.id} className={`db-toast ${toast.kind}`} onClick={() => update(path, { toast: null })}>
          {toast.text}
        </div>
      )}
      <DatabaseDialogs path={path} />
    </div>
  );
}

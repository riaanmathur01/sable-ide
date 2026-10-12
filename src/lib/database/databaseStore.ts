import { create } from "zustand";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { db, type ExecuteResult, type Schema, type SortSpec, type TableInfo } from "./api";
import { databaseHooks, databaseTabKey, type DatabaseCommand } from "./hooks";
import { invokeLocal, isRemoteActive } from "../backend";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { formatCount } from "./values";

export type DbTab = "structure" | "browse" | "pragmas" | "execute";

export interface BrowseState {
  sort: SortSpec | null;
  filters: Record<string, string>;
  search: string;
  widths: Record<string, number>;
}

export interface SqlRun {
  id: number;
  /** The SQL that ran (for Run Current: just that statement). */
  sql: string;
  /** Where it starts in the editor (error lines are relative to the editor). */
  lineOffset: number;
  running: boolean;
  result: ExecuteResult | null;
  error: string | null;
  ms: number;
}

export interface SqlTab {
  id: string;
  title: string;
  text: string;
  file: string | null;
  run: SqlRun | null;
}

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export type Dialog =
  | { kind: "createTable" }
  | { kind: "modifyTable"; table: string }
  | { kind: "createIndex"; table: string | null }
  | { kind: "importCsv"; file: string; text: string | null }
  | { kind: "export"; format: "csv" | "json" | "sql"; table: string | null }
  | { kind: "integrity"; ok: boolean; lines: string[] }
  | { kind: "confirm"; title: string; message: string; detail?: string; buttons: DialogButton[]; resolve: (value: string) => void };

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

export interface DbDoc {
  path: string;
  schema: Schema | null;
  error: string | null;
  dirty: boolean;
  readOnly: boolean;
  /** Bumps when rows may have changed: grids refetch. */
  dataVersion: number;
  tab: DbTab;
  table: string | null;
  browse: Record<string, BrowseState>;
  /** The Structure tab's selected object (`table:name`, `index:name`…). */
  selected: string | null;
  sqlTabs: SqlTab[];
  activeSql: string;
  editPane: boolean;
  dialog: Dialog | null;
  toast: Toast | null;
  busy: string | null;
}

interface DatabaseStore {
  docs: Record<string, DbDoc>;
}

export const useDatabaseStore = create<DatabaseStore>(() => ({ docs: {} }));

const docOf = (path: string) => useDatabaseStore.getState().docs[path];

export function update(path: string, change: Partial<DbDoc> | ((doc: DbDoc) => Partial<DbDoc>)) {
  useDatabaseStore.setState((state) => {
    const doc = state.docs[path];
    if (!doc) return state;
    const patch = typeof change === "function" ? change(doc) : change;
    return { docs: { ...state.docs, [path]: { ...doc, ...patch } } };
  });
}

let sqlCounter = 0;
export function newSqlTab(text = "", title?: string, file: string | null = null): SqlTab {
  sqlCounter += 1;
  return { id: `sql-${sqlCounter}`, title: title ?? `SQL ${sqlCounter}`, text, file, run: null };
}

/** SQL tabs are remembered per database (this browser profile). */
const SQL_KEY = "sable.database.sql:";
function savedSqlTabs(path: string): SqlTab[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SQL_KEY + path) ?? "null") as { title: string; text: string; file: string | null }[] | null;
    if (Array.isArray(saved) && saved.length > 0) return saved.map((tab) => newSqlTab(tab.text, tab.title, tab.file));
  } catch {
    /* ignore */
  }
  return [newSqlTab("", "SQL 1")];
}

/** The SQL tabs last saved, per database. */
const savedSql = new Map<string, SqlTab[]>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useDatabaseStore.subscribe(() => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    for (const [path, doc] of Object.entries(useDatabaseStore.getState().docs)) {
      if (savedSql.get(path) === doc.sqlTabs) continue;
      savedSql.set(path, doc.sqlTabs);
      try {
        localStorage.setItem(SQL_KEY + path, JSON.stringify(doc.sqlTabs.map(({ title, text, file }) => ({ title, text, file }))));
      } catch {
        /* quota */
      }
    }
  }, 500);
});

const HISTORY_KEY = "sable.database.history";
export function sqlHistory(): { sql: string; at: number; path: string }[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}
export function addHistory(path: string, sql: string) {
  const text = sql.trim();
  if (!text) return;
  const list = sqlHistory().filter((entry) => entry.sql !== text);
  list.unshift({ sql: text, at: Date.now(), path });
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 200)));
  } catch {
    /* quota */
  }
}

let toastCounter = 0;
export function toast(path: string, text: string, kind: Toast["kind"] = "info") {
  toastCounter += 1;
  const id = toastCounter;
  update(path, { toast: { id, kind, text } });
  setTimeout(() => {
    if (docOf(path)?.toast?.id === id) update(path, { toast: null });
  }, kind === "error" ? 9000 : 4000);
}

function setDirty(path: string, dirty: boolean) {
  update(path, { dirty });
  useTabsStore.getState().setTabDirty(databaseTabKey(path), dirty);
}

/** The tables to browse first: user tables, then the rest. */
export function browsable(schema: Schema | null): TableInfo[] {
  if (!schema) return [];
  return [...schema.tables.filter((table) => !table.system && !table.shadow), ...schema.views, ...schema.tables.filter((table) => table.system || table.shadow)];
}

/** Open a database (the view calls this when it mounts). */
export function ensureDatabase(path: string) {
  if (docOf(path)) return;
  const doc: DbDoc = {
    path,
    schema: null,
    error: null,
    dirty: false,
    readOnly: false,
    dataVersion: 0,
    tab: "browse",
    table: null,
    browse: {},
    selected: null,
    sqlTabs: savedSqlTabs(path),
    activeSql: "",
    editPane: false,
    dialog: null,
    toast: null,
    busy: null,
  };
  doc.activeSql = doc.sqlTabs[0].id;
  useDatabaseStore.setState((state) => ({ docs: { ...state.docs, [path]: doc } }));
  db.open(path).then(
    (schema) => {
      const first = browsable(schema)[0]?.name ?? null;
      update(path, { schema, readOnly: schema.readOnly, table: first, tab: first ? "browse" : "structure" });
      setDirty(path, schema.dirty);
    },
    (error) => update(path, { error: String(error) }),
  );
}

/** Re-read the schema (after structure changes); `data` also refetches rows. */
export async function refreshSchema(path: string, data = true) {
  try {
    const schema = await db.schema(path);
    update(path, (doc) => {
      const names = new Set([...schema.tables, ...schema.views].map((table) => table.name));
      const table = doc.table && names.has(doc.table) ? doc.table : (browsable(schema)[0]?.name ?? null);
      return { schema, table, readOnly: schema.readOnly, dataVersion: data ? doc.dataVersion + 1 : doc.dataVersion };
    });
    setDirty(path, schema.dirty);
  } catch (error) {
    toast(path, String(error), "error");
  }
}

/** After an edit: the dirty flag (and maybe rows) changed. */
export function edited(path: string, dirty: boolean, rows = false) {
  setDirty(path, dirty);
  if (rows) update(path, (doc) => ({ dataVersion: doc.dataVersion + 1 }));
}

export async function writeChanges(path: string): Promise<boolean> {
  if (!docOf(path)?.dirty) return true;
  try {
    const result = await db.commit(path);
    setDirty(path, result.dirty);
    await refreshSchema(path, false);
    toast(path, "Changes written to the database.");
    return true;
  } catch (error) {
    toast(path, String(error), "error");
    return false;
  }
}

export async function revertChanges(path: string): Promise<boolean> {
  try {
    const result = await db.rollback(path);
    setDirty(path, result.dirty);
    await refreshSchema(path, true);
    toast(path, "Changes reverted.");
    return true;
  } catch (error) {
    toast(path, String(error), "error");
    return false;
  }
}

/** Ask with an in-view dialog; resolves to the chosen button's value. */
export function ask(path: string, title: string, message: string, buttons: DialogButton[], detail?: string): Promise<string> {
  return new Promise((resolve) => {
    update(path, { dialog: { kind: "confirm", title, message, detail, buttons, resolve } });
  });
}

export async function confirmClose(path: string): Promise<boolean> {
  const doc = docOf(path);
  if (!doc?.dirty) return true;
  const name = path.split(/[/\\]/).pop() ?? path;
  // Show the database so the question has context.
  const key = databaseTabKey(path);
  const group = useTabsStore.getState().groups.find((candidate) => candidate.tabs.some((tab) => tab.path === key));
  if (group) useTabsStore.getState().setActive(key, group.id);
  const choice = await ask(
    path,
    "Unwritten Changes",
    `Write the changes to "${name}" before closing?`,
    [
      { label: "Cancel", value: "cancel" },
      { label: "Discard", value: "discard", danger: true },
      { label: "Write Changes", value: "write", primary: true },
    ],
    "Edits are kept in a transaction until you write them; discarding rolls them back.",
  );
  if (choice === "write") return writeChanges(path);
  if (choice === "discard") return revertChanges(path);
  return false;
}

export function closeDatabase(path: string) {
  void db.close(path).catch(() => {});
  savedSql.delete(path);
  for (const dispose of closeListeners) dispose(path);
  useDatabaseStore.setState((state) => {
    const docs = { ...state.docs };
    delete docs[path];
    return { docs };
  });
}

/** Called when a database closes (the SQL editor drops its models). */
const closeListeners = new Set<(path: string) => void>();
export function onDatabaseClosed(listener: (path: string) => void) {
  closeListeners.add(listener);
}

export function renameDatabase(oldPath: string, newPath: string) {
  const doc = docOf(oldPath);
  void db.close(oldPath).catch(() => {});
  useDatabaseStore.setState((state) => {
    const docs = { ...state.docs };
    delete docs[oldPath];
    if (doc) docs[newPath] = { ...doc, path: newPath, schema: null, dirty: false };
    return { docs };
  });
  if (doc) {
    db.open(newPath).then(
      (schema) => update(newPath, (current) => ({ schema, readOnly: schema.readOnly, dataVersion: current.dataVersion + 1 })),
      (error) => update(newPath, { error: String(error) }),
    );
  }
}

// --- Files: export, import, SQL files ----------------------------------------------------------

const baseName = (path: string) => path.split(/[/\\]/).pop() ?? path;
const stem = (path: string) => baseName(path).replace(/\.[^.]+$/, "");
const dirOf = (path: string) => path.replace(/[/\\][^/\\]*$/, "");

/** Pick where to save; null if cancelled. */
export async function pickSavePath(defaultPath: string, name: string, extensions: string[]): Promise<string | null> {
  const chosen = await saveDialog({ defaultPath, filters: [{ name, extensions }] });
  return typeof chosen === "string" && chosen ? chosen : null;
}

export async function pickOpenPath(path: string, name: string, extensions: string[]): Promise<string | null> {
  const chosen = await openDialog({ multiple: false, directory: false, defaultPath: dirOf(path), filters: [{ name, extensions }, { name: "All Files", extensions: ["*"] }] });
  return typeof chosen === "string" && chosen ? chosen : null;
}

/**
 * Write an export. Locally the backend writes the file; with a remote
 * workspace the backend hands the text back and it's written here (the
 * dialog picked a path on this computer).
 */
export async function writeExport(run: (file?: string) => Promise<{ rows: number; text?: string }>, file: string) {
  if (isRemoteActive()) {
    const result = await run(undefined);
    await invokeLocal("write_file", { path: file, contents: result.text ?? "" });
    return result.rows;
  }
  return (await run(file)).rows;
}

export function defaultExportPath(path: string, name: string, extension: string) {
  return `${dirOf(path)}/${name || stem(path)}.${extension}`;
}

export async function startImport(path: string) {
  const file = await pickOpenPath(path, "CSV", ["csv", "tsv", "txt"]);
  if (!file) return;
  let text: string | null = null;
  if (isRemoteActive()) {
    try {
      text = await invokeLocal<string>("read_file", { path: file });
    } catch (error) {
      toast(path, String(error), "error");
      return;
    }
  }
  update(path, { dialog: { kind: "importCsv", file, text } });
}

export async function openSqlFile(path: string) {
  const file = await pickOpenPath(path, "SQL", ["sql", "txt"]);
  if (!file) return;
  try {
    const text = await invokeLocal<string>("read_file", { path: file });
    const tab = newSqlTab(text, baseName(file), file);
    update(path, (doc) => ({ sqlTabs: [...doc.sqlTabs, tab], activeSql: tab.id, tab: "execute" }));
  } catch (error) {
    toast(path, String(error), "error");
  }
}

export async function saveSqlFile(path: string, saveAs = false) {
  const doc = docOf(path);
  const tab = doc?.sqlTabs.find((candidate) => candidate.id === doc.activeSql);
  if (!doc || !tab) return;
  const file = !saveAs && tab.file ? tab.file : await pickSavePath(tab.file ?? `${dirOf(path)}/${stem(path)}.sql`, "SQL", ["sql"]);
  if (!file) return;
  try {
    await invokeLocal("write_file", { path: file, contents: tab.text });
    update(path, (current) => ({
      sqlTabs: current.sqlTabs.map((candidate) => (candidate.id === tab.id ? { ...candidate, file, title: baseName(file) } : candidate)),
    }));
    toast(path, `Saved ${baseName(file)}.`);
  } catch (error) {
    toast(path, String(error), "error");
  }
}

// --- Maintenance --------------------------------------------------------------------------------

export async function integrityCheck(path: string) {
  update(path, { busy: "Checking integrity…" });
  try {
    const result = await db.integrityCheck(path);
    const lines = [
      ...result.messages,
      ...result.foreignKeys.map((problem) => `Foreign key: ${problem.table} row ${problem.rowid ?? "?"} → ${problem.parent} (constraint ${problem.fkid}) has no parent row`),
    ];
    update(path, { dialog: { kind: "integrity", ok: result.ok, lines } });
  } catch (error) {
    toast(path, String(error), "error");
  } finally {
    update(path, { busy: null });
  }
}

export async function vacuum(path: string) {
  if (docOf(path)?.dirty) {
    toast(path, "Write or revert your changes before vacuuming.", "error");
    return;
  }
  const before = docOf(path)?.schema?.fileSize ?? null;
  update(path, { busy: "Vacuuming…" });
  try {
    const result = await db.vacuum(path);
    await refreshSchema(path, false);
    const saved = before !== null && result.fileSize !== null ? before - result.fileSize : null;
    toast(path, saved !== null && saved > 0 ? `Vacuumed: ${formatCount(saved)} bytes smaller.` : "Vacuumed.");
  } catch (error) {
    toast(path, String(error), "error");
  } finally {
    update(path, { busy: null });
  }
}

/** Palette commands (and the toolbar). */
export function runCommand(path: string, command: DatabaseCommand) {
  const doc = docOf(path);
  if (!doc) return;
  switch (command) {
    case "write":
      void writeChanges(path);
      return;
    case "revert":
      void revertChanges(path);
      return;
    case "refresh":
      void refreshSchema(path, true);
      return;
    case "structure":
    case "browse":
    case "pragmas":
    case "execute":
      update(path, { tab: command });
      return;
    case "createTable":
      update(path, { dialog: { kind: "createTable" } });
      return;
    case "createIndex":
      update(path, { dialog: { kind: "createIndex", table: doc.table } });
      return;
    case "importCsv":
      void startImport(path);
      return;
    case "exportCsv":
      update(path, { dialog: { kind: "export", format: "csv", table: doc.table } });
      return;
    case "exportJson":
      update(path, { dialog: { kind: "export", format: "json", table: doc.table } });
      return;
    case "exportSql":
      update(path, { dialog: { kind: "export", format: "sql", table: null } });
      return;
    case "integrityCheck":
      void integrityCheck(path);
      return;
    case "vacuum":
      void vacuum(path);
      return;
    case "openSql":
      void openSqlFile(path);
      return;
    case "saveSql":
      update(path, { tab: "execute" });
      void saveSqlFile(path);
      return;
  }
}

/** Reveal the database file in the Explorer. */
export function revealDatabase(path: string) {
  void useWorkspaceStore.getState().revealPath(path);
}

let installed = false;
/** Connect the tabs store's hooks (once, when the view first loads). */
export function installDatabaseSupport() {
  if (installed) return;
  installed = true;
  databaseHooks.save = async (path) => {
    await writeChanges(path);
  };
  databaseHooks.confirmClose = confirmClose;
  databaseHooks.close = closeDatabase;
  databaseHooks.rename = renameDatabase;
  databaseHooks.command = runCommand;
}

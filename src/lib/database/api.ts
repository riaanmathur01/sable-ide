import { invoke } from "../backend";

/**
 * The database backend (src-tauri/src/database.rs): one command,
 * `database_call {op, args}`. Values arrive typed — see `DbValue`.
 */
export function dbCall<T>(op: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>("database_call", { op, args });
}

/**
 * A value as SQLite stores it: null; an integer (a number, or `{i}` when
 * beyond JavaScript's safe range); a real `{r}`; text; a blob `{b: size,
 * m?: image type, d?: base64 when up to 64 KB}`.
 */
export type DbValue =
  | null
  | number
  | string
  | { i: string }
  | { r: number | string }
  | { b: number; m?: string; d?: string };

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  default: string | null;
  pk: number;
  /** 0 normal, 1 hidden (virtual table), 2 generated (virtual), 3 generated (stored). */
  hidden: number;
  unique: boolean;
  autoincrement: boolean;
}

export interface ForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
}

export interface TableInfo {
  type: "table" | "view";
  name: string;
  sql: string | null;
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
  indexes: { name: string; unique: boolean; origin: string; columns: (string | null)[] }[];
  rowCount: number | null;
  withoutRowid: boolean;
  strict: boolean;
  virtual: boolean;
  shadow: boolean;
  system: boolean;
}

export interface IndexInfo {
  type: "index";
  name: string;
  table: string;
  sql: string | null;
  unique: boolean;
  columns: (string | null)[];
}

export interface TriggerInfo {
  type: "trigger";
  name: string;
  table: string;
  sql: string | null;
}

export interface Schema {
  path: string;
  readOnly: boolean;
  dirty: boolean;
  fileSize: number | null;
  sqliteVersion: string;
  encoding: string | null;
  journalMode: string | null;
  tables: TableInfo[];
  views: TableInfo[];
  indexes: IndexInfo[];
  triggers: TriggerInfo[];
}

export interface SortSpec {
  column: string;
  desc: boolean;
}

export interface Page {
  columns: string[];
  keyColumns: string[];
  rows: DbValue[][];
  keys: DbValue[][];
  total?: number;
  ms: number;
}

export interface PageQuery {
  table?: string;
  sql?: string;
  offset: number;
  limit: number;
  sort?: SortSpec[];
  filters?: Record<string, string>;
  search?: string;
  count?: boolean;
}

export interface StatementResult {
  index: number;
  line: number;
  sql: string;
  start: number;
  end: number;
  kind: "rows" | "changes" | "error";
  columns?: string[];
  rows?: DbValue[][];
  rowCount?: number;
  truncated?: boolean;
  pageable?: boolean;
  query?: string;
  changes?: number;
  ms: number;
  error?: string;
  errorLine?: number;
}

export interface ExecuteResult {
  statements: StatementResult[];
  dirty: boolean;
  schemaChanged: boolean;
  total: number;
}

export interface CsvOptions {
  separator: string;
  quote: string;
  header: boolean;
  newline?: "\n" | "\r\n";
}

export const db = {
  sniff: (path: string) => dbCall<boolean>("sniff", { path }),
  open: (path: string) => dbCall<Schema>("open", { path }),
  schema: (path: string) => dbCall<Schema>("schema", { path }),
  close: (path: string) => dbCall<null>("close", { path }),
  status: (path: string) => dbCall<{ dirty: boolean; readOnly: boolean }>("status", { path }),
  query: (path: string, query: PageQuery) => dbCall<Page>("query", { path, ...query }),
  execute: (path: string, sql: string) => dbCall<ExecuteResult>("execute", { path, sql }),
  /** Run a table rebuild: foreign keys off until the changes are written or reverted. */
  executeRebuild: (path: string, sql: string) => dbCall<ExecuteResult>("execute", { path, sql, foreignKeysOff: true }),
  interrupt: (path: string) => dbCall<null>("interrupt", { path }),
  updateCell: (path: string, table: string, key: DbValue[], column: string, value: DbValue | { text: string }) =>
    dbCall<{ key: DbValue[] | null; value: DbValue; dirty: boolean }>("update_cell", { path, table, key, column, value }),
  insertRow: (path: string, table: string, values?: Record<string, DbValue>) =>
    dbCall<{ key: DbValue[] | null; dirty: boolean }>("insert_row", { path, table, values }),
  deleteRows: (path: string, table: string, keys: DbValue[][]) =>
    dbCall<{ deleted: number; dirty: boolean }>("delete_rows", { path, table, keys }),
  blobGet: (path: string, table: string, key: DbValue[], column: string) =>
    dbCall<{ size: number; m: string | null; d: string }>("blob_get", { path, table, key, column }),
  commit: (path: string) => dbCall<{ dirty: boolean }>("commit", { path }),
  rollback: (path: string) => dbCall<{ dirty: boolean }>("rollback", { path }),
  pragmasGet: (path: string) => dbCall<{ pragmas: Record<string, DbValue>; dirty: boolean }>("pragmas_get", { path }),
  pragmasSet: (path: string, values: Record<string, string | number>) =>
    dbCall<{ pragmas: Record<string, DbValue>; dirty: boolean }>("pragmas_set", { path, values }),
  exportCsv: (path: string, source: { table?: string; sql?: string }, options: CsvOptions, file?: string) =>
    dbCall<{ rows: number; text?: string }>("export_csv", { path, ...source, ...options, file }),
  exportJson: (path: string, source: { table?: string; sql?: string }, file?: string) =>
    dbCall<{ rows: number; text?: string }>("export_json", { path, ...source, file }),
  exportSql: (path: string, options: { tables?: string[]; schema?: boolean; data?: boolean }, file?: string) =>
    dbCall<{ rows: number; text?: string }>("export_sql", { path, ...options, file }),
  csvPreview: (input: { file?: string; text?: string }, options: CsvOptions, limit = 20) =>
    dbCall<{ columns: string[]; rows: string[][]; total: number }>("csv_preview", { ...input, ...options, limit }),
  importCsv: (path: string, table: string, input: { file?: string; text?: string }, options: CsvOptions) =>
    dbCall<{ rows: number; created: boolean; columns: string[]; dirty: boolean }>("import_csv", { path, table, ...input, ...options }),
  vacuum: (path: string) => dbCall<{ fileSize: number | null }>("vacuum", { path }),
  integrityCheck: (path: string) =>
    dbCall<{ ok: boolean; messages: string[]; foreignKeys: { table: string; rowid: number | null; parent: string; fkid: number }[] }>(
      "integrity_check",
      { path },
    ),
};

/**
 * How the tabs store reaches the database editor without loading it
 * (it's lazy-loaded with Monaco): the database module fills these in
 * when it loads. A database tab only exists once its view has rendered,
 * so the hooks are set by the time they're needed.
 */
export interface DatabaseHooks {
  /** Write the pending changes to the file (⌘S). */
  save?: (path: string) => Promise<void>;
  /** The tab with unwritten changes is closing: Write / Discard / Cancel.
   *  Resolves true when the tab may close (written or discarded). */
  confirmClose?: (path: string) => Promise<boolean>;
  /** The last tab showing the database closed: close its connection. */
  close?: (path: string) => void;
  /** The file moved: follow it. */
  rename?: (oldPath: string, newPath: string) => void;
  /** Run a database command (palette) on a database. */
  command?: (path: string, command: DatabaseCommand) => void;
}

export type DatabaseCommand =
  | "write"
  | "revert"
  | "refresh"
  | "structure"
  | "browse"
  | "pragmas"
  | "execute"
  | "createTable"
  | "createIndex"
  | "importCsv"
  | "exportCsv"
  | "exportJson"
  | "exportSql"
  | "integrityCheck"
  | "vacuum"
  | "openSql"
  | "saveSql";

export const databaseHooks: DatabaseHooks = {};

/** Files that open in the database editor by name. */
export const isDatabasePath = (path: string) => /\.(db|sqlite|sqlite3|db3)$/i.test(path);

/** The first 16 bytes of every SQLite database. */
export const SQLITE_HEADER = "SQLite format 3\u0000";

/** The tab key of a database tab. */
export const databaseTabKey = (path: string) => `database:${path}`;

//! SQLite databases: the backend of the database editor (like DB Browser
//! for SQLite). Each open database file has one connection per window,
//! kept while its tab is open. Edits (cell edits, new and deleted rows,
//! SQL the user runs, imports) happen inside a transaction (a savepoint)
//! that **Write Changes** commits and **Revert Changes** rolls back;
//! reading goes through the same connection, so it sees the uncommitted
//! edits. Nothing touches the file until the user writes.
//!
//! One command, `database_call {op, args}`, carries every operation (see
//! `call`), so the app, the remote agent (agent.rs) and the UI-test bridge
//! route it with a line each. Values travel typed:
//!
//!   null · 12 (integer) · {"i": "9007199254740993"} (integer beyond JS's
//!   safe range) · {"r": 1.5} (real) · "text" ·
//!   {"b": 1234, "m": "image/png", "d": "<base64>"} (blob: size, sniffed
//!   image type, and the bytes when up to 64 KB)
//!
//! Rows are addressed by rowid for ordinary tables and by primary key for
//! WITHOUT ROWID tables ("keys" in a page).
//!
//! Builds into the remote agent too, so databases in an SSH, WSL or
//! container workspace open over there.

use base64::Engine;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, InterruptHandle, OpenFlags};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Blobs up to this size travel with a page (thumbnails, the hex view).
const INLINE_BLOB: usize = 64 * 1024;
/// Rows kept from a statement that can't be paged (PRAGMA, RETURNING…).
const MAX_RESULT_ROWS: usize = 10_000;
/// The savepoint edits happen in.
const SAVEPOINT: &str = "sable_edits";
/// Largest blob `blob_get` hands over.
const MAX_BLOB: usize = 64 * 1024 * 1024;

/// One open database.
struct Db {
    conn: Mutex<Connection>,
    interrupt: InterruptHandle,
    read_only: bool,
    /// Foreign keys were switched off for a table rebuild: back on when
    /// the changes are written or reverted.
    restore_foreign_keys: std::sync::atomic::AtomicBool,
}

/// The open databases (of one window), by file path.
#[derive(Default)]
pub struct DatabaseState {
    dbs: Mutex<HashMap<String, Arc<Db>>>,
}

type Res<T> = Result<T, String>;

fn err(error: rusqlite::Error) -> String {
    match error {
        rusqlite::Error::SqlInputError { msg, .. } => msg,
        rusqlite::Error::SqliteFailure(_, Some(message)) => message,
        other => other.to_string(),
    }
}

// --- Arguments ---------------------------------------------------------------------------------

fn get<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|value| !value.is_null())
}

fn string(args: &Value, key: &str) -> Res<String> {
    get(args, key).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("argument {key}: expected a string"))
}

fn opt_string(args: &Value, key: &str) -> Option<String> {
    get(args, key).and_then(Value::as_str).map(str::to_string)
}

fn boolean(args: &Value, key: &str, default: bool) -> bool {
    get(args, key).and_then(Value::as_bool).unwrap_or(default)
}

fn number(args: &Value, key: &str, default: i64) -> i64 {
    get(args, key).and_then(Value::as_i64).unwrap_or(default)
}

fn character(args: &Value, key: &str, default: Option<char>) -> Option<char> {
    match get(args, key).and_then(Value::as_str) {
        None => default,
        Some("") => None,
        Some("\\t") => Some('\t'),
        Some(text) => text.chars().next(),
    }
}

// --- Values -------------------------------------------------------------------------------------

/// `"name"`, quoted for SQL.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn quote_text(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// An image type, from a blob's first bytes.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn real_json(value: f64) -> Value {
    if value.is_finite() {
        json!({ "r": value })
    } else if value.is_nan() {
        json!({ "r": "NaN" })
    } else if value > 0.0 {
        json!({ "r": "Infinity" })
    } else {
        json!({ "r": "-Infinity" })
    }
}

/// A value for the frontend.
fn to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) if (-MAX_SAFE..=MAX_SAFE).contains(&number) => json!(number),
        ValueRef::Integer(number) => json!({ "i": number.to_string() }),
        ValueRef::Real(number) => real_json(number),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => {
            let mut blob = json!({ "b": bytes.len() });
            if let Some(kind) = image_type(bytes) {
                blob["m"] = json!(kind);
            }
            if bytes.len() <= INLINE_BLOB {
                blob["d"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
            }
            blob
        }
    }
}

/// A value from the frontend (the same encoding; a JS number is an
/// integer when it has no fraction).
fn from_json(value: &Value) -> Res<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(*flag as i64),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => SqlValue::Integer(integer),
            None => SqlValue::Real(number.as_f64().unwrap_or(0.0)),
        },
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Object(object) => {
            if let Some(integer) = object.get("i") {
                let text = integer.as_str().map(str::to_string).unwrap_or_else(|| integer.to_string());
                SqlValue::Integer(text.trim().parse().map_err(|_| format!("{text} isn't an integer"))?)
            } else if let Some(real) = object.get("r") {
                SqlValue::Real(match real {
                    Value::String(text) => match text.as_str() {
                        "Infinity" => f64::INFINITY,
                        "-Infinity" => f64::NEG_INFINITY,
                        other => other.parse().map_err(|_| format!("{other} isn't a number"))?,
                    },
                    other => other.as_f64().unwrap_or(0.0),
                })
            } else if let Some(data) = object.get("d") {
                let data = data.as_str().unwrap_or("");
                SqlValue::Blob(
                    base64::engine::general_purpose::STANDARD.decode(data).map_err(|error| format!("Invalid blob data: {error}"))?,
                )
            } else if let Some(text) = object.get("text").and_then(Value::as_str) {
                SqlValue::Text(text.to_string())
            } else {
                return Err(format!("Can't store {value}"));
            }
        }
        Value::Array(_) => return Err(format!("Can't store {value}")),
    })
}

/// A literal typed into a filter: a number when it reads as one.
fn literal(text: &str) -> SqlValue {
    let text = text.trim();
    if let Ok(integer) = text.parse::<i64>() {
        return SqlValue::Integer(integer);
    }
    if let Ok(real) = text.parse::<f64>() {
        if real.is_finite() {
            return SqlValue::Real(real);
        }
    }
    let unquoted = text
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
        .or_else(|| text.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')))
        .unwrap_or(text);
    SqlValue::Text(unquoted.to_string())
}

/// A SQL literal (the SQL dump).
fn sql_literal(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "NULL".into(),
        ValueRef::Integer(number) => number.to_string(),
        ValueRef::Real(number) if number.is_nan() => "NULL".into(),
        ValueRef::Real(number) if number.is_infinite() => if number > 0.0 { "1e999" } else { "-1e999" }.into(),
        ValueRef::Real(number) => {
            let text = format!("{number:?}");
            if text.contains(['.', 'e', 'E']) { text } else { format!("{text}.0") }
        }
        ValueRef::Text(text) => quote_text(&String::from_utf8_lossy(text)),
        ValueRef::Blob(bytes) => {
            let mut hex = String::with_capacity(bytes.len() * 2 + 3);
            hex.push_str("X'");
            for byte in bytes {
                hex.push_str(&format!("{byte:02x}"));
            }
            hex.push('\'');
            hex
        }
    }
}

/// A value as text for CSV (blobs as base64).
fn plain_text(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(number) => number.to_string(),
        ValueRef::Real(number) => format!("{number}"),
        ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned(),
        ValueRef::Blob(bytes) => base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

/// A value for a JSON export.
fn export_json_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) if (-MAX_SAFE..=MAX_SAFE).contains(&number) => json!(number),
        ValueRef::Integer(number) => json!(number.to_string()),
        ValueRef::Real(number) if number.is_finite() => json!(number),
        ValueRef::Real(number) => json!(number.to_string()),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => json!(base64::engine::general_purpose::STANDARD.encode(bytes)),
    }
}

// --- Opening ----------------------------------------------------------------------------------

/// Whether a file starts with SQLite's header.
pub fn is_sqlite_file(path: &str) -> bool {
    use std::io::Read;
    let mut header = [0u8; 16];
    std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut header)).is_ok() && &header == b"SQLite format 3\0"
}

fn open_connection(path: &str) -> Res<Db> {
    let metadata = std::fs::metadata(path).map_err(|error| format!("Could not open {path}: {error}"))?;
    if metadata.is_dir() {
        return Err(format!("{path} is a folder"));
    }
    if metadata.len() > 0 && metadata.len() < 100 {
        return Err(format!("{path} isn't a SQLite database"));
    }
    if metadata.len() >= 16 && !is_sqlite_file(path) {
        return Err(format!("{path} isn't a SQLite database (or it's encrypted)"));
    }
    // Writable if the file opens for writing (that changes nothing).
    let writable = std::fs::OpenOptions::new().write(true).open(path).is_ok();
    let flags = OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let open = |read_only: bool| {
        let mode = if read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE };
        Connection::open_with_flags(path, flags | mode)
    };
    let (conn, read_only) = match writable.then(|| open(false)) {
        Some(Ok(conn)) => (conn, false),
        _ => (open(true).map_err(|error| format!("Could not open {path}: {}", err(error)))?, true),
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    // Fail now (not on the first page) for files that aren't databases.
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .map_err(|error| format!("Could not open {path}: {}", err(error)))?;
    let interrupt = conn.get_interrupt_handle();
    Ok(Db { conn: Mutex::new(conn), interrupt, read_only, restore_foreign_keys: Default::default() })
}

impl DatabaseState {
    fn db(&self, path: &str) -> Res<Arc<Db>> {
        self.dbs.lock().unwrap().get(path).cloned().ok_or_else(|| format!("{path} isn't open"))
    }

    fn open(&self, path: &str) -> Res<Arc<Db>> {
        if let Some(db) = self.dbs.lock().unwrap().get(path) {
            return Ok(db.clone());
        }
        let db = Arc::new(open_connection(path)?);
        Ok(self.dbs.lock().unwrap().entry(path.to_string()).or_insert(db).clone())
    }

    /// Close a database (uncommitted edits are dropped).
    fn close(&self, path: &str) {
        let removed = self.dbs.lock().unwrap().remove(path);
        if let Some(db) = removed {
            if let Ok(conn) = db.conn.lock() {
                if !conn.is_autocommit() {
                    let _ = conn.execute_batch("ROLLBACK");
                }
            }
        }
    }

    /// Stop whatever is running (the window closed): the connections
    /// close, rolling back unwritten edits, once the last user lets go.
    pub fn interrupt_all(&self) {
        for db in self.dbs.lock().unwrap().values() {
            db.interrupt.interrupt();
        }
    }

    /// Close every database (uncommitted edits are dropped).
    pub fn close_all(&self) {
        let paths: Vec<String> = self.dbs.lock().unwrap().keys().cloned().collect();
        for path in paths {
            self.close(&path);
        }
    }
}

// --- Transactions -------------------------------------------------------------------------------

/// Uncommitted edits: a transaction is open.
fn dirty(conn: &Connection) -> bool {
    !conn.is_autocommit()
}

/// Make sure edits go into the savepoint; true if this opened it.
fn begin_edit(db: &Db, conn: &Connection) -> Res<bool> {
    if db.read_only {
        return Err("The database is read-only".into());
    }
    if conn.is_autocommit() {
        conn.execute_batch(&format!("SAVEPOINT {SAVEPOINT}")).map_err(err)?;
        return Ok(true);
    }
    Ok(false)
}

/// After a failed edit: drop a savepoint that holds nothing.
fn abandon_edit(conn: &Connection, opened: bool) {
    if opened && !conn.is_autocommit() {
        let _ = conn.execute_batch(&format!("ROLLBACK TO {SAVEPOINT}; RELEASE {SAVEPOINT}"));
    }
}

fn edit<T>(db: &Db, conn: &Connection, run: impl FnOnce() -> Res<T>) -> Res<T> {
    let opened = begin_edit(db, conn)?;
    let result = run();
    if result.is_err() {
        abandon_edit(conn, opened);
    }
    result
}

/// Foreign keys back on after a rebuild (once the transaction is over).
fn restore_foreign_keys(db: &Db, conn: &Connection) {
    use std::sync::atomic::Ordering;
    if conn.is_autocommit() && db.restore_foreign_keys.swap(false, Ordering::SeqCst) {
        let _ = conn.execute_batch("PRAGMA foreign_keys = 1");
    }
}

/// Write the changes (refusing if a rebuild broke foreign keys).
fn commit(db: &Db, conn: &Connection) -> Res<Value> {
    if dirty(conn) {
        if db.restore_foreign_keys.load(std::sync::atomic::Ordering::SeqCst) {
            let broken: i64 = conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).unwrap_or(0);
            if broken > 0 {
                return Err(format!("Writing would leave {broken} row(s) breaking foreign key constraints (Integrity Check lists them). Fix them or Revert Changes."));
            }
        }
        conn.execute_batch("COMMIT").map_err(err)?;
    }
    restore_foreign_keys(db, conn);
    Ok(json!({ "dirty": dirty(conn) }))
}

fn require_clean(conn: &Connection, what: &str) -> Res<()> {
    if dirty(conn) {
        return Err(format!("Write or revert your changes before {what}."));
    }
    Ok(())
}

// --- Schema -------------------------------------------------------------------------------------

#[derive(Clone)]
struct Column {
    name: String,
    decl_type: String,
    notnull: bool,
    default: Option<String>,
    pk: i64,
    hidden: i64,
}

fn table_columns(conn: &Connection, table: &str) -> Res<Vec<Column>> {
    let mut statement = conn
        .prepare("SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?1) ORDER BY cid")
        .map_err(err)?;
    let rows = statement
        .query_map([table], |row| {
            Ok(Column {
                name: row.get(0)?,
                decl_type: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                notnull: row.get::<_, i64>(2)? != 0,
                default: row.get(3)?,
                pk: row.get(4)?,
                hidden: row.get(5)?,
            })
        })
        .map_err(err)?;
    let columns = rows.collect::<Result<Vec<_>, _>>().map_err(err)?;
    if columns.is_empty() {
        return Err(format!("No such table: {table}"));
    }
    Ok(columns)
}

/// `table_list` facts: (type, without rowid, strict).
fn table_kind(conn: &Connection, name: &str) -> Res<(String, bool, bool)> {
    conn.query_row("SELECT type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?1", [name], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0, row.get::<_, i64>(2)? != 0))
    })
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => format!("No such table: {name}"),
        other => err(other),
    })
}

/// SQLite's type affinity for a declared type.
fn affinity(decl_type: &str) -> &'static str {
    let upper = decl_type.to_ascii_uppercase();
    if upper.contains("INT") {
        "INTEGER"
    } else if upper.contains("CHAR") || upper.contains("CLOB") || upper.contains("TEXT") {
        "TEXT"
    } else if upper.contains("BLOB") || upper.is_empty() {
        "BLOB"
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        "REAL"
    } else {
        "NUMERIC"
    }
}

/// How a table's rows are addressed.
#[derive(Debug, Clone, PartialEq)]
enum Keys {
    /// By rowid, through this name (`_rowid_`, or another if a column has it).
    Rowid(String),
    /// By these primary-key columns (WITHOUT ROWID).
    Primary(Vec<String>),
    /// Not editable (views, virtual tables without rowid).
    None,
}

impl Keys {
    fn columns(&self) -> Vec<String> {
        match self {
            Keys::Rowid(name) => vec![name.clone()],
            Keys::Primary(columns) => columns.clone(),
            Keys::None => vec![],
        }
    }

    fn select_list(&self) -> Vec<String> {
        self.columns().iter().map(|column| quote_ident(column)).collect()
    }

    fn condition(&self, first_param: usize) -> String {
        self.columns()
            .iter()
            .enumerate()
            .map(|(index, column)| format!("{} IS ?{}", quote_ident(column), first_param + index))
            .collect::<Vec<_>>()
            .join(" AND ")
    }
}

fn keys_for(conn: &Connection, table: &str, columns: &[Column]) -> Res<Keys> {
    let (kind, without_rowid, _) = table_kind(conn, table)?;
    if kind == "view" {
        return Ok(Keys::None);
    }
    if without_rowid {
        let mut pk: Vec<&Column> = columns.iter().filter(|column| column.pk > 0).collect();
        pk.sort_by_key(|column| column.pk);
        return Ok(Keys::Primary(pk.into_iter().map(|column| column.name.clone()).collect()));
    }
    let taken = |name: &str| columns.iter().any(|column| column.name.eq_ignore_ascii_case(name));
    Ok(["_rowid_", "rowid", "oid"].into_iter().find(|name| !taken(name)).map_or(Keys::None, |name| Keys::Rowid(name.into())))
}

/// The INTEGER PRIMARY KEY column that is the rowid, if any.
fn rowid_alias(columns: &[Column], without_rowid: bool) -> Option<String> {
    if without_rowid {
        return None;
    }
    let pk: Vec<&Column> = columns.iter().filter(|column| column.pk > 0).collect();
    match pk.as_slice() {
        [only] if only.decl_type.eq_ignore_ascii_case("INTEGER") => Some(only.name.clone()),
        _ => None,
    }
}

fn schema(db: &Db, conn: &Connection, path: &str, counts: bool) -> Res<Value> {
    let mut statement = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY name COLLATE NOCASE")
        .map_err(err)?;
    let entries: Vec<(String, String, String, Option<String>)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    drop(statement);
    let mut kinds = HashMap::new();
    {
        let mut statement = conn.prepare("SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = 'main'").map_err(err)?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, (row.get::<_, String>(1)?, row.get::<_, i64>(2)? != 0, row.get::<_, i64>(3)? != 0))))
            .map_err(err)?;
        for row in rows.flatten() {
            kinds.insert(row.0, row.1);
        }
    }
    let (mut tables, mut views, mut indexes, mut triggers) = (vec![], vec![], vec![], vec![]);
    for (kind, name, table, sql) in entries {
        match kind.as_str() {
            "table" | "view" => {
                let columns = table_columns(conn, &name).unwrap_or_default();
                let (list_type, without_rowid, strict) = kinds.get(&name).cloned().unwrap_or((kind.clone(), false, false));
                // Single-column UNIQUE constraints and indexes, for the "U" marker.
                let mut unique_columns = vec![];
                let mut index_columns: Vec<Value> = vec![];
                if kind == "table" {
                    if let Ok(mut statement) = conn.prepare("SELECT name, \"unique\", origin, partial FROM pragma_index_list(?1)") {
                        let list: Vec<(String, bool, String, bool)> = statement
                            .query_map([&name], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0, row.get(2)?, row.get::<_, i64>(3)? != 0)))
                            .map(|rows| rows.flatten().collect())
                            .unwrap_or_default();
                        for (index, unique, origin, partial) in list {
                            let cols = index_info(conn, &index);
                            if unique && !partial && cols.len() == 1 && origin != "pk" {
                                if let Some(Some(column)) = cols.first() {
                                    unique_columns.push(column.clone());
                                }
                            }
                            index_columns.push(json!({ "name": index, "unique": unique, "origin": origin, "columns": cols }));
                        }
                    }
                }
                let foreign_keys = foreign_keys(conn, &name);
                let row_count = if counts && kind == "table" && list_type != "virtual" {
                    conn.query_row(&format!("SELECT count(*) FROM {}", quote_ident(&name)), [], |row| row.get::<_, i64>(0)).ok()
                } else {
                    None
                };
                let autoincrement = sql.as_deref().is_some_and(|sql| sql.to_ascii_uppercase().contains("AUTOINCREMENT"));
                let alias = rowid_alias(&columns, without_rowid);
                let columns: Vec<Value> = columns
                    .iter()
                    .map(|column| {
                        json!({
                            "name": column.name,
                            "type": column.decl_type,
                            "notnull": column.notnull,
                            "default": column.default,
                            "pk": column.pk,
                            "hidden": column.hidden,
                            "unique": unique_columns.contains(&column.name),
                            "autoincrement": autoincrement && alias.as_deref() == Some(column.name.as_str()),
                        })
                    })
                    .collect();
                let object = json!({
                    "type": kind,
                    "name": name,
                    "sql": sql,
                    "columns": columns,
                    "foreignKeys": foreign_keys,
                    "indexes": index_columns,
                    "rowCount": row_count,
                    "withoutRowid": without_rowid,
                    "strict": strict,
                    "virtual": list_type == "virtual",
                    "shadow": list_type == "shadow",
                    "system": name.starts_with("sqlite_"),
                });
                if kind == "table" { tables.push(object) } else { views.push(object) }
            }
            "index" => {
                let unique = sql.as_deref().is_some_and(|sql| sql.trim_start().to_ascii_uppercase().starts_with("CREATE UNIQUE"));
                indexes.push(json!({ "type": "index", "name": name, "table": table, "sql": sql, "unique": unique, "columns": index_info(conn, &name) }));
            }
            "trigger" => triggers.push(json!({ "type": "trigger", "name": name, "table": table, "sql": sql })),
            _ => {}
        }
    }
    let pragma = |name: &str| conn.query_row(&format!("PRAGMA {name}"), [], |row| Ok(to_json(row.get_ref(0)?))).ok();
    let encoding: Option<String> = conn.query_row("PRAGMA encoding", [], |row| row.get(0)).ok();
    Ok(json!({
        "path": path,
        "readOnly": db.read_only,
        "dirty": dirty(conn),
        "fileSize": std::fs::metadata(path).map(|metadata| metadata.len()).ok(),
        "sqliteVersion": rusqlite::version(),
        "encoding": encoding,
        "journalMode": pragma("journal_mode").and_then(|value| value.as_str().map(str::to_string)),
        "tables": tables,
        "views": views,
        "indexes": indexes,
        "triggers": triggers,
    }))
}

fn index_info(conn: &Connection, index: &str) -> Vec<Option<String>> {
    let Ok(mut statement) = conn.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno") else { return vec![] };
    statement.query_map([index], |row| row.get::<_, Option<String>>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

fn foreign_keys(conn: &Connection, table: &str) -> Vec<Value> {
    let Ok(mut statement) =
        conn.prepare("SELECT id, seq, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1) ORDER BY id, seq")
    else {
        return vec![];
    };
    statement
        .query_map([table], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "seq": row.get::<_, i64>(1)?,
                "table": row.get::<_, String>(2)?,
                "from": row.get::<_, String>(3)?,
                "to": row.get::<_, Option<String>>(4)?,
                "onUpdate": row.get::<_, String>(5)?,
                "onDelete": row.get::<_, String>(6)?,
            }))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

// --- Browsing -----------------------------------------------------------------------------------

/// A WHERE clause for a DB4S-style filter on one column: plain text
/// contains (LIKE); `=x`, `<>x`, `>x`, `<x`, `>=x`, `<=x` compare; `x~y`
/// is a range; `NULL` / `NOT NULL` (or `=NULL`/`<>NULL`) test for NULL.
pub fn filter_clause(column: &str, filter: &str, params: &mut Vec<SqlValue>) -> Option<String> {
    let filter = filter.trim();
    if filter.is_empty() {
        return None;
    }
    let upper = filter.to_ascii_uppercase();
    if upper == "NULL" || upper == "=NULL" || upper == "IS NULL" {
        return Some(format!("{column} IS NULL"));
    }
    if upper == "NOT NULL" || upper == "<>NULL" || upper == "!=NULL" || upper == "IS NOT NULL" {
        return Some(format!("{column} IS NOT NULL"));
    }
    for operator in [">=", "<=", "<>", "!=", "==", ">", "<", "="] {
        if let Some(rest) = filter.strip_prefix(operator) {
            if rest.trim().is_empty() {
                return None;
            }
            let operator = match operator {
                "!=" => "<>",
                "==" => "=",
                other => other,
            };
            params.push(literal(rest));
            return Some(format!("{column} {operator} ?{}", params.len()));
        }
    }
    if let Some((low, high)) = filter.split_once('~') {
        if !low.trim().is_empty() && !high.trim().is_empty() {
            params.push(literal(low));
            params.push(literal(high));
            return Some(format!("{column} BETWEEN ?{} AND ?{}", params.len() - 1, params.len()));
        }
    }
    params.push(SqlValue::Text(format!("%{}%", like_escape(filter))));
    Some(format!("{column} LIKE ?{} ESCAPE '\\'", params.len()))
}

fn like_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// What a page reads: a table or view, or a query.
struct Source {
    /// `"table"` or `(<query>)`.
    from: String,
    columns: Vec<String>,
    keys: Keys,
}

fn strip_trailing_semicolons(sql: &str) -> &str {
    let mut sql = sql.trim();
    while let Some(rest) = sql.strip_suffix(';') {
        sql = rest.trim_end();
    }
    sql
}

fn source(conn: &Connection, args: &Value) -> Res<Source> {
    if let Some(sql) = opt_string(args, "sql") {
        let inner = format!("({})", strip_trailing_semicolons(&sql));
        let statement = conn.prepare(&format!("SELECT * FROM {inner} LIMIT 0")).map_err(err)?;
        let columns = statement.column_names().into_iter().map(str::to_string).collect();
        return Ok(Source { from: inner, columns, keys: Keys::None });
    }
    let table = string(args, "table")?;
    let columns = table_columns(conn, &table)?;
    let keys = keys_for(conn, &table, &columns)?;
    Ok(Source {
        from: quote_ident(&table),
        columns: columns.into_iter().filter(|column| column.hidden != 1).map(|column| column.name).collect(),
        keys,
    })
}

fn where_clause(source: &Source, args: &Value, params: &mut Vec<SqlValue>) -> String {
    let mut clauses = vec![];
    if let Some(filters) = get(args, "filters").and_then(Value::as_object) {
        for (column, filter) in filters {
            if !source.columns.contains(column) {
                continue;
            }
            if let Some(clause) = filter.as_str().and_then(|filter| filter_clause(&quote_ident(column), filter, params)) {
                clauses.push(clause);
            }
        }
    }
    if let Some(search) = opt_string(args, "search").filter(|search| !search.trim().is_empty()) {
        params.push(SqlValue::Text(format!("%{}%", like_escape(search.trim()))));
        let number = params.len();
        let any: Vec<String> = source.columns.iter().map(|column| format!("{} LIKE ?{number} ESCAPE '\\'", quote_ident(column))).collect();
        if !any.is_empty() {
            clauses.push(format!("({})", any.join(" OR ")));
        }
    }
    if clauses.is_empty() { String::new() } else { format!(" WHERE {}", clauses.join(" AND ")) }
}

fn query_page(conn: &Connection, args: &Value) -> Res<Value> {
    let started = Instant::now();
    let source = source(conn, args)?;
    let mut params = vec![];
    let filter = where_clause(&source, args, &mut params);
    let mut order = vec![];
    if let Some(sorts) = get(args, "sort").and_then(Value::as_array) {
        for sort in sorts {
            let Some(column) = sort.get("column").and_then(Value::as_str) else { continue };
            if source.columns.iter().any(|known| known == column) {
                let direction = if sort.get("desc").and_then(Value::as_bool).unwrap_or(false) { "DESC" } else { "ASC" };
                order.push(format!("{} {direction}", quote_ident(column)));
            }
        }
    }
    // Ties broken by the key, so pages don't overlap.
    if !order.is_empty() {
        order.extend(source.keys.select_list());
    }
    let order = if order.is_empty() { String::new() } else { format!(" ORDER BY {}", order.join(", ")) };
    let limit = number(args, "limit", 200).clamp(0, 50_000);
    let offset = number(args, "offset", 0).max(0);
    let mut selected = source.keys.select_list();
    selected.extend(source.columns.iter().map(|column| quote_ident(column)));
    let list = if selected.is_empty() { "*".to_string() } else { selected.join(", ") };
    let sql = format!("SELECT {list} FROM {}{filter}{order} LIMIT {limit} OFFSET {offset}", source.from);
    let key_count = source.keys.columns().len();
    let mut statement = conn.prepare(&sql).map_err(err)?;
    let width = statement.column_count();
    let mut rows = vec![];
    let mut keys = vec![];
    let mut cursor = statement.query(rusqlite::params_from_iter(params.iter())).map_err(err)?;
    while let Some(row) = cursor.next().map_err(err)? {
        let mut key = vec![];
        let mut cells = vec![];
        for index in 0..width {
            let value = to_json(row.get_ref(index).map_err(err)?);
            if index < key_count { key.push(value) } else { cells.push(value) }
        }
        keys.push(Value::Array(key));
        rows.push(Value::Array(cells));
    }
    drop(cursor);
    drop(statement);
    let mut result = json!({
        "columns": source.columns,
        "keyColumns": source.keys.columns(),
        "rows": rows,
        "keys": keys,
    });
    if boolean(args, "count", false) {
        let total: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {}{filter}", source.from), rusqlite::params_from_iter(params.iter()), |row| row.get(0))
            .map_err(err)?;
        result["total"] = json!(total);
    }
    result["ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    Ok(result)
}

/// The key of a row, from the frontend.
fn key_values(key: &Value) -> Res<Vec<SqlValue>> {
    key.as_array().ok_or("Missing row key")?.iter().map(from_json).collect()
}

fn update_cell(db: &Db, conn: &Connection, args: &Value) -> Res<Value> {
    let table = string(args, "table")?;
    let column = string(args, "column")?;
    let columns = table_columns(conn, &table)?;
    let keys = keys_for(conn, &table, &columns)?;
    if keys == Keys::None {
        return Err(format!("{table} can't be edited here (it has no rowid or primary key)"));
    }
    let info = columns.iter().find(|candidate| candidate.name == column).ok_or_else(|| format!("No column {column} in {table}"))?;
    if info.hidden >= 2 {
        return Err(format!("{column} is a generated column"));
    }
    let key = key_values(get(args, "key").ok_or("Missing row key")?)?;
    let value = from_json(get(args, "value").unwrap_or(&Value::Null))?;
    let (_, without_rowid, _) = table_kind(conn, &table)?;
    edit(db, conn, || {
        let mut params = vec![value.clone()];
        params.extend(key.iter().cloned());
        let changed = conn
            .execute(
                &format!("UPDATE {} SET {} = ?1 WHERE {}", quote_ident(&table), quote_ident(&column), keys.condition(2)),
                rusqlite::params_from_iter(params.iter()),
            )
            .map_err(err)?;
        if changed == 0 {
            return Err("The row is gone (was it deleted?)".into());
        }
        Ok(())
    })?;
    // The new key (the key column itself may have changed), and the value
    // as stored (after type affinity).
    let new_key: Vec<SqlValue> = match &keys {
        Keys::Rowid(_) if rowid_alias(&columns, without_rowid).as_deref() == Some(column.as_str()) => vec![value],
        Keys::Primary(names) => names.iter().zip(key.iter()).map(|(name, old)| if *name == column { value.clone() } else { old.clone() }).collect(),
        _ => key,
    };
    let mut select = keys.select_list();
    select.push(quote_ident(&column));
    let stored = conn
        .query_row(
            &format!("SELECT {} FROM {} WHERE {}", select.join(", "), quote_ident(&table), keys.condition(1)),
            rusqlite::params_from_iter(new_key.iter()),
            |row| {
                let width = select.len();
                let key: Vec<Value> = (0..width - 1).map(|index| row.get_ref(index).map(to_json)).collect::<Result<_, _>>()?;
                Ok((key, to_json(row.get_ref(width - 1)?)))
            },
        )
        .ok();
    let (key, value) = stored.map_or((Value::Null, Value::Null), |(key, value)| (Value::Array(key), value));
    Ok(json!({ "key": key, "value": value, "dirty": dirty(conn) }))
}

fn insert_row(db: &Db, conn: &Connection, args: &Value) -> Res<Value> {
    let table = string(args, "table")?;
    let columns = table_columns(conn, &table)?;
    let keys = keys_for(conn, &table, &columns)?;
    let (_, without_rowid, _) = table_kind(conn, &table)?;
    let alias = rowid_alias(&columns, without_rowid);
    let given = get(args, "values").and_then(Value::as_object).cloned().unwrap_or_default();
    let references = foreign_keys(conn, &table);
    // Like DB4S: defaults, except NOT NULL columns without one get a value
    // that fits: the next number or a new name for a primary key, an
    // existing parent for a foreign key, else 0 or ''.
    let mut names = vec![];
    let mut params = vec![];
    for column in &columns {
        if column.hidden != 0 || alias.as_deref() == Some(column.name.as_str()) {
            continue;
        }
        let value = if let Some(value) = given.get(&column.name) {
            from_json(value)?
        } else if column.default.is_some() || (!column.notnull && column.pk == 0) {
            continue;
        } else {
            let numeric = !matches!(affinity(&column.decl_type), "TEXT" | "BLOB");
            let quoted = quote_ident(&table);
            let parent = references.iter().find(|reference| reference["from"] == column.name.as_str());
            if column.pk > 0 && numeric {
                conn.query_row(&format!("SELECT coalesce(max({}), 0) + 1 FROM {quoted}", quote_ident(&column.name)), [], |row| row.get(0))
                    .map_err(err)?
            } else if column.pk > 0 {
                let count: i64 = conn.query_row(&format!("SELECT count(*) FROM {quoted}"), [], |row| row.get(0)).map_err(err)?;
                let mut number = count + 1;
                loop {
                    let candidate = format!("new {number}");
                    let taken: bool = conn
                        .query_row(&format!("SELECT EXISTS (SELECT 1 FROM {quoted} WHERE {} = ?1)", quote_ident(&column.name)), [&candidate], |row| row.get(0))
                        .map_err(err)?;
                    if !taken {
                        break SqlValue::Text(candidate);
                    }
                    number += 1;
                }
            } else if let Some(parent) = parent {
                let parent_table = parent["table"].as_str().unwrap_or_default();
                let target = match parent["to"].as_str() {
                    Some(to) => quote_ident(to),
                    None => "rowid".into(),
                };
                conn.query_row(&format!("SELECT {target} FROM {} LIMIT 1", quote_ident(parent_table)), [], |row| row.get(0))
                    .unwrap_or(if numeric { SqlValue::Integer(0) } else { SqlValue::Text(String::new()) })
            } else if numeric {
                SqlValue::Integer(0)
            } else {
                SqlValue::Text(String::new())
            }
        };
        names.push(column.name.clone());
        params.push(value);
    }
    let sql = if names.is_empty() {
        format!("INSERT INTO {} DEFAULT VALUES", quote_ident(&table))
    } else {
        let list: Vec<String> = names.iter().map(|name| quote_ident(name)).collect();
        let marks: Vec<String> = (1..=names.len()).map(|index| format!("?{index}")).collect();
        format!("INSERT INTO {} ({}) VALUES ({})", quote_ident(&table), list.join(", "), marks.join(", "))
    };
    let key = edit(db, conn, || {
        conn.execute(&sql, rusqlite::params_from_iter(params.iter())).map_err(err)?;
        Ok(match &keys {
            Keys::Rowid(_) => json!([to_json(ValueRef::Integer(conn.last_insert_rowid()))]),
            // WITHOUT ROWID: the key is what went in (unless a default chose it).
            Keys::Primary(columns) => columns
                .iter()
                .map(|column| names.iter().position(|name| name == column).map(|index| to_json(ValueRef::from(&params[index]))))
                .collect::<Option<Vec<_>>>()
                .map_or(Value::Null, Value::Array),
            Keys::None => Value::Null,
        })
    })?;
    Ok(json!({ "key": key, "dirty": dirty(conn) }))
}

fn delete_rows(db: &Db, conn: &Connection, args: &Value) -> Res<Value> {
    let table = string(args, "table")?;
    let columns = table_columns(conn, &table)?;
    let keys = keys_for(conn, &table, &columns)?;
    if keys == Keys::None {
        return Err(format!("Rows of {table} can't be deleted here"));
    }
    let list = get(args, "keys").and_then(Value::as_array).cloned().unwrap_or_default();
    let deleted = edit(db, conn, || {
        let mut statement = conn.prepare(&format!("DELETE FROM {} WHERE {}", quote_ident(&table), keys.condition(1))).map_err(err)?;
        let mut deleted = 0;
        for key in &list {
            deleted += statement.execute(rusqlite::params_from_iter(key_values(key)?.iter())).map_err(err)?;
        }
        Ok(deleted)
    })?;
    Ok(json!({ "deleted": deleted, "dirty": dirty(conn) }))
}

fn blob_get(conn: &Connection, args: &Value) -> Res<Value> {
    let table = string(args, "table")?;
    let column = string(args, "column")?;
    let columns = table_columns(conn, &table)?;
    let keys = keys_for(conn, &table, &columns)?;
    let key = key_values(get(args, "key").ok_or("Missing row key")?)?;
    let bytes: Vec<u8> = conn
        .query_row(
            &format!("SELECT {} FROM {} WHERE {}", quote_ident(&column), quote_ident(&table), keys.condition(1)),
            rusqlite::params_from_iter(key.iter()),
            |row| {
                Ok(match row.get_ref(0)? {
                    ValueRef::Blob(bytes) | ValueRef::Text(bytes) => bytes.to_vec(),
                    ValueRef::Null => vec![],
                    other => plain_text(other).into_bytes(),
                })
            },
        )
        .map_err(err)?;
    if bytes.len() > MAX_BLOB {
        return Err(format!("The blob is too large ({} bytes)", bytes.len()));
    }
    Ok(json!({ "size": bytes.len(), "m": image_type(&bytes), "d": base64::engine::general_purpose::STANDARD.encode(&bytes) }))
}

// --- Executing SQL ------------------------------------------------------------------------------

fn is_complete(sql: &str) -> bool {
    let Ok(text) = std::ffi::CString::new(sql) else { return false };
    // SAFETY: a valid NUL-terminated string; sqlite3_complete only reads it.
    unsafe { rusqlite::ffi::sqlite3_complete(text.as_ptr()) != 0 }
}

/// Where the SQL starts after leading whitespace and comments.
fn skip_comments(sql: &str) -> usize {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.find('\n').map_or("", |end| &after[end + 1..]).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.find("*/").map_or("", |end| &after[end + 2..]).trim_start();
        } else {
            return sql.len() - rest.len();
        }
    }
}

/// Whether text is only whitespace and comments.
fn is_blank_sql(sql: &str) -> bool {
    skip_comments(sql) == sql.len()
}

/// Split a script into statements: byte ranges, each through its `;`
/// (SQLite decides where statements end: strings, comments, triggers).
pub fn split_statements(sql: &str) -> Vec<(usize, usize)> {
    let mut statements = vec![];
    let mut start = 0;
    for (index, _) in sql.match_indices(';') {
        if index < start {
            continue;
        }
        if is_complete(&sql[start..=index]) {
            if !is_blank_sql(&sql[start..index]) {
                statements.push((start, index + 1));
            }
            start = index + 1;
        }
    }
    if start < sql.len() && !is_blank_sql(&sql[start..]) {
        statements.push((start, sql.len()));
    }
    statements
}

/// The first keyword of a statement (after comments), uppercased.
fn first_words(sql: &str, count: usize) -> Vec<String> {
    sql[skip_comments(sql)..]
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty())
        .take(count)
        .map(|word| word.to_ascii_uppercase())
        .collect()
}

fn line_of(sql: &str, offset: usize) -> usize {
    sql[..offset.min(sql.len())].matches('\n').count() + 1
}

fn execute(db: &Db, conn: &Connection, args: &Value) -> Res<Value> {
    let sql = string(args, "sql")?;
    // A table rebuild: foreign keys off, so dropping the old table
    // doesn't cascade (that only works outside a transaction).
    if boolean(args, "foreignKeysOff", false) {
        let on: i64 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0)).map_err(err)?;
        if on == 1 {
            require_clean(conn, "changing a table's structure")?;
            conn.execute_batch("PRAGMA foreign_keys = 0").map_err(err)?;
            db.restore_foreign_keys.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let mut results = vec![];
    let ranges = split_statements(&sql);
    let mut schema_changed = false;
    for (number, &(start, end)) in ranges.iter().enumerate() {
        let text = &sql[start..end];
        let leading = skip_comments(text);
        let line = line_of(&sql, start + leading);
        let is_last = number + 1 == ranges.len();
        let words = first_words(text, 3);
        let first = words.first().map(String::as_str).unwrap_or("");
        let summary: String = text.trim().chars().take(300).collect();
        let started = Instant::now();
        let mut entry = json!({ "index": number, "line": line, "sql": summary, "start": start + leading, "end": end });
        let fail = |entry: &mut Value, error: rusqlite::Error, started: Instant| {
            let error_line = match &error {
                rusqlite::Error::SqlInputError { offset, .. } if *offset >= 0 => line_of(&sql, start + *offset as usize),
                _ => line,
            };
            entry["kind"] = json!("error");
            entry["error"] = json!(err(error));
            entry["errorLine"] = json!(error_line);
            entry["ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
        };
        let mut statement = match conn.prepare(text) {
            Ok(statement) => statement,
            Err(error) => {
                fail(&mut entry, error, started);
                results.push(entry);
                break;
            }
        };
        let readonly = statement.readonly();
        let transaction_control = matches!(first, "BEGIN" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE");
        let outside_transaction = matches!(first, "VACUUM" | "ATTACH" | "DETACH");
        if outside_transaction && dirty(conn) {
            entry["kind"] = json!("error");
            entry["error"] = json!(format!("{first} can't run inside a transaction: Write Changes or Revert Changes first."));
            entry["errorLine"] = json!(line);
            entry["ms"] = json!(0);
            results.push(entry);
            break;
        }
        let mut opened = false;
        if !readonly && !transaction_control && !outside_transaction && first != "PRAGMA" {
            if db.read_only {
                entry["kind"] = json!("error");
                entry["error"] = json!("The database is read-only");
                entry["errorLine"] = json!(line);
                entry["ms"] = json!(0);
                results.push(entry);
                break;
            }
            match begin_edit(db, conn) {
                Ok(began) => opened = began,
                Err(error) => {
                    entry["kind"] = json!("error");
                    entry["error"] = json!(error);
                    results.push(entry);
                    break;
                }
            }
        }
        if matches!(first, "CREATE" | "DROP" | "ALTER") || transaction_control {
            schema_changed = true;
        }
        let columns: Vec<String> = statement.column_names().into_iter().map(str::to_string).collect();
        // The last SELECT pages itself (query with `sql`): don't run it here.
        let pageable = is_last && readonly && !columns.is_empty() && matches!(first, "SELECT" | "WITH" | "VALUES");
        if pageable {
            entry["kind"] = json!("rows");
            entry["columns"] = json!(columns);
            entry["pageable"] = json!(true);
            entry["query"] = json!(strip_trailing_semicolons(text.trim()));
            entry["ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
            results.push(entry);
            continue;
        }
        let before = conn.total_changes();
        let outcome = (|| -> rusqlite::Result<(Vec<Value>, usize, bool)> {
            let mut rows = vec![];
            let mut count = 0;
            let mut truncated = false;
            let mut cursor = statement.raw_query();
            while let Some(row) = cursor.next()? {
                count += 1;
                if is_last && !columns.is_empty() {
                    if rows.len() < MAX_RESULT_ROWS {
                        let cells: Vec<Value> = (0..columns.len()).map(|index| row.get_ref(index).map(to_json)).collect::<Result<_, _>>()?;
                        rows.push(Value::Array(cells));
                    } else {
                        truncated = true;
                    }
                }
            }
            Ok((rows, count, truncated))
        })();
        drop(statement);
        match outcome {
            Ok((rows, count, truncated)) => {
                entry["ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
                if !columns.is_empty() {
                    entry["kind"] = json!("rows");
                    entry["columns"] = json!(columns);
                    entry["rowCount"] = json!(count);
                    if is_last {
                        entry["rows"] = Value::Array(rows);
                        entry["truncated"] = json!(truncated);
                    }
                }
                if !readonly || columns.is_empty() {
                    if columns.is_empty() {
                        entry["kind"] = json!("changes");
                    }
                    entry["changes"] = json!(if readonly { 0 } else { conn.total_changes() - before });
                }
                results.push(entry);
            }
            Err(error) => {
                abandon_edit(conn, opened);
                fail(&mut entry, error, started);
                results.push(entry);
                break;
            }
        }
    }
    restore_foreign_keys(db, conn);
    Ok(json!({ "statements": results, "dirty": dirty(conn), "schemaChanged": schema_changed, "total": ranges.len() }))
}

// --- Pragmas ------------------------------------------------------------------------------------

/// The pragmas the Edit Pragmas tab shows, and whether they're writable.
pub const PRAGMAS: &[(&str, bool)] = &[
    ("auto_vacuum", true),
    ("automatic_index", true),
    ("busy_timeout", true),
    ("cache_size", true),
    ("case_sensitive_like", false),
    ("cell_size_check", true),
    ("checkpoint_fullfsync", true),
    ("defer_foreign_keys", true),
    ("encoding", false),
    ("foreign_keys", true),
    ("fullfsync", true),
    ("ignore_check_constraints", true),
    ("journal_mode", true),
    ("journal_size_limit", true),
    ("locking_mode", true),
    ("max_page_count", true),
    ("page_count", false),
    ("page_size", true),
    ("freelist_count", false),
    ("recursive_triggers", true),
    ("reverse_unordered_selects", true),
    ("secure_delete", true),
    ("synchronous", true),
    ("temp_store", true),
    ("user_version", true),
    ("application_id", true),
    ("wal_autocheckpoint", true),
    ("schema_version", false),
    ("data_version", false),
];

fn pragmas_get(conn: &Connection) -> Value {
    let mut values = Map::new();
    for (name, _) in PRAGMAS {
        if *name == "case_sensitive_like" {
            continue;
        }
        let value = conn.query_row(&format!("PRAGMA {name}"), [], |row| Ok(to_json(row.get_ref(0)?))).unwrap_or(Value::Null);
        values.insert(name.to_string(), value);
    }
    Value::Object(values)
}

fn pragmas_set(db: &Db, conn: &Connection, args: &Value) -> Res<Value> {
    let values = get(args, "values").and_then(Value::as_object).cloned().unwrap_or_default();
    if values.is_empty() {
        return Ok(json!({ "pragmas": pragmas_get(conn), "dirty": dirty(conn) }));
    }
    require_clean(conn, "changing pragmas")?;
    let mut vacuum = false;
    for (name, value) in &values {
        if !PRAGMAS.iter().any(|(known, writable)| known == name && *writable) {
            return Err(format!("{name} can't be set here"));
        }
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Bool(flag) => (*flag as i64).to_string(),
            other => other.to_string(),
        };
        if text.is_empty() || !text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(format!("Invalid value for {name}: {text}"));
        }
        if db.read_only && !matches!(name.as_str(), "foreign_keys" | "busy_timeout" | "cache_size" | "case_sensitive_like" | "recursive_triggers" | "temp_store" | "automatic_index" | "reverse_unordered_selects" | "ignore_check_constraints" | "defer_foreign_keys") {
            return Err(format!("The database is read-only: {name} can't be changed"));
        }
        conn.query_row(&format!("PRAGMA {name} = {text}"), [], |_| Ok(())).or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(()),
            other => Err(err(other)),
        })?;
        if name == "page_size" || name == "auto_vacuum" {
            vacuum = true;
        }
    }
    if vacuum && !db.read_only {
        conn.execute_batch("VACUUM").map_err(err)?;
    }
    Ok(json!({ "pragmas": pragmas_get(conn), "dirty": dirty(conn) }))
}

// --- Export / import ----------------------------------------------------------------------------

/// A table's or a query's rows, for the exports: (columns, statement SQL).
fn export_source(conn: &Connection, args: &Value) -> Res<(Vec<String>, String)> {
    if let Some(sql) = opt_string(args, "sql") {
        let sql = strip_trailing_semicolons(&sql).to_string();
        let statement = conn.prepare(&sql).map_err(err)?;
        if !statement.readonly() {
            return Err("Only a query that reads (SELECT) can be exported".into());
        }
        let columns = statement.column_names().into_iter().map(str::to_string).collect();
        return Ok((columns, sql));
    }
    let table = string(args, "table")?;
    let columns: Vec<String> =
        table_columns(conn, &table)?.into_iter().filter(|column| column.hidden != 1).map(|column| column.name).collect();
    let list: Vec<String> = columns.iter().map(|column| quote_ident(column)).collect();
    Ok((columns, format!("SELECT {} FROM {}", list.join(", "), quote_ident(&table))))
}

fn csv_field(text: &str, separator: char, quote: Option<char>) -> String {
    let Some(quote) = quote else { return text.to_string() };
    let needs = text.contains(separator)
        || text.contains(quote)
        || text.contains('\n')
        || text.contains('\r')
        || text.starts_with(' ')
        || text.ends_with(' ');
    if needs {
        let doubled = text.replace(quote, &format!("{quote}{quote}"));
        format!("{quote}{doubled}{quote}")
    } else {
        text.to_string()
    }
}

/// Write `text` to `file`, or hand it back.
fn deliver(text: String, args: &Value, rows: usize) -> Res<Value> {
    match opt_string(args, "file") {
        Some(file) => {
            std::fs::write(&file, text.as_bytes()).map_err(|error| format!("Could not write {file}: {error}"))?;
            Ok(json!({ "rows": rows, "file": file }))
        }
        None => Ok(json!({ "rows": rows, "text": text })),
    }
}

fn export_csv(conn: &Connection, args: &Value) -> Res<Value> {
    let (columns, sql) = export_source(conn, args)?;
    let separator = character(args, "separator", Some(',')).unwrap_or(',');
    let quote = character(args, "quote", Some('"'));
    let newline = if opt_string(args, "newline").as_deref() == Some("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::new();
    if boolean(args, "header", true) {
        let header: Vec<String> = columns.iter().map(|column| csv_field(column, separator, quote)).collect();
        out.push_str(&header.join(&separator.to_string()));
        out.push_str(newline);
    }
    let mut statement = conn.prepare(&sql).map_err(err)?;
    let mut rows = statement.raw_query();
    let mut count = 0;
    while let Some(row) = rows.next().map_err(err)? {
        for index in 0..columns.len() {
            if index > 0 {
                out.push(separator);
            }
            let value = row.get_ref(index).map_err(err)?;
            out.push_str(&csv_field(&plain_text(value), separator, quote));
        }
        out.push_str(newline);
        count += 1;
    }
    drop(rows);
    deliver(out, args, count)
}

fn export_json(conn: &Connection, args: &Value) -> Res<Value> {
    let (columns, sql) = export_source(conn, args)?;
    let mut statement = conn.prepare(&sql).map_err(err)?;
    let mut rows = statement.raw_query();
    let mut list = vec![];
    while let Some(row) = rows.next().map_err(err)? {
        let mut object = Map::new();
        for (index, column) in columns.iter().enumerate() {
            object.insert(column.clone(), export_json_value(row.get_ref(index).map_err(err)?));
        }
        list.push(Value::Object(object));
    }
    drop(rows);
    let count = list.len();
    let text = serde_json::to_string_pretty(&Value::Array(list)).map_err(|error| error.to_string())? + "\n";
    deliver(text, args, count)
}

/// The database as SQL, like sqlite3's `.dump` (optionally some tables,
/// schema only or data only).
pub fn dump(conn: &Connection, tables: Option<&[String]>, schema: bool, data: bool) -> Res<String> {
    let mut out = String::from("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n");
    let mut statement = conn.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY tbl_name = 'sqlite_sequence', rowid").map_err(err)?;
    let entries: Vec<(String, String, String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    drop(statement);
    let wanted = |table: &str| tables.is_none_or(|tables| tables.iter().any(|wanted| wanted == table));
    let mut later = vec![];
    for (kind, name, table, sql) in &entries {
        if kind != "table" {
            if wanted(table) || kind == "view" && tables.is_none() {
                later.push(sql.clone());
            }
            continue;
        }
        if !wanted(name) {
            continue;
        }
        let shadow = table_kind(conn, name).map(|(kind, ..)| kind == "shadow").unwrap_or(false);
        if name == "sqlite_sequence" {
            if data {
                out.push_str("DELETE FROM sqlite_sequence;\n");
            }
        } else if name.starts_with("sqlite_stat") {
            if schema {
                out.push_str("ANALYZE sqlite_schema;\n");
            }
        } else if shadow {
            continue;
        } else if schema {
            out.push_str(sql);
            out.push_str(";\n");
        }
        if !data || sql.to_ascii_uppercase().starts_with("CREATE VIRTUAL TABLE") {
            continue;
        }
        let columns = table_columns(conn, name)?;
        let stored: Vec<&Column> = columns.iter().filter(|column| column.hidden == 0).collect();
        let list: Vec<String> = stored.iter().map(|column| quote_ident(&column.name)).collect();
        let target = if stored.len() == columns.len() {
            quote_ident(name)
        } else {
            format!("{}({})", quote_ident(name), list.join(","))
        };
        let mut select = conn.prepare(&format!("SELECT {} FROM {}", list.join(", "), quote_ident(name))).map_err(err)?;
        let mut rows = select.raw_query();
        while let Some(row) = rows.next().map_err(err)? {
            let values: Vec<String> = (0..list.len()).map(|index| row.get_ref(index).map(sql_literal)).collect::<Result<_, _>>().map_err(err)?;
            out.push_str(&format!("INSERT INTO {target} VALUES({});\n", values.join(",")));
        }
    }
    if schema {
        for sql in later {
            out.push_str(&sql);
            out.push_str(";\n");
        }
    }
    out.push_str("COMMIT;\n");
    Ok(out)
}

fn export_sql(conn: &Connection, args: &Value) -> Res<Value> {
    let tables: Option<Vec<String>> = get(args, "tables").and_then(|tables| serde_json::from_value(tables.clone()).ok());
    let text = dump(conn, tables.as_deref(), boolean(args, "schema", true), boolean(args, "data", true))?;
    let count = text.matches("\nINSERT INTO ").count();
    deliver(text, args, count)
}

/// Parse CSV (RFC 4180, with a choice of separator and quote).
pub fn parse_csv(text: &str, separator: char, quote: Option<char>) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = vec![];
    let mut row = vec![];
    let mut field = String::new();
    let mut quoted = false;
    let mut was_quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if Some(c) == quote {
                if chars.peek() == quote.as_ref() {
                    field.push(c);
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        if Some(c) == quote && field.is_empty() && !was_quoted {
            quoted = true;
            was_quoted = true;
        } else if c == separator {
            row.push(std::mem::take(&mut field));
            was_quoted = false;
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            was_quoted = false;
            if !(row.len() == 1 && row[0].is_empty()) {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() || was_quoted {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn csv_input(args: &Value) -> Res<(Vec<String>, Vec<Vec<String>>)> {
    let text = match opt_string(args, "text") {
        Some(text) => text,
        None => {
            let file = string(args, "file")?;
            let bytes = std::fs::read(&file).map_err(|error| format!("Could not read {file}: {error}"))?;
            String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
        }
    };
    let separator = character(args, "separator", Some(',')).unwrap_or(',');
    let quote = character(args, "quote", Some('"'));
    let mut rows = parse_csv(&text, separator, quote);
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let header = if boolean(args, "header", true) && !rows.is_empty() {
        let mut names: Vec<String> = rows.remove(0);
        names.resize(width, String::new());
        // Blank or repeated names: field<n>, name_2…
        let mut seen = std::collections::HashSet::new();
        for (index, name) in names.iter_mut().enumerate() {
            let base = if name.trim().is_empty() { format!("field{}", index + 1) } else { name.trim().to_string() };
            let mut candidate = base.clone();
            let mut suffix = 2;
            while !seen.insert(candidate.to_lowercase()) {
                candidate = format!("{base}_{suffix}");
                suffix += 1;
            }
            *name = candidate;
        }
        names
    } else {
        (1..=width).map(|index| format!("field{index}")).collect()
    };
    Ok((header, rows))
}

fn csv_preview(args: &Value) -> Res<Value> {
    let (columns, rows) = csv_input(args)?;
    let limit = number(args, "limit", 20).max(0) as usize;
    Ok(json!({ "columns": columns, "rows": rows.iter().take(limit).collect::<Vec<_>>(), "total": rows.len() }))
}

/// INTEGER, REAL or TEXT: what a new table's column holds.
fn infer_type(rows: &[Vec<String>], index: usize) -> &'static str {
    let mut kind = "INTEGER";
    let mut any = false;
    for row in rows {
        let Some(value) = row.get(index).map(|value| value.trim()) else { continue };
        if value.is_empty() {
            continue;
        }
        any = true;
        if kind == "INTEGER" && value.parse::<i64>().is_err() {
            kind = "REAL";
        }
        if kind == "REAL" && !value.parse::<f64>().is_ok_and(f64::is_finite) {
            return "TEXT";
        }
    }
    if any { kind } else { "TEXT" }
}

fn import_csv(db: &Db, conn: &Connection, args: &Value) -> Res<Value> {
    let table = string(args, "table")?;
    if table.trim().is_empty() {
        return Err("Name the table to import into".into());
    }
    let (header, rows) = csv_input(args)?;
    if header.is_empty() {
        return Err("The file has no columns".into());
    }
    let exists = table_kind(conn, &table).is_ok();
    let (columns, types): (Vec<String>, Vec<&'static str>) = if exists {
        let existing: Vec<Column> = table_columns(conn, &table)?.into_iter().filter(|column| column.hidden == 0).collect();
        if existing.len() < header.len() {
            return Err(format!("{table} has {} columns; the file has {}", existing.len(), header.len()));
        }
        // By name when the header matches; else in order.
        let by_name: Option<Vec<&Column>> =
            header.iter().map(|name| existing.iter().find(|column| column.name.eq_ignore_ascii_case(name))).collect();
        let chosen: Vec<&Column> = by_name.unwrap_or_else(|| existing.iter().take(header.len()).collect());
        (chosen.iter().map(|column| column.name.clone()).collect(), chosen.iter().map(|column| affinity(&column.decl_type)).collect())
    } else {
        (header.clone(), (0..header.len()).map(|index| infer_type(&rows, index)).collect())
    };
    let inserted = edit(db, conn, || {
        if !exists {
            let definitions: Vec<String> =
                columns.iter().zip(&types).map(|(name, kind)| format!("{} {kind}", quote_ident(name))).collect();
            conn.execute_batch(&format!("CREATE TABLE {} ({})", quote_ident(&table), definitions.join(", "))).map_err(err)?;
        }
        let list: Vec<String> = columns.iter().map(|name| quote_ident(name)).collect();
        let marks: Vec<String> = (1..=columns.len()).map(|index| format!("?{index}")).collect();
        let mut statement = conn
            .prepare(&format!("INSERT INTO {} ({}) VALUES ({})", quote_ident(&table), list.join(", "), marks.join(", ")))
            .map_err(err)?;
        for (number, row) in rows.iter().enumerate() {
            let values: Vec<SqlValue> = (0..columns.len())
                .map(|index| {
                    let text = row.get(index).cloned().unwrap_or_default();
                    if text.is_empty() && types[index] != "TEXT" {
                        SqlValue::Null
                    } else {
                        SqlValue::Text(text)
                    }
                })
                .collect();
            statement
                .execute(rusqlite::params_from_iter(values.iter()))
                .map_err(|error| format!("Row {}: {}", number + 1, err(error)))?;
        }
        Ok(rows.len())
    })?;
    Ok(json!({ "rows": inserted, "created": !exists, "columns": columns, "dirty": dirty(conn) }))
}

// --- Maintenance --------------------------------------------------------------------------------

fn integrity_check(conn: &Connection) -> Res<Value> {
    let mut statement = conn.prepare("PRAGMA integrity_check").map_err(err)?;
    let messages: Vec<String> = statement.query_map([], |row| row.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    drop(statement);
    let mut statement = conn.prepare("PRAGMA foreign_key_check").map_err(err)?;
    let problems: Vec<Value> = statement
        .query_map([], |row| {
            Ok(json!({ "table": row.get::<_, String>(0)?, "rowid": row.get::<_, Option<i64>>(1)?, "parent": row.get::<_, String>(2)?, "fkid": row.get::<_, i64>(3)? }))
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(json!({ "ok": messages == ["ok"] && problems.is_empty(), "messages": messages, "foreignKeys": problems }))
}

// --- Dispatch -----------------------------------------------------------------------------------

/// Run one operation (blocking: callers use `request`).
pub fn call(state: &DatabaseState, op: &str, args: &Value) -> Res<Value> {
    match op {
        "sniff" => return Ok(json!(is_sqlite_file(&string(args, "path")?))),
        "close" => {
            state.close(&string(args, "path")?);
            return Ok(Value::Null);
        }
        "csv_preview" => return csv_preview(args),
        "interrupt" => {
            if let Ok(db) = state.db(&string(args, "path")?) {
                db.interrupt.interrupt();
            }
            return Ok(Value::Null);
        }
        _ => {}
    }
    let path = string(args, "path")?;
    let db = if op == "open" { state.open(&path)? } else { state.db(&path)? };
    let conn = db.conn.lock().map_err(|_| "The database connection failed".to_string())?;
    let conn = &*conn;
    match op {
        "open" | "schema" => schema(&db, conn, &path, boolean(args, "counts", true)),
        "status" => Ok(json!({ "dirty": dirty(conn), "readOnly": db.read_only })),
        "query" => query_page(conn, args),
        "execute" => execute(&db, conn, args),
        "update_cell" => update_cell(&db, conn, args),
        "insert_row" => insert_row(&db, conn, args),
        "delete_rows" => delete_rows(&db, conn, args),
        "blob_get" => blob_get(conn, args),
        "commit" => commit(&db, conn),
        "rollback" => {
            if dirty(conn) {
                conn.execute_batch("ROLLBACK").map_err(err)?;
            }
            restore_foreign_keys(&db, conn);
            Ok(json!({ "dirty": dirty(conn) }))
        }
        "pragmas_get" => Ok(json!({ "pragmas": pragmas_get(conn), "dirty": dirty(conn) })),
        "pragmas_set" => pragmas_set(&db, conn, args),
        "export_csv" => export_csv(conn, args),
        "export_json" => export_json(conn, args),
        "export_sql" => export_sql(conn, args),
        "import_csv" => import_csv(&db, conn, args),
        "vacuum" => {
            require_clean(conn, "vacuuming")?;
            if db.read_only {
                return Err("The database is read-only".into());
            }
            conn.execute_batch("VACUUM").map_err(err)?;
            Ok(json!({ "fileSize": std::fs::metadata(&path).map(|metadata| metadata.len()).ok() }))
        }
        "integrity_check" => integrity_check(conn),
        other => Err(format!("Unknown database operation {other}")),
    }
}

/// Run one operation off the async runtime.
pub async fn request(state: Arc<DatabaseState>, op: String, args: Value) -> Res<Value> {
    tokio::task::spawn_blocking(move || call(&state, &op, &args)).await.map_err(|error| error.to_string())?
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn database_call(
    window: tauri::WebviewWindow,
    states: tauri::State<'_, crate::windows::PerWindow<DatabaseState>>,
    op: String,
    args: Value,
) -> Result<Value, String> {
    request(states.get(window.label()), op, args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _dir: std::path::PathBuf,
        path: String,
        state: DatabaseState,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.state.close_all();
            let _ = std::fs::remove_dir_all(&self._dir);
        }
    }

    fn fixture(name: &str, setup: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("sable-db-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(setup).unwrap();
        drop(conn);
        Fixture { _dir: dir, path: path.to_string_lossy().into_owned(), state: DatabaseState::default() }
    }

    fn op(fixture: &Fixture, op: &str, mut args: Value) -> Value {
        args["path"] = json!(fixture.path);
        call(&fixture.state, op, &args).unwrap_or_else(|error| panic!("{op}: {error}"))
    }

    fn op_err(fixture: &Fixture, op: &str, mut args: Value) -> String {
        args["path"] = json!(fixture.path);
        call(&fixture.state, op, &args).expect_err("expected an error")
    }

    /// Read the file with a separate connection (what's on disk).
    fn on_disk(fixture: &Fixture, sql: &str) -> Value {
        let conn = Connection::open_with_flags(&fixture.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        conn.query_row(sql, [], |row| Ok(to_json(row.get_ref(0)?))).unwrap()
    }

    const SAMPLE: &str = "
        CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, country TEXT);
        CREATE TABLE albums (id INTEGER PRIMARY KEY, artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE, title TEXT, year INTEGER, rating REAL, cover BLOB);
        CREATE INDEX albums_year ON albums(year);
        CREATE VIEW album_list AS SELECT albums.title, artists.name FROM albums JOIN artists ON artists.id = albums.artist_id;
        CREATE TRIGGER albums_touch AFTER UPDATE ON albums BEGIN SELECT 1; END;
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
        INSERT INTO artists (name, country) VALUES ('Nina Simone', 'US'), ('Björk', 'IS'), ('Fela Kuti', 'NG');
        INSERT INTO albums (artist_id, title, year, rating, cover) VALUES
          (1, 'Pastel Blues', 1965, 4.5, X'89504E470D0A1A0A0000'),
          (2, 'Homogenic', 1997, 5.0, NULL),
          (3, 'Zombie', 1976, NULL, NULL),
          (1, 'Wild Is the Wind', 1966, 4.0, NULL);
        INSERT INTO settings VALUES ('theme', 'dark'), ('lang', 'en');
    ";

    #[test]
    fn opens_and_reads_the_schema() {
        let fixture = fixture("schema", SAMPLE);
        let schema = op(&fixture, "open", json!({}));
        assert_eq!(schema["readOnly"], false);
        assert_eq!(schema["dirty"], false);
        let tables = schema["tables"].as_array().unwrap();
        let names: Vec<&str> = tables.iter().map(|table| table["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["albums", "artists", "settings", "sqlite_sequence"]);
        let albums = &tables[0];
        assert_eq!(albums["rowCount"], 4);
        assert_eq!(albums["foreignKeys"][0]["table"], "artists");
        assert_eq!(albums["foreignKeys"][0]["from"], "artist_id");
        assert_eq!(albums["foreignKeys"][0]["onDelete"], "CASCADE");
        assert_eq!(albums["columns"][0]["pk"], 1);
        assert_eq!(albums["columns"][1]["notnull"], true);
        assert_eq!(albums["columns"][4]["type"], "REAL");
        let artists = &tables[1];
        assert_eq!(artists["columns"][1]["unique"], true);
        assert_eq!(artists["columns"][0]["autoincrement"], true);
        assert_eq!(tables[2]["withoutRowid"], true);
        assert_eq!(albums["withoutRowid"], false);
        assert_eq!(schema["views"][0]["name"], "album_list");
        assert_eq!(schema["views"][0]["columns"][1]["name"], "name");
        assert_eq!(schema["indexes"][0]["name"], "albums_year");
        assert_eq!(schema["indexes"][0]["columns"], json!(["year"]));
        assert_eq!(schema["triggers"][0]["table"], "albums");
        assert!(schema["triggers"][0]["sql"].as_str().unwrap().contains("AFTER UPDATE"));
    }

    #[test]
    fn rejects_files_that_arent_databases() {
        let fixture = fixture("notdb", "CREATE TABLE x (a);");
        let other = std::path::Path::new(&fixture.path).with_file_name("notes.txt");
        std::fs::write(&other, "This is not a database, it's a text file with enough bytes in it to look like one. ".repeat(3)).unwrap();
        let error = call(&fixture.state, "open", &json!({ "path": other.to_string_lossy() })).unwrap_err();
        assert!(error.contains("isn't a SQLite database"), "{error}");
        assert_eq!(call(&fixture.state, "sniff", &json!({ "path": other.to_string_lossy() })).unwrap(), json!(false));
        assert_eq!(call(&fixture.state, "sniff", &json!({ "path": fixture.path })).unwrap(), json!(true));
    }

    #[test]
    fn pages_sorts_and_filters() {
        let fixture = fixture("query", SAMPLE);
        op(&fixture, "open", json!({}));
        let page = op(&fixture, "query", json!({ "table": "albums", "offset": 0, "limit": 2, "count": true }));
        assert_eq!(page["total"], 4);
        assert_eq!(page["keyColumns"], json!(["_rowid_"]));
        assert_eq!(page["columns"], json!(["id", "artist_id", "title", "year", "rating", "cover"]));
        assert_eq!(page["rows"].as_array().unwrap().len(), 2);
        assert_eq!(page["rows"][0][2], "Pastel Blues");
        assert_eq!(page["rows"][0][4], json!({ "r": 4.5 }));
        assert_eq!(page["rows"][0][5]["b"], 10);
        assert_eq!(page["rows"][0][5]["m"], "image/png");
        assert_eq!(page["rows"][2 - 1][5], Value::Null);
        assert_eq!(page["keys"][1], json!([2]));

        let sorted = op(&fixture, "query", json!({ "table": "albums", "sort": [{ "column": "year", "desc": true }], "limit": 10 }));
        let years: Vec<i64> = sorted["rows"].as_array().unwrap().iter().map(|row| row[3].as_i64().unwrap()).collect();
        assert_eq!(years, [1997, 1976, 1966, 1965]);

        let paged = op(&fixture, "query", json!({ "table": "albums", "sort": [{ "column": "year" }], "offset": 2, "limit": 10 }));
        assert_eq!(paged["rows"][0][3], 1976);

        let filter = |filters: Value| {
            let page = op(&fixture, "query", json!({ "table": "albums", "filters": filters, "count": true, "limit": 100 }));
            let mut titles = page["rows"].as_array().unwrap().iter().map(|row| row[2].as_str().unwrap().to_string()).collect::<Vec<_>>();
            titles.sort();
            titles
        };
        assert_eq!(filter(json!({ "title": "wind" })), ["Wild Is the Wind"]);
        assert_eq!(filter(json!({ "year": ">1970" })), ["Homogenic", "Zombie"]);
        assert_eq!(filter(json!({ "year": "<=1965" })), ["Pastel Blues"]);
        assert_eq!(filter(json!({ "year": "=1997" })), ["Homogenic"]);
        assert_eq!(filter(json!({ "year": "<>1997", "rating": ">=4.5" })), ["Pastel Blues"]);
        assert_eq!(filter(json!({ "year": "1966~1980" })), ["Wild Is the Wind", "Zombie"]);
        assert_eq!(filter(json!({ "rating": "NULL" })), ["Zombie"]);
        assert_eq!(filter(json!({ "title": "100%" })), Vec::<String>::new());
        let searched = op(&fixture, "query", json!({ "table": "albums", "search": "homo", "count": true }));
        assert_eq!(searched["total"], 1);

        // A view, and a query.
        let view = op(&fixture, "query", json!({ "table": "album_list", "count": true }));
        assert_eq!(view["total"], 4);
        assert_eq!(view["keyColumns"], json!([]));
        let query = op(&fixture, "query", json!({ "sql": "SELECT title, year FROM albums WHERE year < 1970;", "sort": [{ "column": "year", "desc": true }], "count": true }));
        assert_eq!(query["total"], 2);
        assert_eq!(query["rows"][0], json!(["Wild Is the Wind", 1966]));
    }

    #[test]
    fn big_integers_and_reals_keep_their_type() {
        let fixture = fixture("values", "CREATE TABLE t (a, b); INSERT INTO t VALUES (9007199254740993, 2.0), (-5, 'x');");
        op(&fixture, "open", json!({}));
        let page = op(&fixture, "query", json!({ "table": "t" }));
        assert_eq!(page["rows"][0], json!([{ "i": "9007199254740993" }, { "r": 2.0 }]));
        assert_eq!(page["rows"][1], json!([-5, "x"]));
        // And back.
        op(&fixture, "update_cell", json!({ "table": "t", "key": [2], "column": "a", "value": { "i": "9007199254740995" } }));
        let page = op(&fixture, "query", json!({ "table": "t" }));
        assert_eq!(page["rows"][1][0], json!({ "i": "9007199254740995" }));
    }

    #[test]
    fn edits_roll_back_and_commit() {
        let fixture = fixture("edit", SAMPLE);
        op(&fixture, "open", json!({}));
        // Text typed into an INTEGER column is stored as an integer.
        let updated = op(&fixture, "update_cell", json!({ "table": "albums", "key": [3], "column": "year", "value": "1977" }));
        assert_eq!(updated["value"], 1977);
        assert_eq!(updated["dirty"], true);
        // Reads see the edit; the file doesn't.
        let page = op(&fixture, "query", json!({ "table": "albums", "filters": { "id": "=3" } }));
        assert_eq!(page["rows"][0][3], 1977);
        assert_eq!(on_disk(&fixture, "SELECT year FROM albums WHERE id = 3"), 1976);
        op(&fixture, "rollback", json!({}));
        assert_eq!(op(&fixture, "status", json!({}))["dirty"], false);
        let page = op(&fixture, "query", json!({ "table": "albums", "filters": { "id": "=3" } }));
        assert_eq!(page["rows"][0][3], 1976);

        // Insert, delete, NULL, then write.
        let inserted = op(&fixture, "insert_row", json!({ "table": "albums" }));
        assert_eq!(inserted["key"], json!([5]));
        op(&fixture, "update_cell", json!({ "table": "albums", "key": [5], "column": "title", "value": "Debut" }));
        op(&fixture, "update_cell", json!({ "table": "albums", "key": [1], "column": "rating", "value": null }));
        let deleted = op(&fixture, "delete_rows", json!({ "table": "albums", "keys": [[2], [4]] }));
        assert_eq!(deleted["deleted"], 2);
        assert_eq!(on_disk(&fixture, "SELECT count(*) FROM albums"), 4);
        op(&fixture, "commit", json!({}));
        assert_eq!(on_disk(&fixture, "SELECT count(*) FROM albums"), 3);
        assert_eq!(on_disk(&fixture, "SELECT title FROM albums WHERE id = 5"), "Debut");
        // A NOT NULL foreign key got an existing parent.
        assert_eq!(on_disk(&fixture, "SELECT artist_id IN (SELECT id FROM artists) FROM albums WHERE id = 5"), 1);
        assert_eq!(on_disk(&fixture, "SELECT rating FROM albums WHERE id = 1"), Value::Null);

        // Changing the INTEGER PRIMARY KEY changes the row's key.
        let moved = op(&fixture, "update_cell", json!({ "table": "albums", "key": [5], "column": "id", "value": 50 }));
        assert_eq!(moved["key"], json!([50]));
        // A blob.
        op(&fixture, "update_cell", json!({ "table": "albums", "key": [50], "column": "cover", "value": { "b": 3, "d": "AQID" } }));
        let blob = op(&fixture, "blob_get", json!({ "table": "albums", "key": [50], "column": "cover" }));
        assert_eq!(blob["d"], "AQID");
        op(&fixture, "rollback", json!({}));
    }

    #[test]
    fn without_rowid_tables_are_edited_by_primary_key() {
        let fixture = fixture("wr", SAMPLE);
        op(&fixture, "open", json!({}));
        let page = op(&fixture, "query", json!({ "table": "settings", "sort": [{ "column": "key" }] }));
        assert_eq!(page["keyColumns"], json!(["key"]));
        assert_eq!(page["keys"], json!([["lang"], ["theme"]]));
        let updated = op(&fixture, "update_cell", json!({ "table": "settings", "key": ["theme"], "column": "value", "value": "light" }));
        assert_eq!(updated["value"], "light");
        let renamed = op(&fixture, "update_cell", json!({ "table": "settings", "key": ["lang"], "column": "key", "value": "language" }));
        assert_eq!(renamed["key"], json!(["language"]));
        let inserted = op(&fixture, "insert_row", json!({ "table": "settings" }));
        assert_eq!(inserted["key"], json!(["new 3"]));
        op(&fixture, "delete_rows", json!({ "table": "settings", "keys": [["theme"]] }));
        op(&fixture, "commit", json!({}));
        assert_eq!(on_disk(&fixture, "SELECT group_concat(key, ',') FROM (SELECT key FROM settings ORDER BY key)"), "language,new 3");
    }

    #[test]
    fn executes_statements_and_stops_at_an_error() {
        let fixture = fixture("exec", SAMPLE);
        op(&fixture, "open", json!({}));
        let sql = "-- a comment\nUPDATE albums SET rating = 1 WHERE year < 1970;\nINSERT INTO artists (name) VALUES ('a;b');\nSELECT * FROM nope;\nSELECT 1;";
        let result = op(&fixture, "execute", json!({ "sql": sql }));
        let statements = result["statements"].as_array().unwrap();
        assert_eq!(result["total"], 4);
        assert_eq!(statements.len(), 3);
        assert_eq!(statements[0]["kind"], "changes");
        assert_eq!(statements[0]["changes"], 2);
        assert_eq!(statements[0]["line"], 2);
        assert_eq!(statements[1]["changes"], 1);
        assert_eq!(statements[2]["kind"], "error");
        assert!(statements[2]["error"].as_str().unwrap().contains("no such table"), "{}", statements[2]);
        assert_eq!(statements[2]["errorLine"], 4);
        assert_eq!(result["dirty"], true);
        op(&fixture, "rollback", json!({}));
        assert_eq!(on_disk(&fixture, "SELECT count(*) FROM artists"), 3);

        // The last SELECT pages through `query`; other statements return their rows.
        let result = op(&fixture, "execute", json!({ "sql": "PRAGMA table_info(albums); SELECT title FROM albums ORDER BY id" }));
        let statements = result["statements"].as_array().unwrap();
        assert_eq!(statements[0]["kind"], "rows");
        assert_eq!(statements[1]["pageable"], true);
        assert_eq!(statements[1]["query"], "SELECT title FROM albums ORDER BY id");
        assert_eq!(result["dirty"], false);
        let result = op(&fixture, "execute", json!({ "sql": "PRAGMA table_info(albums)" }));
        assert_eq!(result["statements"][0]["rows"].as_array().unwrap().len(), 6);

        // DDL in the transaction; a trigger body with semicolons.
        let result = op(
            &fixture,
            "execute",
            json!({ "sql": "CREATE TABLE log (msg TEXT);\nCREATE TRIGGER t AFTER INSERT ON artists BEGIN INSERT INTO log VALUES ('x'); INSERT INTO log VALUES ('y'); END;\nINSERT INTO artists (name) VALUES ('Z');\nSELECT count(*) FROM log" }),
        );
        assert_eq!(result["statements"].as_array().unwrap().len(), 4, "{result}");
        assert_eq!(result["schemaChanged"], true);
        let count = op(&fixture, "query", json!({ "sql": result["statements"][3]["query"] }));
        assert_eq!(count["rows"][0][0], 2);
        op(&fixture, "rollback", json!({}));
        assert!(op(&fixture, "schema", json!({}))["tables"].as_array().unwrap().iter().all(|table| table["name"] != "log"));

        // VACUUM refuses with pending changes.
        op(&fixture, "update_cell", json!({ "table": "albums", "key": [1], "column": "title", "value": "x" }));
        let result = op(&fixture, "execute", json!({ "sql": "VACUUM" }));
        assert_eq!(result["statements"][0]["kind"], "error");
        assert!(op_err(&fixture, "vacuum", json!({})).contains("Write or revert"));
        op(&fixture, "rollback", json!({}));
        op(&fixture, "vacuum", json!({}));
    }

    #[test]
    fn rebuilds_a_table_without_cascading() {
        let fixture = fixture("rebuild", SAMPLE);
        op(&fixture, "open", json!({}));
        assert_eq!(op(&fixture, "pragmas_get", json!({}))["pragmas"]["foreign_keys"], 1);
        // Rebuild artists (albums reference it ON DELETE CASCADE).
        let script = "CREATE TABLE new_artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, country TEXT, born INTEGER);
            INSERT INTO new_artists (id, name, country) SELECT id, name, country FROM artists;
            DROP TABLE artists;
            PRAGMA legacy_alter_table = 1;
            ALTER TABLE new_artists RENAME TO artists;
            PRAGMA legacy_alter_table = 0;";
        let result = op(&fixture, "execute", json!({ "sql": script, "foreignKeysOff": true }));
        assert!(result["statements"].as_array().unwrap().iter().all(|statement| statement["kind"] != "error"), "{result}");
        assert_eq!(op(&fixture, "query", json!({ "table": "albums", "count": true }))["total"], 4);
        op(&fixture, "commit", json!({}));
        assert_eq!(on_disk(&fixture, "SELECT count(*) FROM albums"), 4);
        assert_eq!(on_disk(&fixture, "SELECT count(*) FROM pragma_table_info('artists')"), 4);
        assert_eq!(op(&fixture, "pragmas_get", json!({}))["pragmas"]["foreign_keys"], 1);
    }

    #[test]
    fn splits_statements() {
        let sql = "SELECT ';'; -- c;\nSELECT \"a;b\" FROM t; /* x; */\nCREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; SELECT 2; END; SELECT 3";
        let parts: Vec<&str> = split_statements(sql).into_iter().map(|(start, end)| sql[start..end].trim()).collect();
        assert_eq!(parts.len(), 4, "{parts:?}");
        assert_eq!(parts[0], "SELECT ';';");
        assert!(parts[2].ends_with("END;"));
        assert_eq!(parts[3], "SELECT 3");
        assert!(split_statements("  -- nothing\n").is_empty());
    }

    #[test]
    fn exports_and_imports_csv() {
        let fixture = fixture("csv", SAMPLE);
        op(&fixture, "open", json!({}));
        op(&fixture, "update_cell", json!({ "table": "artists", "key": [3], "column": "name", "value": "Kuti, \"Fela\"\nAnikulapo" }));
        let exported = op(&fixture, "export_csv", json!({ "table": "artists" }));
        let text = exported["text"].as_str().unwrap();
        assert_eq!(exported["rows"], 3);
        assert!(text.starts_with("id,name,country\n1,Nina Simone,US\n"));
        assert!(text.contains("3,\"Kuti, \"\"Fela\"\"\nAnikulapo\",NG\n"), "{text}");

        // Round trip into a new table: same rows, types inferred.
        let imported = op(&fixture, "import_csv", json!({ "table": "artists_copy", "text": text, "header": true }));
        assert_eq!(imported["rows"], 3);
        assert_eq!(imported["created"], true);
        let copy = op(&fixture, "query", json!({ "table": "artists_copy" }));
        let original = op(&fixture, "query", json!({ "table": "artists" }));
        assert_eq!(copy["rows"], original["rows"]);
        let schema = op(&fixture, "schema", json!({}));
        let copy_table = schema["tables"].as_array().unwrap().iter().find(|table| table["name"] == "artists_copy").unwrap().clone();
        assert_eq!(copy_table["columns"][0]["type"], "INTEGER");
        assert_eq!(copy_table["columns"][1]["type"], "TEXT");

        // Into an existing table, semicolon-separated, no header.
        let imported = op(&fixture, "import_csv", json!({ "table": "artists_copy", "text": "7;Sun Ra;US\r\n8;Tinariwen;\r\n", "separator": ";", "header": false }));
        assert_eq!(imported["created"], false);
        let page = op(&fixture, "query", json!({ "table": "artists_copy", "filters": { "id": ">=7" } }));
        assert_eq!(page["rows"], json!([[7, "Sun Ra", "US"], [8, "Tinariwen", ""]]));

        // To a file, as JSON too; a query.
        let file = std::path::Path::new(&fixture.path).with_file_name("out.csv");
        op(&fixture, "export_csv", json!({ "sql": "SELECT name FROM artists WHERE id < 3", "file": file.to_string_lossy(), "separator": "\t", "header": false }));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "Nina Simone\nBjörk\n");
        let exported = op(&fixture, "export_json", json!({ "table": "albums" }));
        let rows: Value = serde_json::from_str(exported["text"].as_str().unwrap()).unwrap();
        assert_eq!(rows[0]["title"], "Pastel Blues");
        assert_eq!(rows[0]["rating"], 4.5);
        assert_eq!(rows[0]["cover"], "iVBORw0KGgoAAA==");

        let preview = op(&fixture, "csv_preview", json!({ "text": "a,b\n1,2\n3,4\n", "limit": 1 }));
        assert_eq!(preview, json!({ "columns": ["a", "b"], "rows": [["1", "2"]], "total": 2 }));
        op(&fixture, "rollback", json!({}));
    }

    #[test]
    fn parses_csv() {
        assert_eq!(parse_csv("a,b\n\"x,1\",\"he said \"\"hi\"\"\"\n", ',', Some('"')), vec![vec!["a", "b"], vec!["x,1", "he said \"hi\""]]);
        assert_eq!(parse_csv("\u{feff}a;b\r\n1;\r\n\r\n", ';', Some('"')), vec![vec!["a", "b"], vec!["1", ""]]);
        assert_eq!(parse_csv("a\tb", '\t', None), vec![vec!["a", "b"]]);
        assert_eq!(parse_csv("\"multi\nline\",2", ',', Some('"')), vec![vec!["multi\nline", "2"]]);
    }

    #[test]
    fn dumps_the_database_as_sql() {
        let fixture = fixture("dump", SAMPLE);
        op(&fixture, "open", json!({}));
        let dumped = op(&fixture, "export_sql", json!({}));
        let text = dumped["text"].as_str().unwrap().to_string();
        assert!(text.starts_with("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE artists"));
        assert!(text.contains("INSERT INTO \"albums\" VALUES(1,1,'Pastel Blues',1965,4.5,X'89504e470d0a1a0a0000');"));
        assert!(text.contains("INSERT INTO \"albums\" VALUES(2,2,'Homogenic',1997,5.0,NULL);"));
        assert!(text.contains("DELETE FROM sqlite_sequence;"));
        assert!(text.contains("CREATE VIEW album_list"));
        assert!(text.ends_with("COMMIT;\n"));
        // Loading the dump makes the same database.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&text).unwrap();
        let title: String = conn.query_row("SELECT title FROM album_list WHERE name = 'Björk'", [], |row| row.get(0)).unwrap();
        assert_eq!(title, "Homogenic");
        let seq: i64 = conn.query_row("SELECT seq FROM sqlite_sequence WHERE name = 'artists'", [], |row| row.get(0)).unwrap();
        assert_eq!(seq, 3);
        // Schema only, one table.
        let schema_only = op(&fixture, "export_sql", json!({ "tables": ["settings"], "data": false }));
        let text = schema_only["text"].as_str().unwrap();
        assert!(text.contains("CREATE TABLE settings") && !text.contains("INSERT") && !text.contains("artists"));
    }

    #[test]
    fn pragmas_and_maintenance() {
        let fixture = fixture("pragmas", SAMPLE);
        op(&fixture, "open", json!({}));
        let pragmas = op(&fixture, "pragmas_get", json!({}));
        assert_eq!(pragmas["pragmas"]["encoding"], "UTF-8");
        assert_eq!(pragmas["pragmas"]["user_version"], 0);
        let set = op(&fixture, "pragmas_set", json!({ "values": { "user_version": 7, "foreign_keys": true } }));
        assert_eq!(set["pragmas"]["user_version"], 7);
        assert_eq!(set["pragmas"]["foreign_keys"], 1);
        assert_eq!(on_disk(&fixture, "PRAGMA user_version"), 7);
        assert!(op_err(&fixture, "pragmas_set", json!({ "values": { "user_version": "1; DROP TABLE x" } })).contains("Invalid"));
        let check = op(&fixture, "integrity_check", json!({}));
        assert_eq!(check["ok"], true);
        op(&fixture, "update_cell", json!({ "table": "albums", "key": [1], "column": "title", "value": "x" }));
        assert!(op_err(&fixture, "pragmas_set", json!({ "values": { "user_version": 8 } })).contains("Write or revert"));
    }

    #[cfg(unix)]
    #[test]
    fn read_only_files_open_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = fixture("readonly", SAMPLE);
        std::fs::set_permissions(&fixture.path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let schema = op(&fixture, "open", json!({}));
        assert_eq!(schema["readOnly"], true);
        assert!(op_err(&fixture, "update_cell", json!({ "table": "albums", "key": [1], "column": "title", "value": "x" })).contains("read-only"));
        let result = op(&fixture, "execute", json!({ "sql": "DELETE FROM albums" }));
        assert_eq!(result["statements"][0]["kind"], "error");
        assert_eq!(op(&fixture, "query", json!({ "table": "albums", "count": true }))["total"], 4);
        std::fs::set_permissions(&fixture.path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn closing_drops_uncommitted_edits() {
        let fixture = fixture("close", SAMPLE);
        op(&fixture, "open", json!({}));
        op(&fixture, "delete_rows", json!({ "table": "albums", "keys": [[1]] }));
        op(&fixture, "close", json!({}));
        assert_eq!(on_disk(&fixture, "SELECT count(*) FROM albums"), 4);
        assert!(op_err(&fixture, "status", json!({})).contains("isn't open"));
    }
}

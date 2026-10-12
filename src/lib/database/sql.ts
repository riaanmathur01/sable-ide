import type { TableInfo, IndexInfo, TriggerInfo, Schema } from "./api";

/** `"name"`, quoted for SQL. */
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** `'text'`, quoted for SQL. */
export const quoteText = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** Common SQLite column types (the type field also takes any text). */
export const COLUMN_TYPES = ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB", "BOOLEAN", "DATE", "DATETIME", "VARCHAR(255)", "JSON"];

/** One column in the Create/Modify Table dialog. */
export interface FieldDef {
  id: string;
  name: string;
  type: string;
  pk: boolean;
  ai: boolean;
  nn: boolean;
  unique: boolean;
  /** As typed: a number, 'text', (expression), CURRENT_TIMESTAMP, NULL — or bare text (quoted for you). */
  default: string;
  check: string;
  collate: string;
  /** The column's name in the table being modified (null: a new column). */
  original: string | null;
}

export interface ForeignKeyDef {
  columns: string[];
  table: string;
  to: (string | null)[];
  onUpdate: string;
  onDelete: string;
}

export interface TableDef {
  name: string;
  fields: FieldDef[];
  withoutRowid: boolean;
  strict: boolean;
  /** Table constraints kept as written (CHECKs) from the original. */
  extra: string[];
  foreignKeys: ForeignKeyDef[];
  /** Multi-column UNIQUE constraints. */
  uniques: string[][];
}

let fieldCounter = 0;
export function newField(partial: Partial<FieldDef> = {}): FieldDef {
  fieldCounter += 1;
  return { id: `f${fieldCounter}`, name: "", type: "TEXT", pk: false, ai: false, nn: false, unique: false, default: "", check: "", collate: "", original: null, ...partial };
}

/** A default value as SQL: literals and expressions as typed, other text quoted. */
export function defaultSql(value: string): string {
  const text = value.trim();
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text)) return text;
  if (/^'.*'$/s.test(text) || /^\(.*\)$/s.test(text) || /^x'[0-9a-f]*'$/i.test(text)) return text;
  if (/^(NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(text)) return text.toUpperCase();
  return quoteText(text);
}

/** The CREATE TABLE statement for a definition (laid out like DB4S's). */
export function createTableSql(def: TableDef, name = def.name): string {
  const lines: string[] = [];
  const pk = def.fields.filter((field) => field.pk && field.name.trim());
  for (const field of def.fields) {
    if (!field.name.trim()) continue;
    let line = `\t${quoteIdent(field.name.trim())}`;
    if (field.type.trim()) line += `\t${field.type.trim()}`;
    if (field.nn) line += " NOT NULL";
    if (field.unique) line += " UNIQUE";
    if (field.default.trim()) line += ` DEFAULT ${defaultSql(field.default)}`;
    if (field.check.trim()) line += ` CHECK(${field.check.trim()})`;
    if (field.collate.trim()) line += ` COLLATE ${field.collate.trim()}`;
    lines.push(line);
  }
  if (pk.length > 0) {
    const auto = pk.length === 1 && pk[0].ai ? " AUTOINCREMENT" : "";
    lines.push(`\tPRIMARY KEY(${pk.map((field) => quoteIdent(field.name.trim())).join(",")}${auto})`);
  }
  for (const unique of def.uniques) {
    lines.push(`\tUNIQUE(${unique.map(quoteIdent).join(",")})`);
  }
  for (const key of def.foreignKeys) {
    const to = key.to.every((column) => column) ? `(${key.to.map((column) => quoteIdent(column!)).join(",")})` : "";
    let line = `\tFOREIGN KEY(${key.columns.map(quoteIdent).join(",")}) REFERENCES ${quoteIdent(key.table)}${to}`;
    if (key.onUpdate && key.onUpdate !== "NO ACTION") line += ` ON UPDATE ${key.onUpdate}`;
    if (key.onDelete && key.onDelete !== "NO ACTION") line += ` ON DELETE ${key.onDelete}`;
    lines.push(line);
  }
  for (const extra of def.extra) lines.push(`\t${extra}`);
  const options = [def.withoutRowid ? "WITHOUT ROWID" : "", def.strict ? "STRICT" : ""].filter(Boolean).join(", ");
  return `CREATE TABLE ${quoteIdent(name.trim())} (\n${lines.join(",\n")}\n)${options ? ` ${options}` : ""};`;
}

/** Split text at top-level commas (outside parentheses, quotes). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") quote = "]";
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The text of a parenthesized group starting at `open` (an index of "("). */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return text.slice(open + 1, index);
  }
  return null;
}

const unquote = (name: string) => {
  const text = name.trim();
  if (/^".*"$/s.test(text)) return text.slice(1, -1).replace(/""/g, '"');
  if (/^`.*`$/s.test(text)) return text.slice(1, -1).replace(/``/g, "`");
  if (/^\[.*\]$/s.test(text)) return text.slice(1, -1);
  if (/^'.*'$/s.test(text)) return text.slice(1, -1).replace(/''/g, "'");
  return text;
};

/** The leading identifier of a column definition. */
function leadingName(definition: string): string {
  const match = definition.match(/^("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|'(?:[^']|'')*'|[^\s(]+)/);
  return match ? unquote(match[1]) : "";
}

/** A table's definition for the Modify Table dialog (from the schema and its CREATE statement). */
export function tableDefOf(table: TableInfo): TableDef {
  const sql = table.sql ?? "";
  const open = sql.indexOf("(");
  const body = open >= 0 ? (balanced(sql, open) ?? "") : "";
  const parts = splitTopLevel(body);
  const constraintStart = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;
  const columnParts = new Map<string, string>();
  const extra: string[] = [];
  for (const part of parts) {
    if (constraintStart.test(part)) {
      if (/^(CONSTRAINT\s+\S+\s+)?CHECK\b/i.test(part)) extra.push(part);
    } else {
      columnParts.set(leadingName(part).toLowerCase(), part);
    }
  }
  const pkCount = table.columns.filter((column) => column.pk > 0).length;
  const fields = table.columns
    .filter((column) => column.hidden === 0)
    .map((column) => {
      const definition = columnParts.get(column.name.toLowerCase()) ?? "";
      const checkAt = definition.search(/\bCHECK\s*\(/i);
      const check = checkAt >= 0 ? (balanced(definition, definition.indexOf("(", checkAt)) ?? "") : "";
      const collate = definition.match(/\bCOLLATE\s+("?[\w]+"?)/i)?.[1] ?? "";
      return newField({
        name: column.name,
        type: column.type,
        pk: column.pk > 0,
        ai: column.autoincrement,
        nn: column.notnull && !(pkCount === 1 && column.pk > 0 && /^integer$/i.test(column.type) && !/NOT\s+NULL/i.test(definition)),
        unique: column.unique,
        default: column.default ?? "",
        check,
        collate: unquote(collate),
        original: column.name,
      });
    });
  const byId = new Map<number, ForeignKeyDef>();
  for (const key of table.foreignKeys) {
    const entry = byId.get(key.id) ?? { columns: [], table: key.table, to: [], onUpdate: key.onUpdate, onDelete: key.onDelete };
    entry.columns.push(key.from);
    entry.to.push(key.to);
    byId.set(key.id, entry);
  }
  const uniques = table.indexes
    .filter((index) => index.origin === "u" && index.columns.length > 1 && index.columns.every(Boolean))
    .map((index) => index.columns as string[]);
  return { name: table.name, fields, withoutRowid: table.withoutRowid, strict: table.strict, extra, foreignKeys: [...byId.values()], uniques };
}

/** Replace identifier `from` with `to` in SQL (quoted or bare). */
function renameIdent(sql: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = quoteIdent(to);
  return sql
    .replace(new RegExp(`"${escaped.replace(/"/g, '""')}"`, "gi"), quoted)
    .replace(new RegExp(`\\[${escaped}\\]`, "gi"), quoted)
    .replace(new RegExp(`\`${escaped}\``, "gi"), quoted)
    .replace(new RegExp(`(?<![\\w"'\`\\[.])${escaped}(?![\\w"'\`\\]])`, "gi"), quoted);
}

function mentions(sql: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "i").test(sql);
}

export interface ModifyPlan {
  sql: string;
  /** A rebuild: needs foreign keys off and no pending changes. */
  rebuild: boolean;
  notes: string[];
}

function sameField(a: FieldDef, b: FieldDef): boolean {
  return (
    a.type.trim().toUpperCase() === b.type.trim().toUpperCase() &&
    a.pk === b.pk &&
    a.ai === b.ai &&
    a.nn === b.nn &&
    a.unique === b.unique &&
    a.default.trim() === b.default.trim() &&
    a.check.trim() === b.check.trim() &&
    a.collate.trim().toUpperCase() === b.collate.trim().toUpperCase()
  );
}

/**
 * The SQL for Modify Table: ALTER TABLE where it can do the job (rename
 * the table or columns, add simple columns, drop unindexed ones); else
 * SQLite's rebuild procedure (a new table, copy, drop, rename, then the
 * indexes and triggers again).
 */
export function modifyTableSql(original: TableInfo, before: TableDef, after: TableDef, schema: Schema): ModifyPlan {
  const notes: string[] = [];
  const fields = after.fields.filter((field) => field.name.trim());
  const newName = after.name.trim();
  const kept = fields.filter((field) => field.original !== null);
  const added = fields.filter((field) => field.original === null);
  const dropped = before.fields.filter((field) => !fields.some((candidate) => candidate.original === field.name));
  const originalOf = new Map(before.fields.map((field) => [field.name, field]));
  const renamedColumns = kept.filter((field) => field.original !== field.name.trim());

  const indexedColumns = new Set<string>();
  for (const index of schema.indexes.filter((index) => index.table === original.name)) {
    for (const column of index.columns) if (column) indexedColumns.add(column);
  }
  for (const index of original.indexes) for (const column of index.columns) if (column) indexedColumns.add(column);
  const referenced = new Set(original.foreignKeys.map((key) => key.from));
  for (const table of schema.tables) {
    for (const key of table.foreignKeys) if (key.table.toLowerCase() === original.name.toLowerCase() && key.to) referenced.add(key.to);
  }

  const keptInOrder = kept.every((field, index) => index === 0 || before.fields.findIndex((f) => f.name === field.original) > before.fields.findIndex((f) => f.name === kept[index - 1].original));
  const keptUnchanged = kept.every((field) => sameField(field, originalOf.get(field.original!)!));
  const addedSimple = added.every((field) => !field.pk && !field.unique && !field.ai && (!field.nn || field.default.trim() !== ""));
  const addedAtEnd = fields.findIndex((field) => field.original === null) === -1 || fields.slice(fields.findIndex((field) => field.original === null)).every((field) => field.original === null);
  const droppedSimple = dropped.every((field) => !field.pk && !field.unique && !indexedColumns.has(field.name) && !referenced.has(field.name));
  const optionsSame = after.withoutRowid === before.withoutRowid && after.strict === before.strict;
  const constraintsSame =
    JSON.stringify(after.foreignKeys) === JSON.stringify(before.foreignKeys) &&
    JSON.stringify(after.uniques) === JSON.stringify(before.uniques) &&
    JSON.stringify(after.extra) === JSON.stringify(before.extra);

  if (keptInOrder && keptUnchanged && addedSimple && addedAtEnd && droppedSimple && optionsSame && constraintsSame) {
    const statements: string[] = [];
    let current = original.name;
    if (newName !== original.name) {
      statements.push(`ALTER TABLE ${quoteIdent(current)} RENAME TO ${quoteIdent(newName)};`);
      current = newName;
    }
    for (const field of renamedColumns) {
      statements.push(`ALTER TABLE ${quoteIdent(current)} RENAME COLUMN ${quoteIdent(field.original!)} TO ${quoteIdent(field.name.trim())};`);
    }
    for (const field of dropped) statements.push(`ALTER TABLE ${quoteIdent(current)} DROP COLUMN ${quoteIdent(field.name)};`);
    for (const field of added) {
      const line = createTableSql({ ...after, fields: [field], foreignKeys: [], uniques: [], extra: [] }).split("\n")[1].trim();
      statements.push(`ALTER TABLE ${quoteIdent(current)} ADD COLUMN ${line};`);
    }
    if (statements.length === 0) notes.push("Nothing changed.");
    return { sql: statements.join("\n"), rebuild: false, notes };
  }

  // The rebuild. Column renames carry through the copy and into the
  // foreign keys, indexes and triggers.
  const rename = new Map(renamedColumns.map((field) => [field.original!, field.name.trim()]));
  const droppedNames = new Set(dropped.map((field) => field.name));
  const foreignKeys = after.foreignKeys
    .filter((key) => key.columns.every((column) => !droppedNames.has(column)))
    .map((key) => ({ ...key, columns: key.columns.map((column) => rename.get(column) ?? column) }));
  const uniques = after.uniques.filter((unique) => unique.every((column) => !droppedNames.has(column))).map((unique) => unique.map((column) => rename.get(column) ?? column));
  const temporary = `sable_temp_${newName.replace(/\W/g, "_")}`;
  const statements: string[] = [];
  statements.push(createTableSql({ ...after, foreignKeys, uniques, fields }, temporary));
  const copied = kept;
  if (copied.length > 0) {
    statements.push(
      `INSERT INTO ${quoteIdent(temporary)} (${copied.map((field) => quoteIdent(field.name.trim())).join(", ")})\n  SELECT ${copied.map((field) => quoteIdent(field.original!)).join(", ")} FROM ${quoteIdent(original.name)};`,
    );
  }
  statements.push(`DROP TABLE ${quoteIdent(original.name)};`);
  statements.push("PRAGMA legacy_alter_table = 1;");
  statements.push(`ALTER TABLE ${quoteIdent(temporary)} RENAME TO ${quoteIdent(newName)};`);
  statements.push("PRAGMA legacy_alter_table = 0;");
  const related: (IndexInfo | TriggerInfo)[] = [
    ...schema.indexes.filter((index) => index.table === original.name && index.sql),
    ...schema.triggers.filter((trigger) => trigger.table === original.name && trigger.sql),
  ];
  for (const object of related) {
    let sql = object.sql!;
    const usesDropped = [...droppedNames].some((name) => mentions(sql, name));
    if (usesDropped) {
      notes.push(`The ${object.type} ${object.name} uses a removed column and is dropped.`);
      continue;
    }
    for (const [from, to] of rename) sql = renameIdent(sql, from, to);
    if (newName !== original.name) sql = renameIdent(sql, original.name, newName);
    statements.push(`${sql.trim().replace(/;$/, "")};`);
  }
  notes.push("The table is rebuilt (SQLite can't make these changes in place): a new table, the rows copied over, then its indexes and triggers again.");
  return { sql: statements.join("\n"), rebuild: true, notes };
}

export interface IndexDef {
  name: string;
  table: string;
  unique: boolean;
  columns: { name: string; desc: boolean }[];
  where: string;
}

export function createIndexSql(def: IndexDef): string {
  const columns = def.columns.map((column) => `${quoteIdent(column.name)}${column.desc ? " DESC" : " ASC"}`).join(", ");
  const where = def.where.trim() ? `\n  WHERE ${def.where.trim()}` : "";
  return `CREATE ${def.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(def.name.trim())} ON ${quoteIdent(def.table)} (${columns})${where};`;
}

/**
 * Statement ranges in a script (for Run Current Statement): split at
 * semicolons outside strings, comments and trigger bodies.
 */
export function statementRanges(sql: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  let index = 0;
  let inTrigger = false;
  let depth = 0;
  const words: string[] = [];
  const atWord = () => {
    const match = /^[A-Za-z_]+/.exec(sql.slice(index, index + 40));
    return match ? match[0].toUpperCase() : "";
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === close) {
          if (close !== "]" && sql[end + 1] === close) end += 2;
          else break;
        } else end++;
      }
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char) && (index === 0 || !/[\w$]/.test(sql[index - 1]))) {
      const word = atWord();
      if (words.length < 4) {
        words.push(word);
        if (words[0] === "CREATE" && (word === "TRIGGER" || (words.length === 3 && words[2] === "TRIGGER"))) inTrigger = true;
      }
      if (inTrigger && (word === "BEGIN" || word === "CASE")) depth++;
      if (inTrigger && word === "END") depth = Math.max(0, depth - 1);
      index += Math.max(word.length, 1);
      continue;
    }
    if (char === ";" && !(inTrigger && depth > 0)) {
      ranges.push({ start, end: index + 1 });
      start = index + 1;
      words.length = 0;
      inTrigger = false;
      depth = 0;
    }
    index++;
  }
  if (sql.slice(start).trim()) ranges.push({ start, end: sql.length });
  return ranges.filter((range) => sql.slice(range.start, range.end).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/;/g, "").trim());
}

/** The statement at an offset (or the one just before it). */
export function statementAt(sql: string, offset: number): { start: number; end: number } | null {
  const ranges = statementRanges(sql);
  if (ranges.length === 0) return null;
  const position = ranges.findIndex((range) => offset >= range.start && offset <= range.end);
  if (position >= 0) {
    // In the whitespace after a statement's `;`: that statement.
    if (position > 0 && !sql.slice(ranges[position].start, offset).trim()) return ranges[position - 1];
    return ranges[position];
  }
  return [...ranges].reverse().find((range) => range.end <= offset) ?? ranges[0];
}

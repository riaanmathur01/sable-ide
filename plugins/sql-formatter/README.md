# SQL Formatter

Lays out SQL queries so they're easy to read:

```sql
select u.id, u.name from users u left join orders o on o.user_id = u.id where u.active = true and o.total > 10 order by u.name
```

becomes

```sql
SELECT
  u.id,
  u.name
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.active = TRUE
  AND o.total > 10
ORDER BY u.name
```

## How to use

1. Open a `.sql` file.
2. Press ⇧⌥F (**Format Document**; Shift+Alt+F on Windows/Linux), or turn
   on format on save.
3. To format just part of a file (or SQL in another kind of file), select
   it, open the **command palette** (⇧⌘P, Ctrl+Shift+P on Windows/Linux)
   and run **SQL Formatter: Format SQL**. With nothing selected it formats
   the whole file.

## What it does

- Keywords are written in uppercase.
- Each clause starts a line: `SELECT`, `FROM`, `WHERE`, `GROUP BY`,
  `HAVING`, `ORDER BY`, `LIMIT`, the `JOIN`s, `UNION`, `INSERT INTO`,
  `VALUES`, `UPDATE`, `SET`, `DELETE FROM`.
- Items of `SELECT`, `SET` and `VALUES` go one per line, indented.
- `AND` and `OR` in `WHERE`, `HAVING` and `JOIN … ON` start indented
  lines (not the `AND` of `BETWEEN … AND`, or inside parentheses and
  `CASE`).
- Subqueries are indented inside their parentheses.
- Text in quotes (`'…'`, `"…"`, `` `…` ``, `$$…$$`) and comments is never
  changed.
- Other statements (`CREATE TABLE`, …) keep their layout; only their
  keywords are uppercased.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.3 or
newer.

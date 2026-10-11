# CSV Tools

Converts between CSV and JSON, and lines up CSV columns so a file is easy
to read.

| Command | What it does |
| ------- | ------------ |
| **CSV to JSON** | The header row becomes the keys of an array of objects. Numbers and `true`/`false` become JSON numbers and booleans; values like `007` stay strings. |
| **JSON to CSV** | An array of objects (or one object, or an array of arrays) becomes CSV, with every key that appears as a column. Nested values are written as JSON. |
| **Align CSV Columns** | Pads each column with spaces after its separator so the columns line up. |
| **Shrink CSV Columns (Remove Padding)** | Removes that padding again. |

## How to use

1. Select the CSV or JSON to convert, or select nothing to convert the
   whole file.
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run one of the **CSV Tools** commands (typing `csv` finds them).

The selection (or file) is replaced in one step: ⌘Z undoes it.

## Details

- The separator is detected: comma, semicolon or tab.
- Quoting follows RFC 4180: fields may contain the separator, quotes
  (written `""`) and line breaks inside double quotes. When writing CSV,
  a field is quoted only when it needs to be.
- Align and Shrink treat spaces around unquoted values as padding.
  Values that really start or end with a space are quoted, so nothing is
  lost.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.3 or
newer.

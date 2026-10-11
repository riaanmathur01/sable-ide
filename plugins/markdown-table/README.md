# Markdown Table

Tidies Markdown tables so they read well as plain text: pipes lined up,
cells padded, and each column aligned the way its `:---`, `:---:` or
`---:` marker says.

```markdown
|Name|Qty|Price|          | Name  | Qty | Price |
|:--|:-:|--:|        →     | :---- | :-: | ----: |
|Apple|3|1.5|             | Apple |  3  |   1.5 |
```

## How to use

1. Put the cursor anywhere in a table (or select text that includes one
   or more tables).
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Markdown Table: Format Table** (typing `table` finds it).

The other commands:

- **CSV to Markdown Table**: select comma-, semicolon- or tab-separated
  text (the first row is the header) and run it. Quoted fields are
  understood, `|` in a value is escaped, and line breaks become `<br>`.
- **Add Row Below**: adds an empty row under the cursor's row (under the
  header row's `---` line when the cursor is in the header) and puts the
  cursor in it.
- **Add Column After**: adds an empty column to the right of the cursor's
  column.

Every change is one step: ⌘Z undoes it.

## Details

- Escaped pipes (`\|`) stay inside their cell.
- Short rows are filled with empty cells; a table without the `---` line
  under its header gets one.
- An indented table (in a list, say) keeps its indentation.
- Tables in code blocks are left alone.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.6 or
newer.

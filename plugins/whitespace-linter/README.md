# Whitespace Linter

Marks whitespace mistakes in the open file, in the editor and the
Problems panel:

- **Trailing whitespace**: spaces or tabs at the end of a line
- **Indentation that mixes tabs and spaces** on the same line
- **No newline at the end of the file**

The marks are notes, not errors, and update as you type, when you open a
file and when you save. Files over 1 MB and binary files are skipped.

## How to use

1. Open a file. Whitespace problems get a subtle underline (the missing
   final newline a faint one on the last line); hover one to see what it
   is.
2. To fix them, open the **command palette**: ⇧⌘P (Ctrl+Shift+P on
   Windows/Linux).
3. Run **Whitespace Linter: Fix Whitespace** (typing `whitespace` finds
   it). It removes trailing whitespace from every line and adds the
   final newline, in one undo step (⌘Z).

Mixed indentation isn't fixed automatically, since only you know whether
the file should use tabs or spaces.

Two things aren't flagged: in Markdown, exactly two spaces at the end of
a line (that's a line break there), and a tab-indented block comment's
` * ` lines.

Permissions: `editor` (to read the file and mark it). Needs Sable 0.3.6
or newer.

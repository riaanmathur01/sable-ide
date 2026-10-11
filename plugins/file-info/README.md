# File Info

Shows the open file's size, line count and line endings in the status
bar: **12.4 KB · 340 lines · LF**.

## How to use

1. Open a file. Its details appear in the status bar and update as you
   type or switch files.
2. Hover over them for more detail:
   - the exact size in bytes
   - the longest line, and which line it is
   - the line endings: **LF** (macOS/Linux), **CRLF** (Windows), or
     **Mixed** when the file has both
   - the indentation, such as *Tabs* or *4 spaces* (a guess from how the
     lines are indented)

The size is the file's text as UTF-8, unsaved changes included, so it
can differ from the size on disk until you save.

Permissions: `editor` (to read the open file). Needs Sable 0.3.6 or newer.

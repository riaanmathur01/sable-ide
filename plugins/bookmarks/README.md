# Bookmarks

Marks lines you want to come back to, lets you jump between them in a
file, and lists every bookmark across your files.

## How to use

1. Put the cursor on a line and press ⌘⌥B (Ctrl+Alt+B on Windows/Linux),
   or run **Bookmarks: Toggle Bookmark** from the command palette: ⇧⌘P
   (Ctrl+Shift+P on Windows/Linux). Do it again on the same line to
   remove the bookmark.
2. The status bar shows how many bookmarks the open file has: **🔖 3**.
   Click it to jump to the next one.
3. Run **Bookmarks: Next Bookmark** or **Bookmarks: Previous Bookmark**
   to move between the file's bookmarks. After the last one it goes back
   to the first.
4. Run **Bookmarks: List Bookmarks** to see every bookmark in every
   file, as `src/app.js:42` with the line's text. Choose one to open the
   file with that line selected.
5. Run **Bookmarks: Clear Bookmarks in File** to remove all of the open
   file's bookmarks.

Bookmarks are kept between sessions. They're line numbers, so they don't
move when you edit the file: add a line above a bookmark and it now
points at the line before. Toggle it again on the right line to fix it.

Permissions: `editor` (to read the cursor's line and move it) and
`workspace:read` (to open bookmarked files and show their lines). Needs
Sable 0.3.6 or newer.

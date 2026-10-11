# Hash

Works out the SHA-1, SHA-256, SHA-384 or SHA-512 hash of the selection,
or of the whole file when nothing is selected, as lowercase hex. Text is
hashed as UTF-8, so the result matches `shasum`, `sha256sum` and most
online tools.

## How to use

To see every hash and copy one:

1. **Select** the text to hash (or select nothing to hash the whole
   file).
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Hash: Copy Hash…** (typing `hash` finds it).
4. The list shows each algorithm with its hash. Pick one and press
   Enter: it's copied to the clipboard.

To turn the text into its hash:

1. **Select** the text.
2. In the command palette, run **Hash: SHA-256 (Replace Selection)**
   (or SHA-1, SHA-384, SHA-512).
3. The selection is replaced by its hash in one step: ⌘Z undoes it.
   With nothing selected, the whole file's hash is inserted at the
   cursor instead.

Note: the file is hashed as it is in the editor, unsaved changes
included, with the line endings it has there.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.6 or
newer.

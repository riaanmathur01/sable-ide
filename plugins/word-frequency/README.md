# Word Frequency

Lists the 50 words used most often in the open file or the selection,
with how many times each appears.

## How to use

1. Open a file. To count only part of it, select that part.
2. Open the command palette: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Word Frequency: Show Word Frequency**.
4. Read the list, most frequent first, such as **parser 14×**. Type to
   filter it.
5. Choose a word to copy it to the clipboard.

Words are counted ignoring case (`The` and `the` are the same word).
Numbers and common English words such as *the*, *and* and *of* are left
out.

Permissions: `editor` (to read the open file). Needs Sable 0.3.6 or
newer.

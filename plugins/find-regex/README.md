# Regex Search

Searches the open file with a regular expression and lists every match.
Choose one to jump to it with the match selected.

## How to use

1. Open the command palette: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
2. Run **Regex Search: Find with Regex…**.
3. Type a pattern and press Enter:
   - a plain pattern, such as `\bget\w+` (case-sensitive), or
   - `/pattern/flags` to add flags, such as `/todo|fixme/i` to ignore
     case, or `/^import/m` so `^` and `$` match at each line.
4. The matches are listed as `line: match`, with the whole line under
   each. Type to filter them.
5. Choose a match to select it in the editor.

The box remembers your last pattern. If the pattern isn't valid, the
status bar says why. A match can span lines (`/end\n\s*start/`). The
list shows the first 1,000 matches.

Permissions: `editor` (to read the open file and select the match).
Needs Sable 0.3.6 or newer.

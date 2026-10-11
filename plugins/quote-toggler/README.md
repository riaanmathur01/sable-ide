# Quote & Bracket Toggler

Switches a string between single quotes, double quotes and backticks, and
wraps the selection in brackets, quotes or Markdown emphasis.

## How to use

### Toggle quotes

1. Put the cursor anywhere in a string, such as `'hello'`.
2. Press ⌘⌥' (Ctrl+Alt+' on Windows/Linux), or run **Quote & Bracket
   Toggler: Toggle Quotes** from the command palette: ⇧⌘P
   (Ctrl+Shift+P on Windows/Linux).
3. Each press moves to the next style: `'hello'` → `"hello"` →
   `` `hello` `` → `'hello'`.

Quotes inside the string are escaped and unescaped for you:
`'it\'s "fine"'` becomes `"it's \"fine\""`. Going to backticks also
escapes `${`, so the text doesn't turn into a template placeholder.

A template literal that uses `${…}` or spans several lines can't become
a plain string, so it's left as it is. To toggle a multi-line string,
select all of it, quotes included, first.

### Wrap the selection

1. Select some text (or select nothing to insert an empty pair).
2. Run **Quote & Bracket Toggler: Wrap Selection…** from the command
   palette.
3. Pick a wrapper: `( )`, `[ ]`, `{ }`, `" "`, `' '`, `` ` ` ``, `< >`,
   `**bold**` or `_italic_`. Each one shows a preview.

The text stays selected afterwards, so you can wrap it again. With
nothing selected, the cursor goes between the pair.

Permissions: `editor` (to read and change the open file). Needs Sable
0.3.6 or newer.

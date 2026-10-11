# JSON Tools

Formats, minifies, sorts and checks JSON: the selection, or the whole
file when nothing is selected. When the JSON has a mistake, it's
underlined where it is (and listed in the Problems panel) with what's
wrong, such as a trailing comma or a missing quote.

## How to use

1. Open a JSON file, or **select** some JSON inside another file (a
   string in a test, a response pasted into a note).
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Type `json` and run one of:
   - **JSON Tools: Format JSON**: indents with 2 spaces
   - **JSON Tools: Minify JSON**: all on one line, no spaces
   - **JSON Tools: Sort Keys**: sorts the keys of every object, however
     deeply nested, A → Z. Arrays keep their order. Minified JSON stays
     minified; anything else comes out formatted.
   - **JSON Tools: Validate JSON**: checks it without changing anything
4. If the JSON is invalid, nothing changes: the error is marked at its
   line and column and described in the status bar. Fix it and run the
   command again; the mark goes away once the JSON is valid.

Every change is one undo step (⌘Z). A whole file keeps its final
newline.

Note: numbers too big for JavaScript (beyond 2^53) lose precision when
formatted, and comments (JSONC) aren't supported.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.3 or
newer.

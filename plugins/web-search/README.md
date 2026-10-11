# Search the Web

Searches the web for the selected text, or the word at the cursor, and
opens the results in your browser.

## How to use

1. Select some text, such as an error message, or put the cursor on a
   word, such as a function name.
2. Open the command palette: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Search the Web: Search the Web…** and pick a site, or run one
   site's command directly:

   | Command | Searches |
   | ------- | -------- |
   | **Search Google** | Google |
   | **Search DuckDuckGo** | DuckDuckGo |
   | **Search Stack Overflow** | Stack Overflow questions |
   | **Search MDN** | MDN Web Docs (JavaScript, CSS, HTML) |
   | **Search docs.rs** | Rust crates |
   | **Search PyPI** | Python packages |
   | **Search npm** | JavaScript packages |

4. The results open in your browser.

A selection over several lines is searched as one line. With nothing
selected and no word at the cursor, Sable asks what to search for.

Permissions: `editor` (to read the selection). Needs Sable 0.3.6 or
newer.

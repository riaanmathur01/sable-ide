# Markdown Lint

Checks Markdown files as you write and marks problems with a squiggle and
an entry in the Problems panel (as warnings):

| Problem | Example |
| ------- | ------- |
| A heading level is skipped | `# Title` followed by `### Detail` |
| Trailing spaces | `text   ` (exactly two spaces after text are allowed: they're a line break) |
| More than one blank line in a row | |
| An image without alt text | `![](diagram.png)` |
| Different bullets in one list | `- one` then `* two` |
| No blank line around a heading | text right above or below `## Heading` |
| No blank line around a code block | text right above ```` ``` ```` or below its closing fence |

Text inside fenced code blocks and YAML front matter isn't checked.

## How to use

1. Open a Markdown file. Problems are marked straight away, and the marks
   update as you type, when you save, and when you switch files.
2. Open the Problems panel to see the list, or hover a squiggle.
3. To check on demand, open the **command palette** (⇧⌘P, Ctrl+Shift+P
   on Windows/Linux) and run **Markdown Lint: Lint This File**.
4. **Markdown Lint: Clear Markdown Problems** removes the marks until the
   file next changes.

When a file has no problems, its marks are cleared.

Permissions: `editor` (to read the file and show problems). Needs Sable 0.3.6
or newer.

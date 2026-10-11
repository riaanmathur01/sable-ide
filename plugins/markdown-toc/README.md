# Markdown TOC

Builds a table of contents for a Markdown file from its headings: a
nested list of links that work on GitHub, kept between two markers so it
can be updated later.

```markdown
<!-- toc -->

- [Getting Started](#getting-started)
  - [Install](#install)
- [What's New?](#whats-new)

<!-- tocstop -->
```

## How to use

1. Open a Markdown file and put the cursor where the table of contents
   should go (usually under the title).
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Markdown TOC: Insert/Update Table of Contents** (typing `toc`
   finds it).
4. After you change the headings, run the same command again to update
   it, or just save: a file that already has the markers updates itself
   on save (save once more to write the update to disk).

Each insert or update is one step: ⌘Z undoes it.

## Details

- Links use GitHub's anchors: lowercase, punctuation removed, spaces
  turned into `-`. Repeated headings get `-1`, `-2`, … as on GitHub.
- The first heading is left out when it's an H1 (the document's title).
- Headings in code blocks (```` ``` ```` or `~~~`) and YAML front matter are
  ignored. Both `# Heading` and underlined (`===`, `---`) headings count.
- Formatting in headings (`**bold**`, `` `code` ``, links) is dropped from
  the list's text.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.6 or
newer.

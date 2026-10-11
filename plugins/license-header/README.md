# License Header

Adds a short license header to the top of a file, in the file's comment
style, and creates a `LICENSE` file for a project.

```js
// Copyright (c) 2026 Jane Doe
// SPDX-License-Identifier: MIT
```

Licenses: MIT, Apache-2.0, BSD-3-Clause, GPL-3.0-or-later and MPL-2.0.

## How to use

1. Open the file that should get a header.
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **License Header: Insert License Header…** (typing `license`
   finds it).
4. Pick the license. The one you used last is at the top.
5. The first time, type the copyright holder (your name or your
   organisation's) and press Enter. It's remembered for next time.

The header goes at the top of the file, after a `#!` line, an encoding
comment, `<?xml …?>`, `<?php` or `<!DOCTYPE …>`, with the current year. A
file that already has an `SPDX-License-Identifier` near the top is left
alone. ⌘Z undoes the insert.

Comment styles: `//` (JavaScript, TypeScript, Java, C, C++, C#, Go, Rust,
Swift, Kotlin, PHP, …), `#` (Python, shell, Ruby, YAML, TOML, Dockerfile,
…), `/* */` (CSS), `<!-- -->` (HTML, XML, Markdown, Vue), `--` (SQL, Lua),
and a few more.

## Creating a LICENSE file

1. Open a folder.
2. Run **License Header: Create LICENSE File…** and pick the license.
3. Sable writes `LICENSE` at the top of the folder and opens it. If a
   `LICENSE` (or `LICENSE.md`/`LICENSE.txt`) is already there, it asks
   first.

MIT and BSD-3-Clause are written in full. For Apache-2.0, GPL-3.0-or-later
and MPL-2.0 the file has the license's official notice and a link to its
full text; paste the full text from that link if you distribute your
project.

To change the remembered name, run **License Header: Change Copyright
Holder…**.

Permissions: `editor` (to add the header), `workspace:read` (to check for
an existing LICENSE) and `workspace:write` (to write it). Needs Sable 0.3.6
or newer.

# Encode / Decode

Encodes and decodes text in the formats you meet every day: Base64, URL
encoding, HTML entities and JSON string escapes. It works on the
selection, or the whole file when nothing is selected.

## How to use

1. **Select** the text to convert (or select nothing to convert the
   whole file).
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Type `encode`, `decode`, `escape` or the format's name and run one of
   the commands below.
4. The text is replaced in one step: ⌘Z undoes it. If it can't be
   decoded (say, it isn't Base64), nothing changes and the status bar
   says why.

## The commands

| Command | `Café & "más"` becomes |
| ------- | ---------------------- |
| **Base64 Encode** | `Q2Fmw6kgJiAibcOhcyI=` |
| **URL Encode** | `Caf%C3%A9%20%26%20%22m%C3%A1s%22` |
| **HTML Escape** | `Café &amp; &quot;más&quot;` |
| **JSON String Escape** | `Café & \"más\"` |

Each has a **Decode** / **Unescape** command that turns it back:

- **Base64 Decode** reads standard and URL-safe Base64, with or without
  `=` padding, ignoring line breaks. Text is UTF-8, so accents and emoji
  survive the round trip.
- **URL Decode** decodes a URL component (`%20`, `%C3%A9`, …).
- **HTML Unescape** knows the common named entities (`&amp;`, `&nbsp;`,
  `&copy;`, `&mdash;`, `&hellip;`, …) and any numeric one (`&#169;`,
  `&#xA9;`). Unknown names are left as they are.
- **JSON String Unescape** turns `\n`, `\t`, `\"`, `é` and the rest
  back into characters. If you selected the surrounding quotes too,
  they're removed.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.3 or
newer.

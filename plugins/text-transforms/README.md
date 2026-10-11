# Text Transforms

Quick changes to text: reverse it, ROT13 it, turn it into a URL slug,
tidy up whitespace, join or number lines, or wrap long lines. Each works
on the selection, or the whole file when nothing is selected.

## How to use

1. **Select** the text (or select nothing to change the whole file).
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Type part of a command's name (for example `slug` or `wrap`) and run
   it.
4. The text is replaced in one step: ⌘Z undoes it.

## The commands

| Command | What it does |
| ------- | ------------ |
| **Reverse Lines** | Last line first |
| **Reverse Text** | `Hello` → `olleH` (emoji and accented letters stay whole) |
| **ROT13** | `Hello` → `Uryyb`; run it again to get the text back |
| **Slugify** | Each line: `Héllo, World!` → `hello-world` |
| **Trim Trailing Whitespace** | Removes spaces and tabs at the ends of lines |
| **Remove Blank Lines** | Removes empty and whitespace-only lines |
| **Join Lines** | All the lines on one line, separated by a space (blank lines dropped) |
| **Collapse Spaces** | Runs of spaces and tabs inside a line become one space; indentation stays |
| **Number Lines** | `1. `, `2. `, … in front of each line, aligned when there are 10 or more |
| **Wrap Lines at 80** | Breaks lines longer than 80 characters between words, keeping their indentation |

A trailing newline at the end of the text stays where it is.

Permissions: `editor` (to read and change the file). Needs Sable 0.3.3 or
newer.

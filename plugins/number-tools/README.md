# Number Tools

Works with numbers in your code: convert them between decimal, hex,
binary and octal, bump them up or down with a shortcut, add thousands
separators, and see any number literal in every base by hovering it.

## Seeing a number in every base (hover)

1. Rest the pointer on a number literal such as `255`, `0xff`,
   `0b1010` or `0o17`.
2. A tooltip shows it in decimal, hex, binary and octal.

Single digits (`0`–`9`) don't get a tooltip, and digits inside names
(`h1`) or decimals (`1.5`) aren't numbers to it.

## Converting a number

1. **Select** the number, or just put the cursor on it.
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Number Tools: Convert Number…** (typing `convert` finds it).
4. Pick decimal, hex, binary or octal; each shows the result. Press
   Enter to replace the number.

It reads `255`, `-255`, `0xff`, `0b1010`, `0o17`, `1_000_000` and
`1,000,000`, and big numbers stay exact.

## Incrementing and decrementing

1. Put the cursor on (or just before) a number, or **select** text with
   several numbers in it.
2. Press **⌃⌥=** to add 1 or **⌃⌥-** to subtract 1 (**Ctrl+Alt+=** /
   **Ctrl+Alt+-** on Windows/Linux), or run **Number Tools: Increment** /
   **Decrement**.
3. With a selection, every whole number in it changes and the selection
   stays, so you can press again. Without one, the number at the cursor
   (or the next one on the line) changes.

Leading zeros keep their width (`007` → `008`). A minus after a name or
bracket counts as subtraction, so in `x-1` only the `1` changes.

## Thousands separators

Select text and run **Number Tools: Add Thousands Separators**:
`1234567.89` becomes `1,234,567.89`. Without a selection it changes the
number at the cursor.

Every change is one undo step (⌘Z).

Permissions: `editor` (to read and change the file). Needs Sable 0.3.6
or newer.

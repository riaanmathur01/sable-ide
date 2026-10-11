# Color Tools

Works with colors written in CSS notation, in any file: stylesheets,
JSX, config, Markdown. Hover a color to see it in the other formats,
convert it from one format to another, or make it lighter or darker.

It reads `#rgb`, `#rrggbb` and `#rrggbbaa` hex colors, `rgb()` /
`rgba()` and `hsl()` / `hsla()`, with commas or the modern space syntax
(`rgb(255 0 0 / 50%)`).

## Seeing a color in other formats (hover)

1. Rest the pointer on a color, such as `#3366cc`.
2. A tooltip shows it as hex, `rgb()` and `hsl()`:
   `#3366cc`, `rgb(51, 102, 204)`, `hsl(220, 60%, 50%)`.

## Converting a color

1. Put the cursor on a color, or **select** text with one or more colors
   in it.
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Color Tools: Convert Color…** (typing `color` finds it).
4. Pick Hex, RGB or HSL; each shows the color converted. Press Enter.
   With a selection, every color in it is converted.

A color with transparency keeps it: `#ff000080` becomes
`rgba(255, 0, 0, 0.502)` and `hsla(0, 100%, 50%, 0.502)`.

## Lighter and darker

1. Put the cursor on a color, or select some.
2. Run **Color Tools: Lighten 10%** or **Color Tools: Darken 10%** from
   the command palette.
3. The lightness goes up or down by 10 points (like Sass's `lighten()`
   and `darken()`), and the color stays in the format it was written in.
   A selection stays selected, so you can run it again.

Every change is one undo step (⌘Z).

Permissions: `editor` (to read and change the file). Needs Sable 0.3.6
or newer.

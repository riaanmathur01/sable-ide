// @ts-check
/** @typedef {import("../sable").Sable} Sable */
/** A color: r, g, b from 0 to 255 (not rounded), alpha from 0 to 1. */
/** @typedef {{ r: number, g: number, b: number, a: number }} Color */

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** "50%" → 0.5 × `scale`; "128" → 128. NaN if it isn't a number. */
function amount(text, scale) {
  const match = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/);
  if (!match) return NaN;
  return match[2] ? (Number(match[1]) / 100) * scale : Number(match[1]);
}

/** A hue in degrees: "120", "120deg", "0.5turn", "3.14rad". */
function hue(text) {
  const match = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?$/i);
  if (!match) return NaN;
  const n = Number(match[1]);
  const unit = (match[2] ?? "deg").toLowerCase();
  const degrees = unit === "turn" ? n * 360 : unit === "rad" ? (n * 180) / Math.PI : unit === "grad" ? n * 0.9 : n;
  return ((degrees % 360) + 360) % 360;
}

/** h in degrees, s and l from 0 to 1 → rgb. */
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

/** rgb → h in degrees, s and l from 0 to 1. */
function rgbToHsl({ r, g, b }) {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/**
 * CSS color text → a Color, or null. Reads #rgb, #rgba, #rrggbb,
 * #rrggbbaa, rgb()/rgba() and hsl()/hsla(), with commas or spaces and an
 * optional "/ alpha".
 * @returns {Color | null}
 */
function parseColor(text) {
  const value = text.trim();
  const hex = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const digits = hex[1].length <= 4 ? hex[1].replace(/./g, "$&$&") : hex[1];
    const byte = (i) => parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    return { r: byte(0), g: byte(1), b: byte(2), a: digits.length === 8 ? byte(3) / 255 : 1 };
  }
  const fn = value.match(/^(rgba?|hsla?)\(\s*([^()]*?)\s*\)$/i);
  if (!fn) return null;
  const args = fn[2].split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (args.length !== 3 && args.length !== 4) return null;
  const alpha = args.length === 4 ? amount(args[3], 1) : 1;
  if (Number.isNaN(alpha)) return null;
  const a = clamp(alpha, 0, 1);
  if (fn[1].toLowerCase().startsWith("rgb")) {
    const [r, g, b] = args.slice(0, 3).map((arg) => amount(arg, 255));
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a };
  }
  const h = hue(args[0]);
  const [s, l] = args.slice(1, 3).map((arg) => amount(arg.endsWith("%") ? arg : `${arg}%`, 1));
  if ([h, s, l].some(Number.isNaN)) return null;
  return { ...hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1)), a };
}

const byte = (n) => Math.round(clamp(n, 0, 255));
const round = (n, places) => Number(n.toFixed(places));

/** @type {Record<string, [string, (color: Color) => string]>} */
const FORMATS = {
  hex: [
    "Hex",
    ({ r, g, b, a }) => {
      const parts = [r, g, b, ...(a < 1 ? [a * 255] : [])];
      return `#${parts.map((n) => byte(n).toString(16).padStart(2, "0")).join("")}`;
    },
  ],
  rgb: [
    "RGB",
    ({ r, g, b, a }) => (a < 1 ? `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${round(a, 3)})` : `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`),
  ],
  hsl: [
    "HSL",
    (color) => {
      const { h, s, l } = rgbToHsl(color);
      const body = `${round(h, 1)}, ${round(s * 100, 1)}%, ${round(l * 100, 1)}%`;
      return color.a < 1 ? `hsla(${body}, ${round(color.a, 3)})` : `hsl(${body})`;
    },
  ],
};

/** Which format some color text is written in. */
const formatOf = (text) => (text.startsWith("#") ? "hex" : /^rgb/i.test(text) ? "rgb" : "hsl");

/** `color` with its HSL lightness moved by `delta` (0.1 = 10 points), as Sass's lighten() does. */
function adjustLightness(color, delta) {
  const { h, s, l } = rgbToHsl(color);
  return { ...hslToRgb(h, s, clamp(l + delta, 0, 1)), a: color.a };
}

/** Colors written in text: #rgb, #rrggbb, #rrggbbaa (not after & or a
 *  word character, so &#123; and ids aren't colors), rgb(), hsl(). */
const COLOR = /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])|(?<![\w-])(?:rgba?|hsla?)\([^()]*\)/gi;

/** The colors in `text`, as { start, end, text, color } (0-based). */
function findColors(text) {
  const out = [];
  for (const match of text.matchAll(COLOR)) {
    const color = parseColor(match[0]);
    const start = match.index ?? 0;
    if (color) out.push({ start, end: start + match[0].length, text: match[0], color });
  }
  return out;
}

/** `text` with every color replaced by `change(color, its text)`. */
function replaceColors(text, change) {
  let out = "";
  let last = 0;
  for (const found of findColors(text)) {
    out += text.slice(last, found.start) + change(found.color, found.text);
    last = found.end;
  }
  return out + text.slice(last);
}

/** The position after inserting `text` at `origin`. */
function endOf(text, origin) {
  const lines = text.split("\n");
  const last = lines[lines.length - 1].length;
  return { line: origin.line + lines.length - 1, column: lines.length === 1 ? origin.column + last : last + 1 };
}

/** @param {Sable} sable */
export function activate(sable) {
  sable.languages.registerHover("*", ({ line, column, lineText }) => {
    const found = findColors(lineText).find((c) => c.start <= column - 1 && column - 1 < c.end);
    if (!found) return null;
    const rows = Object.values(FORMATS).map(([name, format]) => `- ${name}: \`${format(found.color)}\``);
    return {
      contents: [`**Color** \`${found.text}\``, "", ...rows].join("\n"),
      range: { start: { line, column: found.start + 1 }, end: { line, column: found.end + 1 } },
    };
  });

  /**
   * The colors to work on: every one in the selection, else the one at the
   * cursor. `apply(change)` rewrites them in one undo step; a selection
   * stays selected so a command can be repeated.
   */
  const target = async () => {
    const editor = await sable.editor.active();
    if (!editor?.selection) {
      await sable.window.showError("Open a file first");
      return null;
    }
    const { selection } = editor;
    if (selection.text) {
      const colors = findColors(selection.text);
      if (!colors.length) {
        await sable.window.showError("No colors in the selection (hex, rgb() or hsl())");
        return null;
      }
      return {
        first: colors[0],
        /** @param {(color: Color, text: string) => string} change */
        apply: async (change) => {
          const result = replaceColors(selection.text, change);
          await sable.editor.applyEdits([{ range: { start: selection.start, end: selection.end }, text: result }]);
          await sable.editor.setSelection({ start: selection.start, end: endOf(result, selection.start) });
        },
      };
    }
    const { line, column } = selection.start;
    const lineText = editor.text.split("\n")[line - 1] ?? "";
    const found = findColors(lineText).find((c) => c.start <= column - 1 && column - 1 <= c.end);
    if (!found) {
      await sable.window.showError("Put the cursor on a color (hex, rgb() or hsl()), or select some");
      return null;
    }
    return {
      first: found,
      /** @param {(color: Color, text: string) => string} change */
      apply: (change) =>
        sable.editor.applyEdits([
          { range: { start: { line, column: found.start + 1 }, end: { line, column: found.end + 1 } }, text: change(found.color, found.text) },
        ]),
    };
  };

  sable.commands.register("convert", "Convert Color…", async () => {
    const colors = await target();
    if (!colors) return;
    const choice = await sable.window.showQuickPick(
      Object.entries(FORMATS).map(([id, [label, format]]) => ({ label, description: format(colors.first.color), id })),
      { placeholder: `Convert ${colors.first.text} to…` },
    );
    if (choice) await colors.apply((color) => FORMATS[choice.id][1](color));
  });

  // Lighter or darker, written in the same format as before.
  for (const [id, title, delta] of /** @type {const} */ ([["lighten", "Lighten 10%", 0.1], ["darken", "Darken 10%", -0.1]])) {
    sable.commands.register(id, title, async () => {
      const colors = await target();
      if (colors) await colors.apply((color, text) => FORMATS[formatOf(text)][1](adjustLightness(color, delta)));
    });
  }
}

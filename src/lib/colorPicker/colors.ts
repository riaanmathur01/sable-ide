/**
 * Colors for the color picker: parsing what's written in code (hex, CSS
 * functions, names), converting between models, and writing a color in
 * the formats people need (CSS, design tools, and platform code).
 */

/** sRGB, 0–255 per channel, alpha 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Hue 0–360, saturation and value 0–1 (the picker's square). */
export interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, places = 0) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const hex2 = (value: number) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");

// --- Conversions --------------------------------------------------------------------

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255, a };
}

export function rgbToHsv({ r, g, b, a }: Rgba, previousHue = 0): Hsva {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const delta = max - min;
  let h = previousHue;
  if (delta > 0) {
    if (max === rr) h = 60 * (((gg - bb) / delta) % 6);
    else if (max === gg) h = 60 * ((bb - rr) / delta + 2);
    else h = 60 * ((rr - gg) / delta + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : delta / max, v: max, a };
}

function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rr) h = 60 * (((gg - bb) / delta) % 6);
  else if (max === gg) h = 60 * ((bb - rr) / delta + 2);
  else h = 60 * ((rr - gg) / delta + 4);
  return { h: (h + 360) % 360, s, l };
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgba {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
}

function hwbToRgb(h: number, w: number, bl: number, a: number): Rgba {
  if (w + bl >= 1) {
    const gray = (w / (w + bl)) * 255;
    return { r: gray, g: gray, b: gray, a };
  }
  const { r, g, b } = hslToRgb(h, 1, 0.5, a);
  const scale = (value: number) => (value / 255) * (1 - w - bl) * 255 + w * 255;
  return { r: scale(r), g: scale(g), b: scale(b), a };
}

/** sRGB ↔ OKLab/OKLCH (Björn Ottosson's). */
const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function rgbToOklch({ r, g, b }: Rgba): { l: number; c: number; h: number } {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.sqrt(A * A + B * B);
  return { l: L, c: C, h: C < 0.0001 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToRgb(L: number, C: number, h: number, a: number): Rgba {
  const A = C * Math.cos((h * Math.PI) / 180);
  const B = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: clamp(fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), 0, 255),
    g: clamp(fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), 0, 255),
    b: clamp(fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), 0, 255),
    a,
  };
}

// --- Parsing ---------------------------------------------------------------------------

/** #rgb, #rgba, #rrggbb, #rrggbbaa (the # optional). */
export function parseHex(text: string): Rgba | null {
  const hex = text.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
  const channel = (index: number) => parseInt(full.slice(index * 2, index * 2 + 2), 16);
  return { r: channel(0), g: channel(1), b: channel(2), a: full.length === 8 ? channel(3) / 255 : 1 };
}

const number = (text: string, scale: number) => {
  const value = text.trim();
  if (value === "none") return 0;
  return value.endsWith("%") ? (parseFloat(value) / 100) * scale : parseFloat(value);
};
const angle = (text: string) => {
  const value = text.trim();
  if (value.endsWith("turn")) return parseFloat(value) * 360;
  if (value.endsWith("rad")) return (parseFloat(value) * 180) / Math.PI;
  return parseFloat(value);
};

/** A color as CSS writes it: hex, rgb()/rgba(), hsl()/hsla(), hwb(),
 *  oklch() or a named color. */
export function parseColor(text: string): Rgba | null {
  const value = text.trim().toLowerCase();
  if (value.startsWith("#")) return parseHex(value);
  if (NAMED[value]) return parseHex(NAMED[value]);
  const call = /^(rgba?|hsla?|hwb|oklch)\(\s*([^)]*)\)$/.exec(value);
  if (!call) return null;
  const [main, alphaPart] = call[2].split("/");
  const parts = main.split(/[\s,]+/).filter(Boolean);
  let alpha = alphaPart !== undefined ? number(alphaPart, 1) : 1;
  if (parts.length === 4 && alphaPart === undefined) alpha = number(parts.pop()!, 1);
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(parseFloat(part)) && part !== "none")) return null;
  const color = (() => {
    switch (call[1]) {
      case "rgb":
      case "rgba":
        return { r: number(parts[0], 255), g: number(parts[1], 255), b: number(parts[2], 255), a: alpha };
      case "hsl":
      case "hsla":
        return hslToRgb(angle(parts[0]), number(parts[1], 1) / (parts[1].endsWith("%") ? 1 : 100), number(parts[2], 1) / (parts[2].endsWith("%") ? 1 : 100), alpha);
      case "hwb":
        return hwbToRgb(angle(parts[0]), number(parts[1], 1) / (parts[1].endsWith("%") ? 1 : 100), number(parts[2], 1) / (parts[2].endsWith("%") ? 1 : 100), alpha);
      default:
        return oklchToRgb(number(parts[0], 1), number(parts[1], 0.4), angle(parts[2]), alpha);
    }
  })();
  return { r: clamp(color.r, 0, 255), g: clamp(color.g, 0, 255), b: clamp(color.b, 0, 255), a: clamp(color.a, 0, 1) };
}

// --- Formats --------------------------------------------------------------------------------

export function toHex({ r, g, b, a }: Rgba): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a < 1 ? `${base}${hex2(a * 255)}` : base;
}

/** One way to write a color. */
export interface ColorFormat {
  id: string;
  label: string;
  value: string;
}

/** The color in every format worth offering. */
export function formatsFor(color: Rgba): ColorFormat[] {
  const { r, g, b, a } = color;
  const [R, G, B] = [r, g, b].map((channel) => Math.round(channel));
  const A = round(a, 2);
  const alpha = a < 1;
  const hsl = rgbToHsl(color);
  const hsv = rgbToHsv(color);
  const ok = rgbToOklch(color);
  const white = Math.min(r, g, b) / 255;
  const black = 1 - Math.max(r, g, b) / 255;
  const key = 1 - Math.max(r, g, b) / 255;
  const cmyk = key >= 1 ? [0, 0, 0, 100] : [r, g, b].map((channel) => round(((1 - channel / 255 - key) / (1 - key)) * 100)).concat(round(key * 100));
  const float = (value: number) => (round(value / 255, 3)).toString();
  const argb = `${hex2(a * 255)}${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
  const name = nameOf(color);
  const formats: ColorFormat[] = [
    { id: "hex", label: "HEX", value: toHex(color) },
    { id: "rgb", label: "RGB", value: alpha ? `rgb(${R} ${G} ${B} / ${A})` : `rgb(${R}, ${G}, ${B})` },
    { id: "rgba", label: "RGBA", value: `rgba(${R}, ${G}, ${B}, ${A})` },
    {
      id: "hsl",
      label: "HSL",
      value: alpha
        ? `hsl(${round(hsl.h)} ${round(hsl.s * 100)}% ${round(hsl.l * 100)}% / ${A})`
        : `hsl(${round(hsl.h)}, ${round(hsl.s * 100)}%, ${round(hsl.l * 100)}%)`,
    },
    { id: "hsv", label: "HSV / HSB", value: `${round(hsv.h)}°, ${round(hsv.s * 100)}%, ${round(hsv.v * 100)}%` },
    { id: "hwb", label: "HWB", value: `hwb(${round(hsl.h)} ${round(white * 100)}% ${round(black * 100)}%${alpha ? ` / ${A}` : ""})` },
    { id: "oklch", label: "OKLCH", value: `oklch(${round(ok.l * 100, 1)}% ${round(ok.c, 3)} ${round(ok.h, 1)}${alpha ? ` / ${A}` : ""})` },
    { id: "cmyk", label: "CMYK", value: `${cmyk.map((value) => `${value}%`).join(", ")}` },
    { id: "rgb-float", label: "RGB 0–1", value: `${float(r)}, ${float(g)}, ${float(b)}${alpha ? `, ${A}` : ""}` },
    { id: "int", label: "Integer", value: `0x${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase().replace("0X", "0x") },
    { id: "swiftui", label: "SwiftUI", value: `Color(red: ${float(r)}, green: ${float(g)}, blue: ${float(b)}${alpha ? `, opacity: ${A}` : ""})` },
    { id: "uikit", label: "UIKit", value: `UIColor(red: ${float(r)}, green: ${float(g)}, blue: ${float(b)}, alpha: ${A})` },
    { id: "android", label: "Android / Kotlin", value: `Color(0x${argb})` },
    { id: "flutter", label: "Flutter", value: `Color(0x${argb})` },
    { id: "unity", label: "Unity", value: `new Color(${float(r)}f, ${float(g)}f, ${float(b)}f, ${A}f)` },
    { id: "dotnet", label: ".NET", value: `Color.FromArgb(${Math.round(a * 255)}, ${R}, ${G}, ${B})` },
  ];
  if (name) formats.splice(3, 0, { id: "name", label: "CSS name", value: name });
  return formats;
}

/** The CSS name of exactly this color, if it has one. */
function nameOf(color: Rgba): string | null {
  if (color.a < 1) return null;
  const hex = toHex(color);
  return Object.entries(NAMED).find(([, value]) => value === hex)?.[0] ?? null;
}

/** Relative luminance (for picking readable text on a swatch). */
export function isLight({ r, g, b }: Rgba): boolean {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b) > 0.4;
}

/** CSS named colors. */
export const NAMED: Record<string, string> = {
  aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aqua: "#00ffff", aquamarine: "#7fffd4", azure: "#f0ffff", beige: "#f5f5dc",
  bisque: "#ffe4c4", black: "#000000", blanchedalmond: "#ffebcd", blue: "#0000ff", blueviolet: "#8a2be2", brown: "#a52a2a",
  burlywood: "#deb887", cadetblue: "#5f9ea0", chartreuse: "#7fff00", chocolate: "#d2691e", coral: "#ff7f50",
  cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c", cyan: "#00ffff", darkblue: "#00008b", darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b", darkgray: "#a9a9a9", darkgreen: "#006400", darkkhaki: "#bdb76b", darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f", darkorange: "#ff8c00", darkorchid: "#9932cc", darkred: "#8b0000", darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f", darkslateblue: "#483d8b", darkslategray: "#2f4f4f", darkturquoise: "#00ced1", darkviolet: "#9400d3",
  deeppink: "#ff1493", deepskyblue: "#00bfff", dimgray: "#696969", dodgerblue: "#1e90ff", firebrick: "#b22222",
  floralwhite: "#fffaf0", forestgreen: "#228b22", fuchsia: "#ff00ff", gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff", gold: "#ffd700",
  goldenrod: "#daa520", gray: "#808080", green: "#008000", greenyellow: "#adff2f", honeydew: "#f0fff0", hotpink: "#ff69b4",
  indianred: "#cd5c5c", indigo: "#4b0082", ivory: "#fffff0", khaki: "#f0e68c", lavender: "#e6e6fa", lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00", lemonchiffon: "#fffacd", lightblue: "#add8e6", lightcoral: "#f08080", lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2", lightgray: "#d3d3d3", lightgreen: "#90ee90", lightpink: "#ffb6c1", lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa", lightskyblue: "#87cefa", lightslategray: "#778899", lightsteelblue: "#b0c4de", lightyellow: "#ffffe0",
  lime: "#00ff00", limegreen: "#32cd32", linen: "#faf0e6", magenta: "#ff00ff", maroon: "#800000", mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd", mediumorchid: "#ba55d3", mediumpurple: "#9370db", mediumseagreen: "#3cb371", mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a", mediumturquoise: "#48d1cc", mediumvioletred: "#c71585", midnightblue: "#191970",
  mintcream: "#f5fffa", mistyrose: "#ffe4e1", moccasin: "#ffe4b5", navajowhite: "#ffdead", navy: "#000080", oldlace: "#fdf5e6",
  olive: "#808000", olivedrab: "#6b8e23", orange: "#ffa500", orangered: "#ff4500", orchid: "#da70d6", palegoldenrod: "#eee8aa",
  palegreen: "#98fb98", paleturquoise: "#afeeee", palevioletred: "#db7093", papayawhip: "#ffefd5", peachpuff: "#ffdab9",
  peru: "#cd853f", pink: "#ffc0cb", plum: "#dda0dd", powderblue: "#b0e0e6", purple: "#800080", rebeccapurple: "#663399",
  red: "#ff0000", rosybrown: "#bc8f8f", royalblue: "#4169e1", saddlebrown: "#8b4513", salmon: "#fa8072", sandybrown: "#f4a460",
  seagreen: "#2e8b57", seashell: "#fff5ee", sienna: "#a0522d", silver: "#c0c0c0", skyblue: "#87ceeb", slateblue: "#6a5acd",
  slategray: "#708090", snow: "#fffafa", springgreen: "#00ff7f", steelblue: "#4682b4", tan: "#d2b48c", teal: "#008080",
  thistle: "#d8bfd8", tomato: "#ff6347", turquoise: "#40e0d0", violet: "#ee82ee", wheat: "#f5deb3", white: "#ffffff",
  whitesmoke: "#f5f5f5", yellow: "#ffff00", yellowgreen: "#9acd32",
};

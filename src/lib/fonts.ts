import latin from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import latinItalic from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-italic.woff2?url";
import latinExt from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2?url";
import latinExtItalic from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-italic.woff2?url";
import greek from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-greek-wght-normal.woff2?url";
import greekItalic from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-greek-wght-italic.woff2?url";
import cyrillic from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-wght-normal.woff2?url";
import cyrillicItalic from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-wght-italic.woff2?url";

/**
 * JetBrains Mono ships with Sable (SIL OFL), the way PyCharm bundles it,
 * so code looks the same on every machine. It's registered under the
 * plain family name "JetBrains Mono" — the name settings and font stacks
 * use — so it wins over a missing or differently named system install
 * (e.g. Nerd Font builds register as "JetBrainsMono Nerd Font"). CSS
 * family matching is case-insensitive, so "Jetbrains Mono" works too.
 *
 * It's a variable font: every weight from 100–800, plus true italics.
 * Each file covers a Unicode range and only downloads when used.
 */

export const BUNDLED_MONO_FAMILY = "JetBrains Mono";

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const GREEK = "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF";
const CYRILLIC = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";

const FACES: [url: string, style: "normal" | "italic", unicodeRange: string][] = [
  [latin, "normal", LATIN],
  [latinItalic, "italic", LATIN],
  [latinExt, "normal", LATIN_EXT],
  [latinExtItalic, "italic", LATIN_EXT],
  [greek, "normal", GREEK],
  [greekItalic, "italic", GREEK],
  [cyrillic, "normal", CYRILLIC],
  [cyrillicItalic, "italic", CYRILLIC],
];

export function registerBundledFonts(): void {
  for (const [url, style, unicodeRange] of FACES) {
    document.fonts.add(
      // Legacy "woff2-variations" first; plain "woff2" if it's rejected.
      new FontFace(
        BUNDLED_MONO_FAMILY,
        `url(${url}) format("woff2-variations"), url(${url}) format("woff2")`,
        {
          style,
          weight: "100 800",
          unicodeRange,
          display: "swap",
        },
      ),
    );
  }
}

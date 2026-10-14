import { parseJsonc } from "../jsonc";

/**
 * Workspace dictionaries, stored where the "Code Spell Checker" VS Code
 * extension keeps them so a project's word list works in both:
 * `cSpell.words` in the folder's .vscode/settings.json (Sable adds words
 * there), plus `words` / `ignoreWords` from a cspell.json if the project
 * has one (read only).
 */

export const SETTINGS_FILE = ".vscode/settings.json";
export const CSPELL_FILES = ["cspell.json", ".cspell.json", "cSpell.json", "cspell.config.json", ".vscode/cspell.json"];

const asWords = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((word): word is string => typeof word === "string") : [];

/** Words from a .vscode/settings.json's text. */
export function wordsFromVscodeSettings(text: string): string[] {
  try {
    const settings = parseJsonc(text) as Record<string, unknown>;
    if (!settings || typeof settings !== "object") return [];
    return [...asWords(settings["cSpell.words"]), ...asWords(settings["cSpell.ignoreWords"]), ...asWords(settings["cSpell.userWords"])];
  } catch {
    return [];
  }
}

/** Words from a cspell.json's text. */
export function wordsFromCspellJson(text: string): string[] {
  try {
    const config = parseJsonc(text) as Record<string, unknown>;
    if (!config || typeof config !== "object") return [];
    return [...asWords(config.words), ...asWords(config.ignoreWords)];
  } catch {
    return [];
  }
}

/** Offsets in `text` that are code (not inside a string or comment). */
function scanJsonc(text: string, visit: (index: number) => boolean | void): void {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index++;
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      if (visit(index)) return; // the closing quote counts as significant
      index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (!/\s/.test(char) && visit(index)) return;
    index++;
  }
}

/**
 * `text` (a .vscode/settings.json, or null if there's none) with `word`
 * added to `cSpell.words`. Only that array is rewritten (sorted, like the
 * extension does); the rest of the file — comments, order — is kept.
 */
export function addWordToVscodeSettings(text: string | null, word: string): string {
  if (!text || !text.trim()) return `{\n  "cSpell.words": [\n    ${JSON.stringify(word)}\n  ]\n}\n`;
  const key = /"cSpell\.words"\s*:\s*\[/.exec(text);
  if (key) {
    const open = key.index + key[0].length - 1;
    // The matching ] (strings inside the array may contain one).
    let close = -1;
    scanJsonc(text.slice(open + 1), (index) => {
      if (text[open + 1 + index] === "]") {
        close = open + 1 + index;
        return true;
      }
    });
    if (close !== -1) {
      let existing: string[] = [];
      try {
        existing = asWords(parseJsonc(text.slice(open, close + 1)));
      } catch {
        // Unreadable: keep what's there and add the word.
      }
      const words = [...new Set([...existing, word])].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const lineStart = text.lastIndexOf("\n", key.index) + 1;
      const indent = /^\s*/.exec(text.slice(lineStart, key.index))?.[0] ?? "  ";
      const inner = words.map((entry) => `${indent}  ${JSON.stringify(entry)}`).join(",\n");
      return `${text.slice(0, open + 1)}\n${inner}\n${indent}${text.slice(close)}`;
    }
  }
  // No cSpell.words yet: add it as the object's last entry.
  const end = text.lastIndexOf("}");
  if (end === -1) return `{\n  "cSpell.words": [\n    ${JSON.stringify(word)}\n  ]\n}\n`;
  let lastSignificant = -1;
  scanJsonc(text.slice(0, end), (index) => {
    lastSignificant = index;
  });
  const needsComma = lastSignificant !== -1 && text[lastSignificant] !== "{" && text[lastSignificant] !== ",";
  const entry = `  "cSpell.words": [\n    ${JSON.stringify(word)}\n  ]`;
  const before = text.slice(0, lastSignificant + 1) + (needsComma ? "," : "");
  const between = text.slice(lastSignificant + 1, end).replace(/\s+$/, "");
  return `${before}${between}\n${entry}\n${text.slice(end)}`;
}

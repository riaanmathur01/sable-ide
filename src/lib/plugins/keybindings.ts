/**
 * Plugin keyboard shortcuts ("keybindings" in sable-plugin.json):
 * "ctrl+shift+u", "cmd+alt+c", "alt+f1", with an optional "mac" variant —
 * the same notation as VS Code's, so converted extensions keep theirs.
 */

export interface ParsedKey {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** KeyboardEvent.code for letters/digits/F-keys, else the lowercased key. */
  key: string;
}

const NAMED: Record<string, string> = {
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  esc: "escape",
  del: "delete",
  space: " ",
  pageup: "pageup",
  pagedown: "pagedown",
};

/** Punctuation by physical key: Option/AltGr change the character typed. */
const PUNCTUATION: Record<string, string> = {
  "'": "Quote",
  ";": "Semicolon",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The binding's key for this OS, parsed; null if it can't be read. */
export function parseKeybinding(binding: { key: string; mac?: string }): ParsedKey | null {
  const text = (isMac() && binding.mac ? binding.mac : binding.key).toLowerCase().trim();
  // A chord ("ctrl+k ctrl+c") isn't supported: take nothing rather than half.
  if (!text || /\s/.test(text.replace(/\s*\+\s*/g, "+"))) return null;
  const parts = text.replace(/\s*\+\s*/g, "+").split("+");
  const last = parts.pop();
  if (!last) return null;
  const parsed: ParsedKey = { ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const modifier of parts) {
    if (modifier === "ctrl") parsed.ctrl = true;
    else if (modifier === "cmd" || modifier === "meta" || modifier === "win") parsed.meta = true;
    else if (modifier === "alt" || modifier === "option") parsed.alt = true;
    else if (modifier === "shift") parsed.shift = true;
    else if (modifier === "ctrlcmd" || modifier === "mod") parsed[isMac() ? "meta" : "ctrl"] = true;
    else return null;
  }
  if (/^[a-z]$/.test(last)) parsed.key = `Key${last.toUpperCase()}`;
  else if (/^[0-9]$/.test(last)) parsed.key = `Digit${last}`;
  else if (/^f([1-9]|1[0-9])$/.test(last)) parsed.key = last.toUpperCase();
  else if (PUNCTUATION[last]) parsed.key = PUNCTUATION[last];
  else parsed.key = NAMED[last] ?? last;
  return parsed;
}

/** Whether a key press is this binding. */
export function matchesKey(event: KeyboardEvent, key: ParsedKey): boolean {
  if (event.ctrlKey !== key.ctrl || event.metaKey !== key.meta || event.altKey !== key.alt || event.shiftKey !== key.shift) return false;
  if (/^(Key|Digit)/.test(key.key) || /^F\d+$/.test(key.key) || Object.values(PUNCTUATION).includes(key.key)) return event.code === key.key;
  return event.key.toLowerCase() === key.key;
}

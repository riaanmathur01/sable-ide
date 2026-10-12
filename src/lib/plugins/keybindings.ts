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

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The binding's key for this OS, parsed; null if it can't be read. */
export function parseKeybinding(binding: { key: string; mac?: string }): ParsedKey | null {
  return parseKey(isMac() && binding.mac ? binding.mac : binding.key);
}

/** "ctrl+shift+p" → its parts; null if it can't be read. */
export function parseKey(raw: string): ParsedKey | null {
  const text = raw.toLowerCase().trim();
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

/** A key press as a key string ("cmd+shift+k"); null for a lone modifier. */
export function keyFromEvent(event: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");
  if (event.metaKey) parts.push(isMac() ? "cmd" : "win");
  let key: string;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  else if (/^F\d+$/.test(event.code)) key = event.code.toLowerCase();
  else {
    const punctuation = Object.entries(PUNCTUATION).find(([, code]) => code === event.code)?.[0];
    const named = Object.entries(NAMED).find(([, value]) => value === event.key.toLowerCase())?.[0];
    key = punctuation ?? named ?? event.key.toLowerCase();
  }
  parts.push(key);
  return parts.join("+");
}

const SYMBOLS: Record<string, string> = { ctrl: "⌃", shift: "⇧", alt: "⌥", cmd: "⌘", meta: "⌘", win: "⊞" };
const KEY_SYMBOLS: Record<string, string> = {
  up: "↑", down: "↓", left: "←", right: "→", enter: "↩", escape: "Esc", esc: "Esc", tab: "⇥", backspace: "⌫", delete: "⌦", space: "Space",
};

/** A key string for display: "⌘⇧P" on a Mac, "Ctrl+Shift+P" elsewhere. */
export function formatKey(raw: string): string {
  const mac = isMac();
  const parts = raw.toLowerCase().replace(/\s*\+\s*/g, "+").split("+").filter(Boolean);
  const key = parts.pop() ?? "";
  const label = KEY_SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : key.replace(/^f(\d+)$/, "F$1").replace(/^\w/, (c) => c.toUpperCase()));
  const modifiers = parts.map((part) => (part === "ctrlcmd" || part === "mod" ? (mac ? "cmd" : "ctrl") : part));
  if (mac) {
    const order = ["ctrl", "alt", "shift", "cmd", "meta"];
    return modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((part) => SYMBOLS[part] ?? part).join("") + label;
  }
  const names: Record<string, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", win: "Win", meta: "Win", cmd: "Win" };
  return [...modifiers.map((part) => names[part] ?? part), label].join("+");
}

/** Whether a key press is this binding. */
export function matchesKey(event: KeyboardEvent, key: ParsedKey): boolean {
  if (event.ctrlKey !== key.ctrl || event.metaKey !== key.meta || event.altKey !== key.alt || event.shiftKey !== key.shift) return false;
  if (/^(Key|Digit)/.test(key.key) || /^F\d+$/.test(key.key) || Object.values(PUNCTUATION).includes(key.key)) return event.code === key.key;
  return event.key.toLowerCase() === key.key;
}

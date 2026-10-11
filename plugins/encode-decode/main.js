// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** Text → Base64 of its UTF-8 bytes (btoa alone only takes Latin-1). */
function base64Encode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Base64 (standard or URL-safe, padding optional, line breaks ignored)
 *  → the UTF-8 text it holds. */
function base64Decode(text) {
  let clean = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.replace(/=+$/, "").length % 4 === 1) {
    throw new Error("That isn't valid Base64");
  }
  clean = clean.replace(/=+$/, "");
  clean += "=".repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The decoded Base64 is binary data, not UTF-8 text");
  }
}

function urlDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new Error("That isn't valid URL encoding (a stray or broken %)");
  }
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Common named entities; anything else numeric (&#169; / &#xA9;) works too. */
/** @type {Record<string, string>} */
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  bull: "•", middot: "·", deg: "°", plusmn: "±", times: "×", divide: "÷",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
  frac12: "½", frac14: "¼", frac34: "¾", micro: "µ", iexcl: "¡", iquest: "¿",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", ne: "≠", le: "≤", ge: "≥",
};

const htmlEscape = (text) => text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

/** Unknown names and impossible numbers are left as they are. */
function htmlUnescape(text) {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity, body) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body] ?? entity;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** Text → what goes between the quotes of a JSON (or JavaScript) string. */
const jsonEscape = (text) => JSON.stringify(text).slice(1, -1);

/** The reverse. Surrounding quotes, if selected too, are dropped. */
function jsonUnescape(text) {
  const body = text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
  /** @type {Record<string, string>} */
  const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (escape, code) => {
    if (code.length === 5) return String.fromCharCode(parseInt(code.slice(1), 16));
    if (code in simple) return simple[code];
    throw new Error(`Invalid escape ${escape}`);
  });
}

/** @type {Record<string, [string, (text: string) => string]>} */
const CONVERSIONS = {
  base64Encode: ["Base64 Encode", base64Encode],
  base64Decode: ["Base64 Decode", base64Decode],
  urlEncode: ["URL Encode", encodeURIComponent],
  urlDecode: ["URL Decode", urlDecode],
  htmlEscape: ["HTML Escape", htmlEscape],
  htmlUnescape: ["HTML Unescape", htmlUnescape],
  jsonEscape: ["JSON String Escape", jsonEscape],
  jsonUnescape: ["JSON String Unescape", jsonUnescape],
};

/** @param {Sable} sable */
export function activate(sable) {
  for (const [id, [title, convert]] of Object.entries(CONVERSIONS)) {
    sable.commands.register(id, title, async () => {
      const editor = await sable.editor.active();
      if (!editor) return sable.window.showError("Open a file first");
      const selected = editor.selection?.text ?? "";
      const text = selected || editor.text;
      if (!text) return sable.window.showError("Nothing to convert: the file is empty");
      let result;
      try {
        result = convert(text);
      } catch (error) {
        return sable.window.showError(`${title}: ${error instanceof Error ? error.message : error}`);
      }
      if (selected) await sable.editor.replaceSelection(result);
      else await sable.editor.setText(result);
    });
  }
}

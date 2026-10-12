import type { DbValue } from "./api";

/** What kind of SQLite value this is. */
export type ValueKind = "null" | "integer" | "real" | "text" | "blob";

export function kindOf(value: DbValue): ValueKind {
  if (value === null) return "null";
  if (typeof value === "number") return "integer";
  if (typeof value === "string") return "text";
  if ("i" in value) return "integer";
  if ("r" in value) return "real";
  return "blob";
}

export function isBlob(value: DbValue): value is { b: number; m?: string; d?: string } {
  return value !== null && typeof value === "object" && "b" in value;
}

/** A real, written so it reads as one (2 → "2.0"). */
function realText(value: number | string): string {
  if (typeof value === "string") return value;
  const text = String(value);
  return /[.eE]|Infinity|NaN/.test(text) ? text : `${text}.0`;
}

/** The value as plain text (copying, editing, CSV); blobs as "BLOB (n bytes)". */
export function valueText(value: DbValue): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if ("i" in value) return value.i;
  if ("r" in value) return realText(value.r);
  return `BLOB (${formatBytes(value.b)})`;
}

/** Sort-of-human bytes: 1,234 bytes · 12.3 KB · 4.5 MB. */
export function formatBytes(size: number): string {
  if (size < 10 * 1024) return `${size.toLocaleString()} byte${size === 1 ? "" : "s"}`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export const formatCount = (count: number) => count.toLocaleString("en-US");

/** A blob's bytes, when the page carried them. */
export function blobBytes(value: DbValue): Uint8Array | null {
  if (!isBlob(value) || value.d === undefined) return null;
  return base64Bytes(value.d);
}

export function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** A hex dump: offset, 16 bytes, their ASCII. */
export function hexDump(bytes: Uint8Array, limit = 64 * 1024): string {
  const lines: string[] = [];
  const end = Math.min(bytes.length, limit);
  for (let offset = 0; offset < end; offset += 16) {
    const row = bytes.subarray(offset, Math.min(offset + 16, end));
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0"));
    const left = hex.slice(0, 8).join(" ");
    const right = hex.slice(8).join(" ");
    const ascii = [...row].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "·")).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${left.padEnd(23)}  ${right.padEnd(23)}  ${ascii}`);
  }
  if (bytes.length > end) lines.push(`… ${formatBytes(bytes.length - end)} more`);
  return lines.join("\n");
}

/** Text that is JSON (an object or array), pretty-printed; else null. */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/** A data: URL for an image blob the page carried. */
export function imageUrl(value: DbValue): string | null {
  if (!isBlob(value) || !value.m || value.d === undefined) return null;
  return `data:${value.m};base64,${value.d}`;
}

/** Comparable values for keys (row identity in the grid cache). */
export const keyId = (key: DbValue[] | null | undefined) => JSON.stringify(key ?? null);

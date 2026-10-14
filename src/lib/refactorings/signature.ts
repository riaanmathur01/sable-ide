import type { Signature, SignatureLanguage, SignatureParam } from "./types";

/**
 * Signatures as each language writes them: the Change Signature dialog's
 * live preview, and parameter text for the text-based engine (languages
 * whose declarations are rewritten without a syntax tree).
 */

const BY_EXTENSION: Record<string, SignatureLanguage> = {
  py: "python",
  pyi: "python",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  java: "java",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  php: "php",
  rb: "ruby",
};

export function languageOf(path: string): SignatureLanguage {
  return BY_EXTENSION[path.split(".").pop()?.toLowerCase() ?? ""] ?? "other";
}

let nextId = 0;
export const newParamId = () => `p${++nextId}`;

/** Languages that write `name: Type`. */
const COLON_TYPED = new Set<SignatureLanguage>(["python", "typescript", "kotlin", "rust", "php", "other"]);
/** Languages that write `Type name`. */
const TYPE_FIRST = new Set<SignatureLanguage>(["java", "csharp", "c"]);

/** One parameter's text in the declaration. */
export function formatParam(language: SignatureLanguage, param: SignatureParam): string {
  const changed = param.raw === undefined || param.original === null;
  if (!changed && param.raw !== undefined) return param.raw;
  const type = param.type.trim();
  const value = param.defaultValue.trim();
  switch (language) {
    case "python": {
      const star = param.kind === "vararg" ? "*" : param.kind === "kwarg" ? "**" : "";
      let text = star + param.name;
      if (type) text += `: ${type}`;
      if (value) text += type ? ` = ${value}` : `=${value}`;
      return text;
    }
    case "typescript":
    case "javascript": {
      let text = (param.modifiers ? `${param.modifiers} ` : "") + (param.kind === "rest" ? "..." : "") + param.name;
      if (param.optional && !value) text += "?";
      if (type && language === "typescript") text += `: ${type}`;
      if (value) text += ` = ${value}`;
      return text;
    }
    case "go":
      return type ? `${param.name} ${type}` : param.name;
    case "ruby":
      return value ? `${param.name} = ${value}` : param.name;
    case "php": {
      let text = (type ? `${type} ` : "") + (param.name.startsWith("$") ? param.name : `$${param.name}`);
      if (value) text += ` = ${value}`;
      return text;
    }
    default:
      if (TYPE_FIRST.has(language)) {
        let text = type ? `${type} ${param.name}` : param.name;
        if (value && language !== "java") text += ` = ${value}`;
        return text;
      }
      if (COLON_TYPED.has(language)) {
        let text = param.name;
        if (type) text += `: ${type}`;
        if (value) text += ` = ${value}`;
        return text;
      }
      return param.name;
  }
}

/** Python's parameter list: `/` and `*` markers where its kinds need them. */
function pythonParams(signature: Signature): string[] {
  const parts = signature.implicit ? [signature.implicit] : [];
  const params = signature.params;
  const positionalOnly = params.filter((param) => param.kind === "posonly");
  if (positionalOnly.length > 0) {
    parts.push(...positionalOnly.map((param) => formatParam("python", param)), "/");
  }
  let starred = false;
  for (const param of params) {
    if (param.kind === "posonly") continue;
    if (param.kind === "vararg") starred = true;
    if (param.kind === "kwonly" && !starred) {
      parts.push("*");
      starred = true;
    }
    parts.push(formatParam("python", param));
  }
  return parts;
}

export function formatParams(signature: Signature): string[] {
  if (signature.language === "python") return pythonParams(signature);
  return signature.params.map((param) => formatParam(signature.language, param));
}

/** The whole signature, for the dialog's preview. */
export function formatSignature(signature: Signature): string {
  const params = formatParams(signature).join(", ");
  const name = signature.name;
  const returns = signature.returnType?.trim() ?? "";
  switch (signature.language) {
    case "python":
      return `def ${name}(${params})${returns ? ` -> ${returns}` : ""}`;
    case "typescript":
      return `${signature.kind === "function" ? "function " : ""}${name}(${params})${returns ? `: ${returns}` : ""}`;
    case "javascript":
      return `${signature.kind === "function" ? "function " : ""}${name}(${params})`;
    case "go":
      return `func ${name}(${params})${returns ? ` ${returns}` : ""}`;
    case "rust":
      return `fn ${name}(${params})${returns ? ` -> ${returns}` : ""}`;
    case "kotlin":
      return `fun ${name}(${params})${returns ? `: ${returns}` : ""}`;
    case "php":
      return `function ${name}(${params})${returns ? `: ${returns}` : ""}`;
    case "ruby":
      return `def ${name}(${params})`;
    case "java":
    case "csharp":
    case "c":
      return `${returns ? `${returns} ` : ""}${name}(${params})`;
    default:
      return `${name}(${params})${returns ? `: ${returns}` : ""}`;
  }
}

/** Problems that make the new signature invalid (shown in the dialog). */
export function validateSignature(signature: Signature): string | null {
  if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(signature.name)) return "Enter a valid name";
  const names = new Set<string>();
  for (const param of signature.params) {
    const name = param.name.replace(/^\$/, "");
    if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) return `“${param.name || "(empty)"}” isn't a valid parameter name`;
    if (names.has(name)) return `Two parameters are called “${name}”`;
    names.add(name);
    if (param.original === null && !param.value.trim() && !param.defaultValue.trim() && !param.optional) {
      if (param.kind !== "vararg" && param.kind !== "kwarg" && param.kind !== "rest") {
        return `New parameter “${param.name}” needs a default value or a value for existing calls`;
      }
    }
  }
  if (signature.language === "python" || signature.language === "typescript" || signature.language === "javascript") {
    let seenDefault = false;
    for (const param of signature.params) {
      if (param.kind !== "positional" && param.kind !== "posonly") continue;
      const hasDefault = !!param.defaultValue.trim() || !!param.optional;
      if (hasDefault) seenDefault = true;
      else if (seenDefault && signature.language === "python") {
        return `“${param.name}” needs a default value: it comes after a parameter that has one`;
      }
    }
  }
  return null;
}

/**
 * Read a parameter written in `language` (text-based engine): its name,
 * type and default value.
 */
export function parseParam(language: SignatureLanguage, raw: string, index: number): SignatureParam {
  let text = raw.trim();
  let defaultValue = "";
  const equals = topLevelEquals(text);
  if (equals >= 0) {
    defaultValue = text.slice(equals + 1).trim();
    text = text.slice(0, equals).trim();
  }
  let name = text;
  let type = "";
  if (TYPE_FIRST.has(language) || language === "php") {
    // `final Map<K, V> name`, `int *name`, `string $name`
    const match = text.match(/^(.*?)([\p{L}_$][\p{L}\p{N}_$]*)(\s*\[\s*\])?$/u);
    if (match) {
      type = (match[1] + (match[3] ?? "")).trim();
      name = match[2];
    }
  } else if (language === "go") {
    const space = text.search(/\s/);
    if (space > 0) {
      name = text.slice(0, space);
      type = text.slice(space).trim();
    }
  } else {
    const colon = text.indexOf(":");
    if (colon > 0) {
      name = text.slice(0, colon).trim();
      type = text.slice(colon + 1).trim();
    }
    // Rust patterns (`mut x`), Kotlin modifiers (`vararg x`): keep them in the name.
  }
  return { id: newParamId(), name, type, defaultValue, value: "", original: index, kind: "positional", raw: raw.trim() };
}

function topLevelEquals(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if ("([{<".includes(char)) depth++;
    else if (")]}>".includes(char)) depth--;
    else if (char === "=" && depth === 0 && text[i + 1] !== "=" && text[i - 1] !== "=" && text[i + 1] !== ">") return i;
  }
  return -1;
}

/** Whether a parameter differs from what it was (so its text is rebuilt). */
export function markEdited(param: SignatureParam, original: SignatureParam | undefined): SignatureParam {
  if (!original || param.raw === undefined) return param;
  const same = param.name === original.name && param.type === original.type && param.defaultValue === original.defaultValue;
  return same ? param : { ...param, raw: undefined };
}

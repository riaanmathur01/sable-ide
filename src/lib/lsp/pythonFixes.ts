/**
 * Pure helpers behind Sable's Python quick fixes (see pythonQuickFixes.ts).
 * Pyright reports problems but offers almost no fixes of its own, so
 * these turn its diagnostics into edits: add a missing import, remove an
 * unused one, map a module to its pip package. No editor or I/O here —
 * everything works on plain text, so it's unit-testable.
 */

/** An LSP-style text edit (0-based lines/characters). */
export interface TextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

// --- Reading Pyright's messages -------------------------------------------------

/** `"defaultdict" is not defined` → "defaultdict". */
export function undefinedName(message: string): string | null {
  return /^"([A-Za-z_]\w*)" is not defined/.exec(message)?.[1] ?? null;
}

/** `Import "requests.adapters" could not be resolved…` → "requests.adapters". */
export function unresolvedModule(message: string): string | null {
  return /^Import "([\w.]+)" could not be resolved/.exec(message)?.[1] ?? null;
}

/** `"os" is not accessed` (Pyright) or `Import "os" is not accessed`
 *  (basedpyright) → "os" — the unused-symbol hint. */
export function unaccessedName(message: string): string | null {
  return /^(?:Import )?"([A-Za-z_]\w*)" is not accessed$/.exec(message)?.[1] ?? null;
}

// --- Known imports ------------------------------------------------------------

/** How to import a name: `from module import name` or `import module [as alias]`. */
export interface ImportSpec {
  module: string;
  /** Present for `from module import name`. */
  name?: string;
  /** Present for `import module as alias`. */
  alias?: string;
}

function fromImports(module: string, names: string[]): Record<string, ImportSpec> {
  return Object.fromEntries(names.map((name) => [name, { module, name }]));
}

/**
 * Common names Pyright's auto-import doesn't offer (it indexes only part
 * of the standard library). Its own suggestions are used first; this fills
 * the gaps for the names people reach for most.
 */
export const KNOWN_IMPORTS: Record<string, ImportSpec> = {
  ...fromImports("collections", ["defaultdict", "Counter", "OrderedDict", "deque", "namedtuple", "ChainMap"]),
  ...fromImports("collections.abc", ["Iterable", "Iterator", "Mapping", "Sequence", "Callable", "Generator"]),
  ...fromImports("pathlib", ["Path", "PurePath"]),
  ...fromImports("dataclasses", ["dataclass", "field", "asdict", "astuple"]),
  ...fromImports("datetime", ["datetime", "date", "time", "timedelta", "timezone"]),
  ...fromImports("functools", ["partial", "reduce", "lru_cache", "cache", "wraps", "cached_property", "total_ordering"]),
  ...fromImports("itertools", ["chain", "product", "permutations", "combinations", "groupby", "islice", "count", "cycle", "accumulate", "zip_longest"]),
  ...fromImports("typing", ["Any", "Optional", "Union", "List", "Dict", "Tuple", "Set", "TypeVar", "Generic", "Protocol", "Literal", "cast", "TYPE_CHECKING", "NamedTuple", "TypedDict", "ClassVar", "Final", "overload"]),
  ...fromImports("enum", ["Enum", "IntEnum", "auto", "Flag"]),
  ...fromImports("abc", ["ABC", "abstractmethod"]),
  ...fromImports("random", ["randint", "choice", "shuffle", "random", "sample", "uniform"]),
  ...fromImports("math", ["sqrt", "pi", "floor", "ceil", "inf", "isclose", "gcd"]),
  ...fromImports("copy", ["deepcopy"]),
  ...fromImports("pprint", ["pprint"]),
  ...fromImports("decimal", ["Decimal"]),
  ...fromImports("fractions", ["Fraction"]),
  ...fromImports("contextlib", ["contextmanager", "suppress", "ExitStack"]),
  ...fromImports("time", ["sleep", "perf_counter"]),
  ...fromImports("uuid", ["uuid4"]),
  ...fromImports("textwrap", ["dedent"]),
  ...fromImports("operator", ["itemgetter", "attrgetter"]),
  ...fromImports("heapq", ["heappush", "heappop", "heapify"]),
  ...fromImports("bisect", ["bisect_left", "bisect_right", "insort"]),
  ...Object.fromEntries(
    [
      "os", "sys", "re", "json", "math", "random", "time", "subprocess", "shutil", "logging",
      "itertools", "functools", "collections", "pathlib", "datetime", "argparse", "csv",
      "sqlite3", "asyncio", "threading", "typing", "string", "statistics", "tempfile",
      "glob", "pickle", "hashlib", "base64", "socket", "unittest", "doctest", "inspect",
      "traceback", "warnings", "dataclasses", "enum", "copy", "pprint", "io", "struct",
      "urllib", "http", "email", "zipfile", "tarfile", "uuid", "secrets", "decimal",
      "fractions", "operator", "heapq", "bisect", "array", "queue", "platform", "signal",
      "textwrap", "difflib", "calendar", "locale", "getpass", "webbrowser", "turtle", "tkinter",
    ].map((module) => [module, { module }]),
  ),
  np: { module: "numpy", alias: "np" },
  pd: { module: "pandas", alias: "pd" },
  plt: { module: "matplotlib.pyplot", alias: "plt" },
  sns: { module: "seaborn", alias: "sns" },
  tf: { module: "tensorflow", alias: "tf" },
  nn: { module: "torch", name: "nn" },
};

export function importStatement(spec: ImportSpec): string {
  if (spec.name) return `from ${spec.module} import ${spec.name}`;
  return spec.alias ? `import ${spec.module} as ${spec.alias}` : `import ${spec.module}`;
}

// --- Adding an import ------------------------------------------------------------

const IMPORT_LINE = /^(?:from\s+[\w.]+\s+import\b|import\s+[\w.])/;

/**
 * The edit that adds `spec` to a file. Merges into an existing single-line
 * `from module import …` when there is one; otherwise inserts a new line
 * after the top-of-file imports (or after a module docstring, shebang,
 * encoding line, or `from __future__` imports).
 */
export function addImportEdit(text: string, spec: ImportSpec): TextEdit {
  const lines = text.split("\n");

  if (spec.name) {
    const fromLine = new RegExp(`^from\\s+${spec.module.replace(/\./g, "\\.")}\\s+import\\s+(?!\\()`);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!fromLine.test(line) || line.includes("\\")) continue;
      // Append before any trailing comment.
      const commentAt = line.indexOf("#");
      const end = (commentAt === -1 ? line : line.slice(0, commentAt)).trimEnd().length;
      return {
        range: { start: { line: index, character: end }, end: { line: index, character: end } },
        newText: `, ${spec.name}`,
      };
    }
  }

  // Find where the import block ends.
  let insertAt = 0;
  let index = 0;
  if (lines[0]?.startsWith("#!")) index = insertAt = 1;
  if (/^#.*coding[:=]/.test(lines[index] ?? "")) index = insertAt = index + 1;
  // Module docstring.
  const docMatch = /^\s*(?:[rRuU]?)("""|''')/.exec(lines[index] ?? "");
  if (docMatch) {
    const quote = docMatch[1];
    const first = lines[index];
    const closesOnSameLine = first.indexOf(quote, first.indexOf(quote) + 3) !== -1;
    let end = index;
    if (!closesOnSameLine) {
      end = index + 1;
      while (end < lines.length && !lines[end].includes(quote)) end++;
    }
    index = insertAt = end + 1;
  }
  // Last top-level import (skipping blanks/comments between imports).
  for (let line = index; line < lines.length; line++) {
    const content = lines[line];
    if (IMPORT_LINE.test(content)) {
      insertAt = line + 1;
      // Parenthesized multi-line import: continue past its closing paren.
      if (content.includes("(") && !content.includes(")")) {
        while (insertAt < lines.length && !lines[insertAt - 1].includes(")")) insertAt++;
      }
    } else if (content.trim() === "" || content.trimStart().startsWith("#")) {
      continue;
    } else {
      break;
    }
  }
  return {
    range: { start: { line: insertAt, character: 0 }, end: { line: insertAt, character: 0 } },
    newText: `${importStatement(spec)}\n`,
  };
}

// --- Removing an unused import ------------------------------------------------------

interface ParsedImport {
  /** Everything before the names (`from x import ` / `import `, with indent). */
  head: string;
  items: string[];
  /** Trailing comment, if any (kept). */
  comment: string;
}

function parseImportLine(line: string): ParsedImport | null {
  if (line.includes("(") || line.trimEnd().endsWith("\\") || line.includes(";")) return null;
  const commentAt = line.indexOf("#");
  const code = commentAt === -1 ? line : line.slice(0, commentAt);
  const comment = commentAt === -1 ? "" : line.slice(commentAt);
  const match = /^(\s*(?:from\s+[\w.]+\s+)?import\s+)(.+?)\s*$/.exec(code);
  if (!match) return null;
  return { head: match[1], items: match[2].split(",").map((item) => item.trim()), comment };
}

/** The name an import item binds: `a.b` → `a`, `x as y` → `y`. */
function boundName(item: string, isFrom: boolean): string {
  const alias = /\s+as\s+(\w+)$/.exec(item);
  if (alias) return alias[1];
  return isFrom ? item : item.split(".")[0];
}

/**
 * The import line with `names` removed: the new text, `""` if nothing is
 * left (delete the line), or `null` if the line isn't a simple
 * single-line import we can safely rewrite.
 */
export function removeImportNames(line: string, names: string[]): string | null {
  const parsed = parseImportLine(line);
  if (!parsed) return null;
  const isFrom = /^\s*from\s/.test(parsed.head);
  const remaining = parsed.items.filter((item) => !names.includes(boundName(item, isFrom)));
  if (remaining.length === parsed.items.length) return null;
  if (remaining.length === 0) return "";
  const comment = parsed.comment ? `  ${parsed.comment}` : "";
  return `${parsed.head}${remaining.join(", ")}${comment}`;
}

/**
 * Edits removing unused imports: `unused` maps a 0-based line to the
 * names to drop from it. Lines left empty are deleted with their newline.
 */
export function removeUnusedImportEdits(text: string, unused: Map<number, string[]>): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  for (const [line, names] of unused) {
    const content = lines[line];
    if (content === undefined) continue;
    const replacement = removeImportNames(content, names);
    if (replacement === null) continue;
    edits.push(
      replacement === ""
        ? {
            range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } },
            newText: "",
          }
        : {
            range: { start: { line, character: 0 }, end: { line, character: content.length } },
            newText: replacement,
          },
    );
  }
  return edits;
}

// --- Packages -----------------------------------------------------------------------

/** Import names whose pip package is named differently. */
const PIP_PACKAGES: Record<string, string> = {
  cv2: "opencv-python",
  PIL: "Pillow",
  sklearn: "scikit-learn",
  skimage: "scikit-image",
  yaml: "PyYAML",
  bs4: "beautifulsoup4",
  dotenv: "python-dotenv",
  dateutil: "python-dateutil",
  jwt: "PyJWT",
  serial: "pyserial",
  usb: "pyusb",
  Crypto: "pycryptodome",
  OpenSSL: "pyOpenSSL",
  magic: "python-magic",
  docx: "python-docx",
  pptx: "python-pptx",
  fitz: "PyMuPDF",
  telegram: "python-telegram-bot",
  attr: "attrs",
  google: "google-api-python-client",
  win32api: "pywin32",
  wx: "wxPython",
  gi: "PyGObject",
  zmq: "pyzmq",
  Levenshtein: "python-Levenshtein",
};

/** The pip package that provides an import (`cv2.aruco` → `opencv-python`). */
export function pipPackageFor(module: string): string {
  const top = module.split(".")[0];
  return PIP_PACKAGES[top] ?? top;
}

/**
 * Jupyter's notebook format (nbformat 4): reading, and writing it back
 * the way Jupyter does — keys sorted, one-space indent, multi-line
 * strings split into lists of lines, a trailing newline — so saving a
 * notebook in Sable makes the same diff Jupyter would. Everything Sable
 * doesn't edit (notebook and cell metadata, attachments, outputs it
 * didn't produce, unknown fields) is kept as it was.
 */

/** A string, or the list-of-lines form nbformat writes. */
export type MultilineString = string | string[];

export type MimeBundle = Record<string, unknown>;

export type NbOutput =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: MultilineString; [key: string]: unknown }
  | { output_type: "display_data"; data: MimeBundle; metadata: Record<string, unknown>; transient?: { display_id?: string }; [key: string]: unknown }
  | { output_type: "execute_result"; data: MimeBundle; metadata: Record<string, unknown>; execution_count: number | null; transient?: { display_id?: string }; [key: string]: unknown }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[]; [key: string]: unknown };

export type CellType = "code" | "markdown" | "raw";

/** A cell as Sable holds it: `source` joined, the rest as read. */
export interface NbCell {
  /** Stable key for React and Monaco (the nbformat id when there is one). */
  key: string;
  cell_type: CellType;
  source: string;
  /** Everything else in the cell's JSON (id, metadata, outputs, …). */
  raw: Record<string, unknown>;
  outputs: NbOutput[];
  execution_count: number | null;
}

export interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NbCell[];
  /** Top-level fields besides those above. */
  rest: Record<string, unknown>;
}

export const joinMultiline = (value: unknown): string =>
  Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "";

/** Python's str.splitlines(True). */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (!LINE_BREAKS.has(text[index])) continue;
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}
const LINE_BREAKS = new Set(["\n", "\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]);

const isJsonMime = (mime: string) => mime === "application/json" || (mime.startsWith("application/") && mime.endsWith("+json"));
const SPLIT_MIMES = new Set(["application/javascript", "image/svg+xml"]);

/** A mime bundle with its text-like values joined into strings. */
export function joinBundle(data: MimeBundle): MimeBundle {
  const joined: MimeBundle = {};
  for (const [mime, value] of Object.entries(data ?? {})) {
    joined[mime] = !isJsonMime(mime) && Array.isArray(value) && value.every((line) => typeof line === "string") ? value.join("") : value;
  }
  return joined;
}

function splitBundle(data: MimeBundle): MimeBundle {
  const split: MimeBundle = {};
  for (const [mime, value] of Object.entries(data ?? {})) {
    split[mime] = typeof value === "string" && (mime.startsWith("text/") || SPLIT_MIMES.has(mime)) ? splitLines(value) : value;
  }
  return split;
}

function normalizeOutput(output: NbOutput): NbOutput {
  switch (output.output_type) {
    case "stream":
      return { ...output, text: joinMultiline(output.text) };
    case "display_data":
    case "execute_result":
      return { ...output, data: joinBundle(output.data), metadata: output.metadata ?? {} };
    default:
      return output;
  }
}

function outputForDisk(output: NbOutput): Record<string, unknown> {
  switch (output.output_type) {
    case "stream":
      return { ...output, text: splitLines(joinMultiline(output.text)) };
    case "display_data": {
      // display_id is transient: never saved.
      const { transient: _transient, ...rest } = output;
      return { ...rest, data: splitBundle(output.data), metadata: output.metadata ?? {} };
    }
    case "execute_result": {
      const { transient: _transient, ...rest } = output;
      return { ...rest, data: splitBundle(output.data), metadata: output.metadata ?? {} };
    }
    default:
      return output;
  }
}

let keyCounter = 0;

/** A new nbformat cell id (like Jupyter's: 8 hex digits). */
export function newCellId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether this notebook's format has cell ids (4.5+). */
export const hasCellIds = (notebook: Pick<Notebook, "nbformat" | "nbformat_minor">) =>
  notebook.nbformat > 4 || (notebook.nbformat === 4 && notebook.nbformat_minor >= 5);

export function makeCell(type: CellType, source = "", withId = true): NbCell {
  const raw: Record<string, unknown> = { metadata: {} };
  if (withId) raw.id = newCellId();
  keyCounter += 1;
  return {
    key: `${(raw.id as string | undefined) ?? "cell"}-${keyCounter}`,
    cell_type: type,
    source,
    raw,
    outputs: [],
    execution_count: null,
  };
}

/** Parse an .ipynb file's text (an empty file is a new notebook). */
export function parseNotebook(text: string): Notebook {
  if (!text.trim()) {
    return {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: "Python 3 (ipykernel)", language: "python", name: "python3" },
        language_info: { name: "python" },
      },
      cells: [makeCell("code")],
      rest: {},
    };
  }
  const json = JSON.parse(text) as Record<string, unknown>;
  if (typeof json !== "object" || json === null || !Array.isArray(json.cells)) {
    throw new Error("Not a Jupyter notebook (no cells)");
  }
  const nbformat = Number(json.nbformat ?? 4);
  if (nbformat < 4) throw new Error(`nbformat ${nbformat} notebooks aren't supported — open it in Jupyter to upgrade it to version 4`);
  const { cells, metadata, nbformat: _format, nbformat_minor, ...rest } = json;
  return {
    nbformat,
    nbformat_minor: Number(nbformat_minor ?? 0),
    metadata: (metadata as Record<string, unknown>) ?? {},
    rest,
    cells: (cells as Record<string, unknown>[]).map((cell) => {
      const { source, outputs, execution_count, cell_type, ...raw } = cell;
      keyCounter += 1;
      const type: CellType = cell_type === "markdown" || cell_type === "raw" ? cell_type : "code";
      return {
        key: `${typeof raw.id === "string" ? raw.id : "cell"}-${keyCounter}`,
        cell_type: type,
        source: joinMultiline(source),
        raw,
        outputs: Array.isArray(outputs) ? (outputs as NbOutput[]).map(normalizeOutput) : [],
        execution_count: typeof execution_count === "number" ? execution_count : null,
      };
    }),
  };
}

/** Recursively sort object keys (Python's json.dumps(sort_keys=True)). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

/** The notebook as Jupyter writes it. `sources`: current cell text by key. */
export function serializeNotebook(notebook: Notebook, sources?: (cell: NbCell) => string): string {
  const withIds = hasCellIds(notebook);
  const cells = notebook.cells.map((cell) => {
    const source = sources ? sources(cell) : cell.source;
    const json: Record<string, unknown> = { ...cell.raw, cell_type: cell.cell_type, source: splitLines(source) };
    if (withIds && typeof json.id !== "string") json.id = newCellId();
    json.metadata ??= {};
    if (cell.cell_type === "code") {
      json.outputs = cell.outputs.map(outputForDisk);
      json.execution_count = cell.execution_count;
    } else {
      delete json.outputs;
      delete json.execution_count;
    }
    // Transient metadata Jupyter strips.
    if (json.metadata && typeof json.metadata === "object") delete (json.metadata as Record<string, unknown>).trusted;
    return json;
  });
  const metadata = { ...notebook.metadata };
  delete metadata.orig_nbformat;
  delete metadata.orig_nbformat_minor;
  delete metadata.signature;
  const document = { ...notebook.rest, cells, metadata, nbformat: notebook.nbformat, nbformat_minor: notebook.nbformat_minor };
  return `${JSON.stringify(sortKeys(document), null, 1)}\n`;
}

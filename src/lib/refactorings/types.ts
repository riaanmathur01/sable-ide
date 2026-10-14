/**
 * Shared shapes for the deeper refactorings (Safe Delete, Change
 * Signature, Move): what a refactoring will do (a plan, previewed and
 * then applied as one undoable step), the usages Safe Delete reports,
 * and the signature the Change Signature dialog edits.
 */

/** One file a refactoring changes. `before` null: created; `after` null: deleted. */
export interface PlannedFile {
  path: string;
  before: string | null;
  after: string | null;
}

/** Everything a refactoring will change, for the preview and for undo. */
export interface RefactoringPlan {
  /** "Change Signature of total" — the preview's title and the undo label. */
  title: string;
  files: PlannedFile[];
  /** Files moved or renamed (after their contents change, at the old path). */
  moves: { from: string; to: string }[];
  /** Name clashes, code that may break: shown before applying. */
  conflicts: string[];
  /** How it was worked out ("Rope", "TypeScript", "text-based…"). */
  engine: string;
  /** A file to open afterwards (Move's target), at a line. */
  reveal?: { path: string; line: number };
}

export interface UsageItem {
  path: string;
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  kind?: "import" | "call" | "reference";
}

/** A parameter as the Change Signature dialog edits it. */
export interface SignatureParam {
  /** Stable key for React and reordering. */
  id: string;
  name: string;
  /** Type / annotation ("" for none). */
  type: string;
  /** Default value in the signature ("" for none). */
  defaultValue: string;
  /** For a new parameter: the argument call sites pass ("" = the default). */
  value: string;
  /** Index among the original parameters; null for a new one. */
  original: number | null;
  /** Python's kinds; "rest" is TypeScript's `...xs`. */
  kind: "positional" | "posonly" | "kwonly" | "vararg" | "kwarg" | "rest";
  /** TypeScript: `x?`. */
  optional?: boolean;
  /** The parameter's original source (text-based engine), reused when unchanged. */
  raw?: string;
  /** TypeScript: `private readonly` and friends. */
  modifiers?: string;
}

export type SignatureLanguage =
  | "python"
  | "typescript"
  | "javascript"
  | "java"
  | "csharp"
  | "kotlin"
  | "go"
  | "rust"
  | "c"
  | "php"
  | "ruby"
  | "other";

export interface Signature {
  name: string;
  params: SignatureParam[];
  /** null when the language has none to edit (JavaScript, constructors). */
  returnType: string | null;
  /** Python's `self`/`cls`: shown, not editable. */
  implicit?: string;
  language: SignatureLanguage;
  /** "function", "method", "constructor"… */
  kind: string;
}

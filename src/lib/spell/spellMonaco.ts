import type * as MonacoTypes from "monaco-editor";
import { getSetting, useSettingsStore } from "../../store/settingsStore";
import { folderOf, onFoldersChange, useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { pathFromUri } from "../editorRegistry";
import { createDirectory, readFile, writeFile } from "../ipc";
import { onPluginEvent } from "../plugins/events";
import { scopeTokenizer } from "../shikiMonaco";
import { extractWords, matchCase, normalizeWord } from "./words";
import { fileDirectives, isCheckedToken, PROSE_LANGUAGES } from "./segments";
import {
  addWordToVscodeSettings,
  CSPELL_FILES,
  SETTINGS_FILE,
  wordsFromCspellJson,
  wordsFromVscodeSettings,
} from "./cspellConfig";
import type { DictionaryUrls, SpellRequest, SpellResponse } from "./spell.worker";
import SpellWorker from "./spell.worker?worker";
// The dictionaries: SCOWL-derived Hunspell files (MIT AND BSD) and
// cspell's software terms (MIT) — see THIRD_PARTY_NOTICES.md. Fetched by
// the worker the first time a file is checked.
import enUsAff from "../../../node_modules/dictionary-en/index.aff?url";
import enUsDic from "../../../node_modules/dictionary-en/index.dic?url";
import enGbAff from "../../../node_modules/dictionary-en-gb/index.aff?url";
import enGbDic from "../../../node_modules/dictionary-en-gb/index.dic?url";
import softwareTerms from "../../../node_modules/@cspell/dict-software-terms/dict/softwareTerms.txt.gz?url";
import softwareTools from "../../../node_modules/@cspell/dict-software-terms/dict/software-tools.txt?url";
import codingTerms from "../../../node_modules/@cspell/dict-software-terms/dict/coding-compound-terms.txt?url";
import acronyms from "../../../node_modules/@cspell/dict-software-terms/dict/computing-acronyms.txt?url";
import webServices from "../../../node_modules/@cspell/dict-software-terms/dict/webServices.txt?url";
import networkingTerms from "../../../node_modules/@cspell/dict-software-terms/dict/networkingTerms.txt?url";

/**
 * A code-aware spell checker, like VS Code's "Code Spell Checker":
 * comments, strings, identifiers (split at camelCase / snake_case /
 * kebab-case) and prose files are checked; misspellings get an info
 * squiggle (marker owner "spell") whose quick fixes offer corrections,
 * "Add to user dictionary", "Add to workspace dictionary" and "Ignore in
 * this file".
 *
 * The dictionary lives in a Web Worker; this side tokenizes the file in
 * idle-time chunks (TextMate scopes say what's code, string or comment)
 * and only asks the worker about words it hasn't seen, so typing stays
 * smooth. Spelling isn't mirrored into the Problems panel (monacoSetup).
 */

type Monaco = typeof MonacoTypes;
type Model = MonacoTypes.editor.ITextModel;

export const SPELL_OWNER = "spell";

const TERM_LISTS = [softwareTerms, softwareTools, codingTerms, acronyms, webServices, networkingTerms];
const DICTIONARIES: Record<string, DictionaryUrls> = {
  "en-US": { aff: enUsAff, dic: enUsDic, terms: TERM_LISTS },
  "en-GB": { aff: enGbAff, dic: enGbDic, terms: TERM_LISTS },
};

/** Files bigger than this aren't checked (minified bundles, data dumps). */
const MAX_LINES = 20_000;
const MAX_LENGTH = 2_000_000;
const MAX_MARKERS = 1000;
const LINES_PER_CHUNK = 250;
const CHECK_DELAY_MS = 450;

// --- The worker -------------------------------------------------------------------------

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, (response: SpellResponse) => void>();
const loaded = new Map<string, Promise<void>>();

/** A request without its id (each SpellRequest variant). */
type Message = SpellRequest extends infer Variant ? (Variant extends SpellRequest ? Omit<Variant, "id"> : never) : never;

function request(message: Message): Promise<SpellResponse> {
  if (!worker) {
    worker = new SpellWorker();
    worker.onmessage = (event: MessageEvent<SpellResponse>) => {
      pending.get(event.data.id)?.(event.data);
      pending.delete(event.data.id);
    };
  }
  const id = nextRequestId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ ...message, id } as SpellRequest);
  });
}

function ensureDictionary(language: string): Promise<void> {
  let loading = loaded.get(language);
  if (!loading) {
    loading = request({ type: "load", language, urls: DICTIONARIES[language] ?? DICTIONARIES["en-US"] }).then((response) => {
      if (!response.ok) {
        loaded.delete(language);
        throw new Error(response.error);
      }
    });
    loaded.set(language, loading);
  }
  return loading;
}

/** Dictionary answers per language: lower-case word → spelled right. */
const knownByLanguage = new Map<string, Map<string, boolean>>();

async function unknownWords(language: string, words: string[]): Promise<Set<string>> {
  let known = knownByLanguage.get(language);
  if (!known) knownByLanguage.set(language, (known = new Map()));
  const ask = [...new Set(words.filter((word) => !known.has(normalizeWord(word))))];
  if (ask.length > 0) {
    await ensureDictionary(language);
    const response = await request({ type: "check", language, words: ask });
    if (!response.ok) throw new Error(response.error);
    const unknown = new Set(response.unknown);
    for (const word of ask) known.set(normalizeWord(word), !unknown.has(word));
  }
  return new Set(words.filter((word) => known.get(normalizeWord(word)) === false));
}

/** Up to five corrections for a misspelled word, in its case. */
export async function spellingSuggestions(word: string): Promise<string[]> {
  const language = getSetting("spellCheck.language");
  await ensureDictionary(language);
  const response = await request({ type: "suggest", language, word });
  if (!response.ok) return [];
  return [...new Set((response.suggestions ?? []).map((suggestion) => matchCase(word, suggestion)))].slice(0, 5);
}

// --- Your words -----------------------------------------------------------------------------

/** Lower-case words from the settings' user dictionary. */
let userWords = new Set<string>();
function readUserWords() {
  userWords = new Set(
    getSetting("spellCheck.userWords")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(normalizeWord),
  );
}

/** Each workspace folder's words (its .vscode/settings.json and cspell.json). */
const workspaceWords = new Map<string, Set<string>>();

const joinPath = (folder: string, relative: string) => {
  const separator = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${folder}${separator}${relative.replace(/\//g, separator)}`;
};

async function loadWorkspaceWords(folder: string): Promise<void> {
  const words = new Set<string>();
  const settings = await readFile(joinPath(folder, SETTINGS_FILE)).catch(() => null);
  if (settings) for (const word of wordsFromVscodeSettings(settings)) words.add(normalizeWord(word));
  for (const name of CSPELL_FILES) {
    const text = await readFile(joinPath(folder, name)).catch(() => null);
    if (text) for (const word of wordsFromCspellJson(text)) words.add(normalizeWord(word));
  }
  workspaceWords.set(folder, words);
}

/** Words ignored in one file ("Ignore in this file"), kept across sessions. */
const IGNORED_KEY = "sable.spell.ignored";
let ignoredByPath: Record<string, string[]> = {};
try {
  ignoredByPath = JSON.parse(localStorage.getItem(IGNORED_KEY) ?? "{}") ?? {};
} catch {
  ignoredByPath = {};
}
function saveIgnored() {
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify(ignoredByPath));
  } catch {
    // Storage full or blocked: the words stay ignored for this session.
  }
}

function isAccepted(word: string, path: string, fileWords: Set<string>): boolean {
  const lower = normalizeWord(word);
  if (userWords.has(lower) || fileWords.has(lower)) return true;
  if (ignoredByPath[path]?.includes(lower)) return true;
  const folder = folderOf(path);
  return !!folder && !!workspaceWords.get(folder)?.has(lower);
}

export async function addToUserDictionary(word: string): Promise<void> {
  const current = getSetting("spellCheck.userWords");
  const words = current.split(/\r?\n/).filter((line) => line.trim());
  if (!words.some((entry) => normalizeWord(entry.trim()) === normalizeWord(word))) words.push(word);
  useSettingsStore.getState().set("spellCheck.userWords", words.join("\n"));
}

export async function addToWorkspaceDictionary(word: string, path: string): Promise<void> {
  const folder = folderOf(path) ?? useWorkspaceStore.getState().rootPath;
  if (!folder) {
    await addToUserDictionary(word);
    return;
  }
  const file = joinPath(folder, SETTINGS_FILE);
  const text = await readFile(file).catch(() => null);
  // A first workspace setting: .vscode may not exist yet.
  if (text === null) await createDirectory(joinPath(folder, ".vscode")).catch(() => {});
  await writeFile(file, addWordToVscodeSettings(text, word));
  let words = workspaceWords.get(folder);
  if (!words) workspaceWords.set(folder, (words = new Set()));
  words.add(normalizeWord(word));
  recheckAll();
}

export function ignoreInFile(word: string, path: string): void {
  const words = new Set(ignoredByPath[path] ?? []);
  words.add(normalizeWord(word));
  ignoredByPath[path] = [...words];
  saveIgnored();
  recheckAll();
}

// --- Checking a file ---------------------------------------------------------------------------

let monacoRef: Monaco | null = null;
const timers = new Map<Model, ReturnType<typeof setTimeout>>();
/** The latest check per model; an older one stops when a newer starts. */
const generations = new WeakMap<Model, number>();

const idle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 0);
  });

function isCheckable(model: Model): boolean {
  return model.uri.scheme === "file" && !model.isDisposed();
}

function clearMarkers(model: Model) {
  if (!model.isDisposed()) monacoRef?.editor.setModelMarkers(model, SPELL_OWNER, []);
}

interface Occurrence {
  word: string;
  line: number;
  column: number;
}

/** Retries for files whose grammar is still loading. */
const grammarRetries = new WeakMap<Model, number>();

async function checkModel(model: Model): Promise<void> {
  const monaco = monacoRef;
  if (!monaco || !isCheckable(model)) return;
  if (!getSetting("spellCheck.enabled") || model.getLineCount() > MAX_LINES || model.getValueLength() > MAX_LENGTH) {
    clearMarkers(model);
    return;
  }
  const generation = (generations.get(model) ?? 0) + 1;
  generations.set(model, generation);
  const stale = () => model.isDisposed() || generations.get(model) !== generation;

  const languageId = model.getLanguageId();
  const prose = PROSE_LANGUAGES.has(languageId);
  const tokenize = scopeTokenizer(languageId);
  if (!tokenize && !prose) {
    // The grammar may still be loading: try again shortly (a few times).
    const tries = grammarRetries.get(model) ?? 0;
    if (tries < 6) {
      grammarRetries.set(model, tries + 1);
      schedule(model, 1000);
    }
    return;
  }
  const path = pathFromUri(model.uri);
  const lines = model.getLinesContent();
  const directives = fileDirectives(lines);
  const occurrences: Occurrence[] = [];
  for (let start = 0; start < lines.length; start += LINES_PER_CHUNK) {
    if (start > 0) {
      await idle();
      if (stale()) return;
    }
    const end = Math.min(lines.length, start + LINES_PER_CHUNK);
    for (let index = start; index < end; index++) {
      const line = lines[index];
      // Tokenize every line (the grammar's state carries over), check the enabled ones.
      const tokens = tokenize ? tokenize(line) : [{ start: 0, end: line.length, scopes: [] }];
      if (directives.disabledLines.has(index) || !line.trim()) continue;
      for (const token of tokens) {
        if (!isCheckedToken(tokenize ? token.scopes.slice(1) : [], prose)) continue;
        for (const found of extractWords(line.slice(token.start, token.end))) {
          if (isAccepted(found.word, path, directives.words)) continue;
          occurrences.push({ word: found.word, line: index + 1, column: token.start + found.offset + 1 });
        }
      }
    }
  }
  const language = getSetting("spellCheck.language");
  let unknown: Set<string>;
  try {
    unknown = await unknownWords(language, occurrences.map((occurrence) => occurrence.word));
  } catch (error) {
    useUiStore.getState().setLastError(`Spell check: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (stale() || !getSetting("spellCheck.enabled")) return;
  const markers: MonacoTypes.editor.IMarkerData[] = [];
  for (const occurrence of occurrences) {
    if (!unknown.has(occurrence.word)) continue;
    markers.push({
      severity: monaco.MarkerSeverity.Info,
      message: `"${occurrence.word}": Unknown word.`,
      source: SPELL_OWNER,
      startLineNumber: occurrence.line,
      startColumn: occurrence.column,
      endLineNumber: occurrence.line,
      endColumn: occurrence.column + occurrence.word.length,
    });
    if (markers.length >= MAX_MARKERS) break;
  }
  monaco.editor.setModelMarkers(model, SPELL_OWNER, markers);
}

function schedule(model: Model, delay = CHECK_DELAY_MS) {
  clearTimeout(timers.get(model));
  timers.set(
    model,
    setTimeout(() => {
      timers.delete(model);
      void checkModel(model);
    }, delay),
  );
}

/** Check every open file again (settings or dictionaries changed). */
export function recheckAll(): void {
  readUserWords();
  for (const model of monacoRef?.editor.getModels() ?? []) if (isCheckable(model)) schedule(model, 50);
}

// --- Quick fixes ----------------------------------------------------------------------------------

const COMMAND_USER = "sable.spell.addToUserDictionary";
const COMMAND_WORKSPACE = "sable.spell.addToWorkspaceDictionary";
const COMMAND_IGNORE = "sable.spell.ignoreInFile";

function registerQuickFixes(monaco: Monaco) {
  monaco.editor.registerCommand(COMMAND_USER, (_accessor, word: string) => void addToUserDictionary(word));
  monaco.editor.registerCommand(COMMAND_WORKSPACE, (_accessor, word: string, path: string) =>
    void addToWorkspaceDictionary(word, path).catch((error) => useUiStore.getState().setLastError(String(error))),
  );
  monaco.editor.registerCommand(COMMAND_IGNORE, (_accessor, word: string, path: string) => ignoreInFile(word, path));

  monaco.languages.registerCodeActionProvider("*", {
    provideCodeActions: async (model, _range, context) => {
      const markers = context.markers.filter((marker) => marker.source === SPELL_OWNER);
      if (markers.length === 0) return { actions: [], dispose() {} };
      const path = pathFromUri(model.uri);
      const inWorkspace = !!(folderOf(path) ?? useWorkspaceStore.getState().rootPath);
      const actions: MonacoTypes.languages.CodeAction[] = [];
      // The first misspelling under the cursor (there's rarely more than one).
      const marker = markers[0];
      const range = new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn);
      const word = model.getValueInRange(range);
      const versionId = model.getVersionId();
      const suggestions = await spellingSuggestions(word).catch(() => [] as string[]);
      suggestions.forEach((suggestion, index) =>
        actions.push({
          title: `Change to "${suggestion}"`,
          kind: "quickfix",
          diagnostics: [marker],
          isPreferred: index === 0,
          edit: { edits: [{ resource: model.uri, textEdit: { range, text: suggestion }, versionId }] },
        }),
      );
      actions.push({
        title: `Add "${word}" to user dictionary`,
        kind: "quickfix",
        diagnostics: [marker],
        command: { id: COMMAND_USER, title: "Add to user dictionary", arguments: [word] },
      });
      if (inWorkspace) {
        actions.push({
          title: `Add "${word}" to workspace dictionary`,
          kind: "quickfix",
          diagnostics: [marker],
          command: { id: COMMAND_WORKSPACE, title: "Add to workspace dictionary", arguments: [word, path] },
        });
      }
      actions.push({
        title: `Ignore "${word}" in this file`,
        kind: "quickfix",
        diagnostics: [marker],
        command: { id: COMMAND_IGNORE, title: "Ignore in this file", arguments: [word, path] },
      });
      return { actions, dispose() {} };
    },
  });
}

// --- Wiring --------------------------------------------------------------------------------------------

export function registerSpellChecker(monaco: Monaco): void {
  monacoRef = monaco;
  readUserWords();
  registerQuickFixes(monaco);

  const watch = (model: Model) => {
    if (model.uri.scheme !== "file") return;
    model.onDidChangeContent(() => schedule(model));
    model.onDidChangeLanguage(() => schedule(model, 50));
    model.onWillDispose(() => {
      clearTimeout(timers.get(model));
      timers.delete(model);
    });
    schedule(model, 200);
  };
  for (const model of monaco.editor.getModels()) watch(model);
  monaco.editor.onDidCreateModel(watch);

  // Settings: on/off, language, the user dictionary.
  useSettingsStore.subscribe((state, previous) => {
    const keys = ["spellCheck.enabled", "spellCheck.language", "spellCheck.userWords"] as const;
    if (keys.some((key) => state.values[key] !== previous.values[key])) recheckAll();
  });

  // Workspace dictionaries: each folder's, re-read when one is saved.
  const loadAll = () =>
    Promise.all(useWorkspaceStore.getState().folders.map(loadWorkspaceWords)).then(recheckAll, () => {});
  void loadAll();
  onFoldersChange(({ added, removed }) => {
    for (const folder of removed) workspaceWords.delete(folder);
    void Promise.all(added.map(loadWorkspaceWords)).then(recheckAll, () => {});
  });
  onPluginEvent((name, { path }) => {
    if (name !== "didSave" || !path) return;
    const normalized = path.replace(/\\/g, "/");
    if (normalized.endsWith(SETTINGS_FILE) || CSPELL_FILES.some((file) => normalized.endsWith(`/${file}`))) {
      const folder = folderOf(path);
      if (folder) void loadWorkspaceWords(folder).then(recheckAll, () => {});
    }
  });
}

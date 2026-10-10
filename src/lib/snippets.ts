import type * as MonacoTypes from "monaco-editor";
import { createDirectory, readDirectory, readFile, writeFile } from "./ipc";
import { useSettingsStore } from "../store/settingsStore";
import { useTabsStore } from "../store/tabsStore";
import { useUiStore } from "../store/uiStore";

/**
 * Snippets: a few built-in templates per language (JetBrains-style live
 * templates: psvm, sout, fori, ifmain…) plus your own, in VS Code's
 * format — `snippets/<language>.json` next to settings.json (and
 * `global.json` for every language). Type the prefix; pick it from the
 * completion list; Tab moves between its placeholders.
 */

export interface Snippet {
  prefix: string;
  body: string;
  description?: string;
}

type Monaco = typeof MonacoTypes;

const s = (prefix: string, description: string, ...body: string[]): Snippet => ({ prefix, description, body: body.join("\n") });

export const BUILTIN: Record<string, Snippet[]> = {
  python: [
    s("ifmain", 'if __name__ == "__main__"', 'if __name__ == "__main__":', "    ${1:main()}"),
    s("def", "Function", "def ${1:name}(${2}):", "    ${0:pass}"),
    s("class", "Class", "class ${1:Name}:", "    def __init__(self${2}):", "        ${0:pass}"),
    s("for", "for … in …", "for ${1:item} in ${2:items}:", "    ${0:pass}"),
    s("try", "try / except", "try:", "    ${1:pass}", "except ${2:Exception} as ${3:error}:", "    ${0:raise}"),
    s("with", "with … as …", "with ${1:open(path)} as ${2:file}:", "    ${0:pass}"),
  ],
  java: [
    s("psvm", "public static void main", "public static void main(String[] args) {", "\t${0}", "}"),
    s("sout", "System.out.println", "System.out.println(${0});"),
    s("fori", "Indexed for loop", "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {", "\t${0}", "}"),
  ],
  kotlin: [
    s("main", "fun main", "fun main() {", "    ${0}", "}"),
    s("fun", "Function", "fun ${1:name}(${2}): ${3:Unit} {", "    ${0}", "}"),
  ],
  go: [
    s("iferr", "if err != nil", "if err != nil {", "\treturn ${1:err}", "}"),
    s("func", "Function", "func ${1:name}(${2}) ${3:error} {", "\t${0}", "}"),
    s("fori", "Indexed for loop", "for ${1:i} := 0; ${1:i} < ${2:n}; ${1:i}++ {", "\t${0}", "}"),
  ],
  rust: [
    s("fn", "Function", "fn ${1:name}(${2}) ${3:-> ${4:()} }{", "    ${0}", "}"),
    s("test", "#[test] function", "#[test]", "fn ${1:it_works}() {", "    ${0}", "}"),
    s("impl", "impl block", "impl ${1:Type} {", "    ${0}", "}"),
  ],
  c: [s("main", "int main", "int main(int argc, char **argv) {", "    ${0}", "    return 0;", "}")],
  cpp: [
    s("main", "int main", "int main(int argc, char **argv) {", "    ${0}", "    return 0;", "}"),
    s("cout", "std::cout", "std::cout << ${0} << std::endl;"),
  ],
  csharp: [
    s("cw", "Console.WriteLine", "Console.WriteLine(${0});"),
    s("prop", "Property", "public ${1:int} ${2:Name} { get; set; }"),
  ],
  ruby: [s("def", "Method", "def ${1:name}${2}", "  ${0}", "end")],
  php: [s("fn", "Function", "function ${1:name}(${2}): ${3:void}", "{", "    ${0}", "}")],
};

/** User snippets by language id ("global": every language). */
let userSnippets: Record<string, Snippet[]> = {};

function snippetsDir(): string | null {
  const settings = useSettingsStore.getState().filePath;
  if (!settings) return null;
  const separator = settings.includes("\\") ? "\\" : "/";
  return settings.slice(0, settings.lastIndexOf(separator)) + separator + "snippets";
}

export function isSnippetsFile(path: string): boolean {
  const dir = snippetsDir();
  return !!dir && path.startsWith(dir) && path.endsWith(".json");
}

/** VS Code's snippet files allow comments and trailing commas. */
function parseLenient(text: string): unknown {
  const withoutComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string) => string ?? "");
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1"));
}

/** VS Code's format: { "Name": { "prefix": "x" | ["x", …], "body": "…" | ["…"], "description": "…" } }. */
export function parseSnippetFile(text: string): Snippet[] {
  const json = parseLenient(text) as Record<string, { prefix?: string | string[]; body?: string | string[]; description?: string }>;
  const snippets: Snippet[] = [];
  for (const [name, entry] of Object.entries(json ?? {})) {
    if (!entry || entry.body === undefined || entry.prefix === undefined) continue;
    const body = Array.isArray(entry.body) ? entry.body.join("\n") : entry.body;
    for (const prefix of Array.isArray(entry.prefix) ? entry.prefix : [entry.prefix]) {
      snippets.push({ prefix, body, description: entry.description ?? name });
    }
  }
  return snippets;
}

export async function reloadSnippets(): Promise<void> {
  const dir = snippetsDir();
  if (!dir) return;
  const next: Record<string, Snippet[]> = {};
  const entries = await readDirectory(dir).catch(() => []);
  for (const entry of entries.filter((candidate) => candidate.name.endsWith(".json"))) {
    try {
      next[entry.name.replace(/\.json$/, "")] = parseSnippetFile(await readFile(entry.path));
    } catch (error) {
      useUiStore.getState().showStatus(`Snippets: ${entry.name} isn't valid JSON (${String(error).slice(0, 80)})`);
    }
  }
  userSnippets = next;
}

const EXAMPLE = (language: string) => `{
  // Your ${language} snippets. Type the prefix, then pick it from the
  // completion list; Tab moves through $1, $2… and ends at $0.
  // ("global.json" in this folder applies to every language.)
  "Example": {
    "prefix": "hello",
    "body": ["// Hello from \${1:Sable}!", "$0"],
    "description": "An example snippet"
  }
}
`;

/** Open (creating if needed) the snippets file for the current file's language. */
export async function configureSnippets(language: string | null): Promise<void> {
  const dir = snippetsDir();
  if (!dir) return;
  const name = language ?? "global";
  const separator = dir.includes("\\") ? "\\" : "/";
  const path = `${dir}${separator}${name}.json`;
  await createDirectory(dir).catch(() => {});
  const exists = await readFile(path).then(
    () => true,
    () => false,
  );
  if (!exists) await writeFile(path, EXAMPLE(name));
  await useTabsStore.getState().openFile(path);
  useUiStore.getState().showStatus(`${name} snippets — they take effect when you save`);
}

export function registerSnippets(monaco: Monaco) {
  void reloadSnippets();
  // Settings load (and so the snippets folder is known) after startup.
  useSettingsStore.subscribe((state, previous) => {
    if (state.filePath !== previous.filePath) void reloadSnippets();
  });
  monaco.languages.registerCompletionItemProvider("*", {
    provideCompletionItems: (model, position) => {
      const language = model.getLanguageId();
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const make = (snippet: Snippet, user: boolean): MonacoTypes.languages.CompletionItem => ({
        label: { label: snippet.prefix, description: snippet.description },
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: snippet.body,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        documentation: { value: "```\n" + snippet.body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\d+/g, "") + "\n```" },
        detail: user ? "User snippet" : "Snippet",
        range,
        sortText: `~${snippet.prefix}`,
      });
      return {
        suggestions: [
          ...(BUILTIN[language] ?? []).map((snippet) => make(snippet, false)),
          ...(userSnippets[language] ?? []).map((snippet) => make(snippet, true)),
          ...(userSnippets.global ?? []).map((snippet) => make(snippet, true)),
        ],
      };
    },
  });
}

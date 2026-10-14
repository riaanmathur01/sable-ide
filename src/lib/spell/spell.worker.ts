/// <reference lib="webworker" />
/**
 * The spell-check worker: loads the dictionary (expanding the Hunspell
 * files takes a few hundred milliseconds — off the UI thread) and answers
 * "which of these words are misspelled?" and "what could this word be?".
 * The editor side (spellMonaco.ts) decides what to check and draws the
 * squiggles.
 */
import { Dictionary } from "./dictionary";
import { expandDictionary, parseAffixFile } from "./hunspell";
import { PROGRAMMING_TERMS } from "./programmingTerms";

export interface DictionaryUrls {
  aff: string;
  dic: string;
  /** Plain or gzipped word lists (one word per line, cspell's format). */
  terms: string[];
}

export type SpellRequest =
  | { id: number; type: "load"; language: string; urls: DictionaryUrls }
  | { id: number; type: "check"; language: string; words: string[] }
  | { id: number; type: "suggest"; language: string; word: string };

export type SpellResponse =
  | { id: number; ok: true; unknown?: string[]; suggestions?: string[] }
  | { id: number; ok: false; error: string };

const dictionaries = new Map<string, Promise<Dictionary>>();

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load ${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A .gz file (unless the server already unzipped it).
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

/** Words from a cspell word list: comments and forbidden words (`!word`) left out. */
function wordList(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("!")) continue;
    for (const word of line.split(/\s+/)) {
      const clean = word.replace(/^[+*~]+|[+*~]+$/g, "");
      if (clean) words.push(clean);
    }
  }
  return words;
}

async function load(urls: DictionaryUrls): Promise<Dictionary> {
  const [aff, dic, ...termLists] = await Promise.all([fetchText(urls.aff), fetchText(urls.dic), ...urls.terms.map(fetchText)]);
  const english = expandDictionary(parseAffixFile(aff), dic);
  const terms = [...PROGRAMMING_TERMS.split(/\s+/).filter(Boolean), ...termLists.flatMap(wordList)];
  return new Dictionary(english, terms);
}

function dictionaryFor(language: string): Promise<Dictionary> {
  const dictionary = dictionaries.get(language);
  if (!dictionary) throw new Error(`Dictionary ${language} isn't loaded`);
  return dictionary;
}

self.onmessage = async (event: MessageEvent<SpellRequest>) => {
  const request = event.data;
  const reply = (response: SpellResponse) => (self as unknown as Worker).postMessage(response);
  try {
    switch (request.type) {
      case "load":
        if (!dictionaries.has(request.language)) {
          const loading = load(request.urls);
          dictionaries.set(request.language, loading);
          // A failed load can be retried.
          loading.catch(() => dictionaries.delete(request.language));
        }
        await dictionaries.get(request.language);
        reply({ id: request.id, ok: true });
        break;
      case "check": {
        const dictionary = await dictionaryFor(request.language);
        reply({ id: request.id, ok: true, unknown: request.words.filter((word) => !dictionary.has(word)) });
        break;
      }
      case "suggest": {
        const dictionary = await dictionaryFor(request.language);
        reply({ id: request.id, ok: true, suggestions: dictionary.suggest(request.word) });
        break;
      }
    }
  } catch (error) {
    reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

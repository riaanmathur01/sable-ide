import { normalizeWord } from "./words";
import { suggest, type SuggestionSource } from "./suggest";
import type { ExpandedDictionary } from "./hunspell";

/**
 * A loaded word list: English words plus programming terms. Lookups are
 * case-insensitive (like cspell's default), so `Profile` in
 * `getUserProfileId` matches "profile".
 */
export class Dictionary {
  private readonly known = new Set<string>();
  /** The programming terms (their plurals count too: "configs"). */
  private readonly terms = new Set<string>();
  private readonly source: SuggestionSource;

  constructor(english: ExpandedDictionary, extraTerms: Iterable<string> = []) {
    const byLength = new Map<number, string[]>();
    const displayForm = new Map<string, string>();
    const lowerForms = new Set<string>();
    const add = (word: string, suggestible: boolean) => {
      const lower = normalizeWord(word);
      if (!lower) return;
      if (word === lower) lowerForms.add(lower);
      else if (!lowerForms.has(lower) && !displayForm.has(lower)) displayForm.set(lower, word);
      if (this.known.has(lower)) return;
      this.known.add(lower);
      if (!suggestible) return;
      const list = byLength.get(lower.length);
      if (list) list.push(lower);
      else byLength.set(lower.length, [lower]);
    };
    for (const word of english.words) add(word, true);
    // Terms are accepted but not suggested ("readdir" shouldn't replace "reader").
    for (const term of extraTerms) {
      add(term, false);
      this.terms.add(normalizeWord(term));
    }
    // A word written in lower case anywhere isn't a proper noun.
    for (const lower of lowerForms) displayForm.delete(lower);
    this.source = {
      byLength,
      displayForm,
      has: (lower) => this.known.has(lower),
      noSuggest: english.noSuggest,
      replacements: english.replacements,
    };
  }

  get size(): number {
    return this.known.size;
  }

  /** Whether a word is spelled right. */
  has(word: string): boolean {
    const lower = normalizeWord(word);
    if (this.known.has(lower)) return true;
    // Possessives and plurals of terms ("API's", "configs").
    if (lower.endsWith("'s") && this.known.has(lower.slice(0, -2))) return true;
    if (lower.endsWith("'") && this.known.has(lower.slice(0, -1))) return true;
    if (lower.endsWith("s") && this.terms.has(lower.slice(0, -1))) return true;
    return false;
  }

  suggest(word: string, count = 5): string[] {
    return suggest(normalizeWord(word), this.source, count);
  }
}

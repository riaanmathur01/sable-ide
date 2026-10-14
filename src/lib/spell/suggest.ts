/**
 * Spelling suggestions: the dictionary words closest to a misspelling,
 * by an edit distance weighted for how people actually mistype —
 * neighbouring keys, swapped letters, a doubled or missing double letter
 * and a wrong vowel all cost less than an arbitrary change. Pure; runs in
 * the spell-check worker.
 */

/** QWERTY rows, for "the finger slipped onto the next key". */
const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

const ADJACENT_KEYS: Map<string, Set<string>> = (() => {
  const position = new Map<string, [number, number]>();
  KEYBOARD_ROWS.forEach((row, rowIndex) =>
    [...row].forEach((key, column) => position.set(key, [rowIndex, column + rowIndex * 0.5])),
  );
  const adjacent = new Map<string, Set<string>>();
  for (const [key, [row, column]] of position) {
    const near = new Set<string>();
    for (const [other, [otherRow, otherColumn]] of position) {
      if (other !== key && Math.abs(otherRow - row) <= 1 && Math.abs(otherColumn - column) <= 1) near.add(other);
    }
    adjacent.set(key, near);
  }
  return adjacent;
})();

const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);

export function substitutionCost(from: string, to: string): number {
  if (from === to) return 0;
  if (ADJACENT_KEYS.get(from)?.has(to)) return 0.5;
  if (VOWELS.has(from) && VOWELS.has(to)) return 0.7;
  return 1;
}

const TRANSPOSITION_COST = 0.45;
const DOUBLE_LETTER_COST = 0.5;
/** A letter left out is the commonest slip ("functon"), so restoring one costs a little less. */
const MISSING_LETTER_COST = 0.85;

/**
 * Weighted Damerau–Levenshtein (optimal string alignment) distance from
 * what was typed to a dictionary word, both lower case. Gives up (returns
 * Infinity) once the distance must exceed `limit`.
 */
export function typoDistance(typed: string, word: string, limit = Infinity): number {
  const n = typed.length;
  const m = word.length;
  let previous2 = new Float64Array(m + 1);
  let previous = new Float64Array(m + 1);
  let current = new Float64Array(m + 1);
  const insertCost = (j: number) =>
    // Leaving out one of a double letter ("ocur" for "occur") is cheap.
    word[j] === word[j - 1] || word[j] === word[j + 1] ? DOUBLE_LETTER_COST : MISSING_LETTER_COST;
  const deleteCost = (i: number) =>
    typed[i] === typed[i - 1] || typed[i] === typed[i + 1] ? DOUBLE_LETTER_COST : 1;
  previous[0] = 0;
  for (let j = 1; j <= m; j++) previous[j] = previous[j - 1] + insertCost(j - 1);
  for (let i = 1; i <= n; i++) {
    current[0] = previous[0] + deleteCost(i - 1);
    let rowMin = current[0];
    for (let j = 1; j <= m; j++) {
      let cost = Math.min(
        previous[j] + deleteCost(i - 1),
        current[j - 1] + insertCost(j - 1),
        previous[j - 1] + substitutionCost(typed[i - 1], word[j - 1]),
      );
      if (i > 1 && j > 1 && typed[i - 1] === word[j - 2] && typed[i - 2] === word[j - 1] && typed[i - 1] !== typed[i - 2]) {
        cost = Math.min(cost, previous2[j - 2] + TRANSPOSITION_COST);
      }
      current[j] = cost;
      if (cost < rowMin) rowMin = cost;
    }
    if (rowMin > limit) return Infinity;
    [previous2, previous, current] = [previous, current, previous2];
  }
  return previous[m];
}

/** How far a suggestion may be from the typed word, by its length. */
export function distanceLimit(length: number): number {
  if (length <= 4) return 1.2;
  if (length <= 7) return 2;
  return 2.6;
}

export interface SuggestionSource {
  /** Lower-case words of each length (no duplicates). */
  byLength: Map<number, string[]>;
  /** Lower-case → the dictionary's own spelling, where it has capitals. */
  displayForm: Map<string, string>;
  has: (lowerWord: string) => boolean;
  noSuggest: Set<string>;
  replacements: [string, string][];
}

interface Scored {
  word: string;
  cost: number;
}

/**
 * Up to `count` suggestions for a misspelled word (lower case), best first.
 * Returned in the dictionary's spelling ("javascript" → "JavaScript").
 */
export function suggest(typed: string, source: SuggestionSource, count = 5): string[] {
  const lower = typed.toLowerCase();
  const limit = distanceLimit(lower.length);
  const scored = new Map<string, number>();
  const consider = (word: string, cost: number) => {
    if (word === lower || source.noSuggest.has(word)) return;
    // A wrong first letter is rarer than the rest.
    const adjusted = cost + (word[0] !== lower[0] ? 0.3 : 0);
    const best = scored.get(word);
    if (best === undefined || adjusted < best) scored.set(word, adjusted);
  };
  // Known misspelling patterns from the dictionary ("REP f ph").
  for (const [from, to] of source.replacements) {
    let index = lower.indexOf(from);
    while (index !== -1) {
      const candidate = lower.slice(0, index) + to + lower.slice(index + from.length);
      if (source.has(candidate)) consider(candidate, 0.6);
      index = lower.indexOf(from, index + 1);
    }
  }
  for (let length = Math.max(1, lower.length - 2); length <= lower.length + 2; length++) {
    for (const word of source.byLength.get(length) ?? []) {
      const cost = typoDistance(lower, word, limit);
      if (cost <= limit) consider(word, cost);
    }
  }
  const ranked: Scored[] = [...scored].map(([word, cost]) => ({ word, cost }));
  ranked.sort(
    (a, b) =>
      a.cost - b.cost ||
      // Proper nouns last when the typed word isn't capitalized.
      Number(source.displayForm.has(a.word)) - Number(source.displayForm.has(b.word)) ||
      Math.abs(a.word.length - lower.length) - Math.abs(b.word.length - lower.length) ||
      a.word.localeCompare(b.word),
  );
  return ranked.slice(0, count).map(({ word }) => source.displayForm.get(word) ?? word);
}

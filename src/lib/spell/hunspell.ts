/**
 * Expands a Hunspell dictionary (.aff + .dic) into its full list of
 * words. The English dictionaries Sable bundles (SCOWL, via the
 * `dictionary-en` / `dictionary-en-gb` packages) only use plain prefix
 * and suffix rules, so expanding them up front gives a simple word set:
 * lookups are a Set check, and suggestions can scan real words.
 *
 * Compound rules (only used for ordinals like "21st") are ignored —
 * numbers are never spell-checked.
 */

interface AffixRule {
  strip: string;
  add: string;
  condition: RegExp;
}

interface AffixClass {
  kind: "PFX" | "SFX";
  crossProduct: boolean;
  rules: AffixRule[];
}

export interface AffixFile {
  classes: Map<string, AffixClass>;
  /** Words with this flag are valid but never suggested (offensive words). */
  noSuggestFlag: string | null;
  /** Words with this flag only appear inside compounds (skipped). */
  onlyInCompoundFlag: string | null;
  /** Common misspelling → fix fragments ("REP f ph"), for suggestions. */
  replacements: [string, string][];
}

export interface ExpandedDictionary {
  /** Every word form, as written in the dictionary (case kept). */
  words: string[];
  /** Forms that must not be offered as suggestions. */
  noSuggest: Set<string>;
  replacements: [string, string][];
}

export function parseAffixFile(text: string): AffixFile {
  const classes = new Map<string, AffixClass>();
  const replacements: [string, string][] = [];
  let noSuggestFlag: string | null = null;
  let onlyInCompoundFlag: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    switch (fields[0]) {
      case "NOSUGGEST":
        noSuggestFlag = fields[1] ?? null;
        break;
      case "ONLYINCOMPOUND":
        onlyInCompoundFlag = fields[1] ?? null;
        break;
      case "REP":
        // The first REP line is the count.
        if (fields.length >= 3) replacements.push([fields[1].replace(/_/g, " "), fields[2].replace(/_/g, " ")]);
        break;
      case "PFX":
      case "SFX": {
        const kind = fields[0];
        const flag = fields[1];
        const existing = classes.get(flag);
        if (!existing) {
          // Header: PFX A Y 1
          classes.set(flag, { kind, crossProduct: fields[2] === "Y", rules: [] });
          break;
        }
        // Rule: SFX D y ied [^aeiou]y
        const strip = fields[2] === "0" ? "" : fields[2];
        const add = (fields[3] ?? "").split("/")[0];
        const condition = fields[4] ?? ".";
        existing.rules.push({
          strip,
          add: add === "0" ? "" : add,
          condition: new RegExp(kind === "SFX" ? `${condition}$` : `^${condition}`),
        });
        break;
      }
    }
  }
  return { classes, noSuggestFlag, onlyInCompoundFlag, replacements };
}

function applySuffix(word: string, rule: AffixRule): string | null {
  if (!rule.condition.test(word)) return null;
  if (rule.strip && !word.endsWith(rule.strip)) return null;
  return word.slice(0, word.length - rule.strip.length) + rule.add;
}

function applyPrefix(word: string, rule: AffixRule): string | null {
  if (!rule.condition.test(word)) return null;
  if (rule.strip && !word.startsWith(rule.strip)) return null;
  return rule.add + word.slice(rule.strip.length);
}

/** Every word form a .dic file describes, given its parsed .aff. */
export function expandDictionary(affix: AffixFile, dic: string): ExpandedDictionary {
  const words = new Set<string>();
  const noSuggest = new Set<string>();
  const lines = dic.split(/\r?\n/);
  // The first line is the entry count.
  for (let index = 1; index < lines.length; index++) {
    const entry = lines[index].split(/\s/)[0];
    if (!entry) continue;
    const slash = entry.indexOf("/");
    const stem = slash === -1 ? entry : entry.slice(0, slash);
    const flags = slash === -1 ? "" : entry.slice(slash + 1);
    if (affix.onlyInCompoundFlag && flags.includes(affix.onlyInCompoundFlag)) continue;
    // Numbers ("1st", "0th") aren't checked.
    if (/^\d/.test(stem)) continue;
    const forms: string[] = [stem];
    const prefixes: AffixClass[] = [];
    const suffixes: AffixClass[] = [];
    for (const flag of flags) {
      const affixClass = affix.classes.get(flag);
      if (affixClass?.kind === "PFX") prefixes.push(affixClass);
      else if (affixClass?.kind === "SFX") suffixes.push(affixClass);
    }
    for (const suffix of suffixes) {
      for (const rule of suffix.rules) {
        const form = applySuffix(stem, rule);
        if (!form) continue;
        forms.push(form);
        // Cross products: "un" + "do" + "ing".
        if (suffix.crossProduct) {
          for (const prefix of prefixes) {
            if (!prefix.crossProduct) continue;
            for (const prefixRule of prefix.rules) {
              const both = applyPrefix(form, prefixRule);
              if (both) forms.push(both);
            }
          }
        }
      }
    }
    for (const prefix of prefixes) {
      for (const rule of prefix.rules) {
        const form = applyPrefix(stem, rule);
        if (form) forms.push(form);
      }
    }
    const hidden = affix.noSuggestFlag !== null && flags.includes(affix.noSuggestFlag);
    for (const form of forms) {
      words.add(form);
      if (hidden) noSuggest.add(form.toLowerCase());
    }
  }
  return { words: [...words], noSuggest, replacements: affix.replacements };
}

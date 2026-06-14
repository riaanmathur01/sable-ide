/**
 * Tiny subsequence fuzzy matcher for the palette. Returns a score
 * (higher = better) when every query character appears in order, or null
 * when it doesn't match. Rewards consecutive matches and start-of-word
 * hits so "scm" ranks SourceControl high and "tab" ranks tabsStore high.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;
  let consecutive = 0;

  for (let i = 0; i < t.length && queryIndex < q.length; i++) {
    if (t[i] !== q[queryIndex]) continue;
    let charScore = 1;
    if (lastMatchIndex === i - 1) {
      consecutive += 1;
      charScore += consecutive * 3;
    } else {
      consecutive = 0;
    }
    // Boundary bonus: start of string or after a separator.
    if (i === 0 || /[/\\._\- ]/.test(t[i - 1])) charScore += 4;
    score += charScore;
    lastMatchIndex = i;
    queryIndex += 1;
  }

  return queryIndex === q.length ? score : null;
}

/**
 * Small, fast fuzzy matcher for the command palette. Scores contiguous runs, word starts
 * and prefix matches; returns matched character indices for highlighting.
 */
export interface FuzzyResult {
  score: number;
  indices: number[];
}

export function fuzzy(query: string, text: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const atWord = direct === 0 || /[\s\-_/(]/.test(t[direct - 1] ?? "");
    return {
      score: 100 + (direct === 0 ? 40 : atWord ? 20 : 0) - direct * 0.5 - (t.length - q.length) * 0.05,
      indices: Array.from({ length: q.length }, (_, i) => direct + i),
    };
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  const indices: number[] = [];
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    if (ch === " ") continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti += 1;
      run = 0;
    }
    if (found < 0) return null;
    const prev = t[found - 1] ?? " ";
    const wordStart = found === 0 || /[\s\-_/(]/.test(prev);
    run += 1;
    score += 1 + run * 1.5 + (wordStart ? 6 : 0);
    indices.push(found);
    ti = found + 1;
  }
  score -= (t.length - indices.length) * 0.04;
  return { score, indices };
}

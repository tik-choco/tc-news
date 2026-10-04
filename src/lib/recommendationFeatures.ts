import type { RecommendationCandidate } from "./recommendationTypes";

/** Bounded, normalized sparse features; no model download or network access. */
export interface RecommendationFeatures {
  readonly terms: ReadonlyMap<string, number>;
  readonly category: string;
}

const MAX_CACHE_ENTRIES = 1_200;
const MAX_TERMS = 384;
const cache = new Map<string, RecommendationFeatures>();
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "has", "have", "in",
  "is", "it", "its", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "with",
]);

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function addText(terms: Map<string, number>, text: string, weight: number): void {
  // English word boundaries preserve meaningful tokens; Japanese character
  // bigrams work without requiring a language-specific tokenizer/model.
  const found = new Set<string>();
  for (const word of normalized(text).match(/[\p{Script=Latin}\p{N}]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? []) {
    if (/^[\p{Script=Latin}\p{N}]+$/u.test(word)) {
      if (word.length > 1 && !STOP_WORDS.has(word)) found.add(`w:${word}`);
    } else {
      const characters = Array.from(word);
      if (characters.length === 1) found.add(`j:${word}`);
      for (let i = 0; i < characters.length - 1; i++) found.add(`j:${characters[i]}${characters[i + 1]}`);
    }
  }
  for (const term of found) terms.set(term, (terms.get(term) ?? 0) + weight);
}

export function recommendationFeatures(candidate: RecommendationCandidate): RecommendationFeatures {
  const title = candidate.title.slice(0, 300);
  const summary = candidate.summary.slice(0, 800);
  const tags = candidate.tags.slice(0, 12).map((tag) => tag.slice(0, 60)).sort();
  const category = normalized(candidate.category?.trim() ?? "");
  // Content, not item ID: an edited title or a later classification must
  // invalidate its features. Limit every component before making the key.
  const key = JSON.stringify([title, summary, tags, category]);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const raw = new Map<string, number>();
  addText(raw, title, 2);
  addText(raw, summary, 1);
  for (const tag of tags) addText(raw, tag, 3);
  const entries = [...raw].sort(([a, aw], [b, bw]) => bw - aw || (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_TERMS);
  const norm = Math.sqrt(entries.reduce((sum, [, value]) => sum + value * value, 0));
  const terms = new Map(entries.map(([term, value]) => [term, value / norm]));
  const result = { terms, category };
  cache.set(key, result);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return result;
}

export function featureSimilarity(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, value] of smaller) dot += value * (larger.get(term) ?? 0);
  return Math.min(1, Math.max(0, dot));
}

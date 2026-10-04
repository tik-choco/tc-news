// Persists in-progress article translations so a cancelled/interrupted
// translateArticle() run (lib/translate.ts) can resume from the last
// completed chunk instead of re-paying the LLM cost for the whole article.
// Same defensive-parsing + kvStore persistence pattern as
// translationStore.ts (that store's ArticleTranslation is the *finished*
// product shared over P2P; this one is a local-only scratch pad for
// work-in-progress, never shared — there's no wire format for "half a
// translation").
//
// Resumability hinges on sourceSig: a lightweight, non-cryptographic hash of
// the source title/excerpt/body. If the article's content changed since the
// partial was saved (e.g. the room received a newer edit), the sig no longer
// matches and translate.ts discards the stale partial rather than resuming
// into a translation of content that no longer exists.

import { loadKvRecords, persistKvRecords } from "./kvRecordStore";

// Small cap, unlike translationStore's 50: an entry here only exists
// transiently, between "translation started" and "translation finished or
// abandoned" — a handful of concurrent in-flight/paused translations across
// tabs is already generous. Kept low mainly to bound worst-case KV size,
// since chunks[] can hold most of an article body per entry.
const PARTIAL_TRANSLATIONS_KEY = "tc-news:partial-article-translations";
const MAX_PARTIAL_TRANSLATIONS = 5;

export interface PartialArticleTranslation {
  articleId: string;
  lang: string; // UI locale code (i18n Locale value)
  title: string | null; // translated title once the title/excerpt call finished
  excerpt: string | null;
  chunks: string[]; // translated chunks completed so far
  totalChunks: number;
  sourceSig: string; // signature of the source content, invalidates resume when the article changed
  updatedAt: number; // epoch ms
}

function cacheKey(articleId: string, lang: string): string {
  return `${articleId}::${lang}`;
}

function isPartialArticleTranslation(value: unknown): value is PartialArticleTranslation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.articleId === "string" &&
    typeof v.lang === "string" &&
    (v.title === null || typeof v.title === "string") &&
    (v.excerpt === null || typeof v.excerpt === "string") &&
    Array.isArray(v.chunks) &&
    v.chunks.every((c) => typeof c === "string") &&
    typeof v.totalChunks === "number" &&
    typeof v.sourceSig === "string" &&
    typeof v.updatedAt === "number"
  );
}

function coercePartialArticleTranslation(value: unknown): PartialArticleTranslation | null {
  if (!isPartialArticleTranslation(value)) return null;
  return {
    articleId: value.articleId,
    lang: value.lang,
    title: value.title,
    excerpt: value.excerpt,
    chunks: [...value.chunks],
    totalChunks: value.totalChunks,
    sourceSig: value.sourceSig,
    updatedAt: value.updatedAt,
  };
}

function loadAll(): Record<string, PartialArticleTranslation> {
  return loadKvRecords(PARTIAL_TRANSLATIONS_KEY, coercePartialArticleTranslation);
}

function persistAll(all: Record<string, PartialArticleTranslation>): void {
  persistKvRecords(PARTIAL_TRANSLATIONS_KEY, all, (record) => record.updatedAt);
}

/** The in-progress translation for articleId×lang, if any. Callers must
 * still check sourceSig/totalChunks against the current article before
 * resuming — a stale partial (source changed since it was saved) is left in
 * the store for this getter to return as-is; discarding it is the caller's
 * decision via clearPartialTranslation. */
export function getPartialTranslation(articleId: string, lang: string): PartialArticleTranslation | null {
  return loadAll()[cacheKey(articleId, lang)] ?? null;
}

/** Saves/overwrites the in-progress translation for `p.articleId`×`p.lang`.
 * Enforces MAX_PARTIAL_TRANSLATIONS by dropping the oldest (by updatedAt)
 * entries first. */
export function savePartialTranslation(p: PartialArticleTranslation): void {
  const all = loadAll();
  all[cacheKey(p.articleId, p.lang)] = p;
  const entries = Object.entries(all);
  if (entries.length > MAX_PARTIAL_TRANSLATIONS) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    persistAll(Object.fromEntries(entries.slice(0, MAX_PARTIAL_TRANSLATIONS)));
  } else {
    persistAll(all);
  }
}

/** Removes the in-progress translation for articleId×lang, if any — called
 * once translateArticle() either finishes the article or determines the
 * saved partial no longer applies (sourceSig/totalChunks mismatch). */
export function clearPartialTranslation(articleId: string, lang: string): void {
  const all = loadAll();
  const key = cacheKey(articleId, lang);
  if (!(key in all)) return;
  delete all[key];
  persistAll(all);
}

// Same FNV-1a 32-bit hash as partialFeedTranslationStore.ts's
// computeFeedTranslationSourceSig — duplicated rather than imported so this
// module has no cross-store coupling (same rationale as translate.ts
// keeping its own throwIfAborted/stripCodeFences instead of importing
// feedTranslate.ts's). Fast, deterministic, non-cryptographic: this only
// needs to detect "did the source content change since the partial was
// saved", never to resist tampering. Parts are joined with a single space
// before hashing so e.g. ["ab", "c"] and ["a", "bc"] don't collide.
export function computeTranslationSourceSig(parts: string[]): string {
  const input = parts.join(" ");
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime, wrapped to int32 by Math.imul
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

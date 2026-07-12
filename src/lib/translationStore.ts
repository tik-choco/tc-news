// Local read-through cache for translated article content, keyed by
// articleId×lang. Populated either by a local translateArticle() LLM call or
// by a received tc-news:translation wire (see hooks/useNewsRoom.ts) — either
// way, once a translation lands here, no peer needs to re-run the LLM for
// the same article×language pair. Same defensive-parsing persistence
// pattern as articleEvaluation.ts, but keyed flat (not per-room): a
// translation is useful regardless of which room/tab it was first seen in.
// Persisted via kvStore (mist KV, OPFS-backed; localStorage only as a
// pre-hydration/fallback path — see kvStore.ts's module header).

import { KV_VALUE_SOFT_LIMIT_BYTES, kvGetSync, kvSetSync, utf8ByteLength } from "./kvStore";

// Quota guard: this store persists full translated article bodies, so it's
// one of the larger consumers of storage among tc-news's cache keys. Two
// limits keep its footprint bounded: MAX_TRANSLATIONS caps the entry count
// (500 -> 50 — translations are expensive to recompute via LLM, but 50
// recent article×lang pairs is plenty for a reading session), and
// MAX_PERSISTED_BODY_CHARS drops any single translation whose body exceeds
// it from persistence entirely — an oversized translation (a very long
// article) is still returned in-memory to the caller for this call, it's
// just not durable across reloads. Worst case persisted size: 50 × 15,000
// chars = 750,000 chars (~1.5MB in UTF-16) for body alone; in practice most
// translations are far shorter. persistAll() below adds a second, byte-level
// safety net on top of these char-count limits: the mist KV rejects any
// single value over ~1MiB, so persistAll trims oldest-first until the
// serialized blob is back under KV_VALUE_SOFT_LIMIT_BYTES, covering cases
// (e.g. multi-byte UTF-8 content) where the char-count limits above don't
// by themselves guarantee a small enough byte size.
const TRANSLATIONS_KEY = "tc-news:translations";
const MAX_TRANSLATIONS = 50;
const MAX_PERSISTED_BODY_CHARS = 15_000;

export interface ArticleTranslation {
  id: string; // 共有時はwire id、ローカルのみの翻訳は生成id
  articleId: string;
  lang: string;
  title: string;
  excerpt: string;
  body: string;
  translatorDid: string;
  translatorName: string;
  translatedAt: number; // epoch ms
  cid?: string; // P2P共有済みの場合のみ設定
}

function cacheKey(articleId: string, lang: string): string {
  return `${articleId}::${lang}`;
}

function newTranslationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `translation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function isArticleTranslation(value: unknown): value is ArticleTranslation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.articleId === "string" &&
    typeof v.lang === "string" &&
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    typeof v.translatorDid === "string" &&
    typeof v.translatedAt === "number"
  );
}

function coerceArticleTranslation(value: unknown): ArticleTranslation | null {
  if (!isArticleTranslation(value)) return null;
  return {
    id: value.id,
    articleId: value.articleId,
    lang: value.lang,
    title: value.title,
    excerpt: typeof value.excerpt === "string" ? value.excerpt : "",
    body: value.body,
    translatorDid: value.translatorDid,
    translatorName: typeof value.translatorName === "string" ? value.translatorName : "",
    translatedAt: value.translatedAt,
    cid: typeof value.cid === "string" ? value.cid : undefined,
  };
}

function loadAll(): Record<string, ArticleTranslation> {
  try {
    const raw = kvGetSync(TRANSLATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ArticleTranslation> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const record = coerceArticleTranslation(v);
      if (record) out[k] = record;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAll(all: Record<string, ArticleTranslation>): void {
  // Second safety net (see module header comment): MAX_TRANSLATIONS /
  // MAX_PERSISTED_BODY_CHARS above already bound the typical payload by
  // char count, but the mist KV rejects any single value over ~1MiB. Trim
  // oldest-first (by translatedAt) until the serialized blob's UTF-8 byte
  // length is back under the soft limit, so this store can never itself
  // produce a KV write that's rejected outright.
  let entries = Object.entries(all);
  let serialized = JSON.stringify(Object.fromEntries(entries));
  while (entries.length > 0 && utf8ByteLength(serialized) > KV_VALUE_SOFT_LIMIT_BYTES) {
    entries = entries.sort((a, b) => b[1].translatedAt - a[1].translatedAt).slice(0, -1);
    serialized = JSON.stringify(Object.fromEntries(entries));
  }
  kvSetSync(TRANSLATIONS_KEY, serialized);
}

/** 記事×言語の翻訳(あれば)。無ければnull — 呼び出し側はLLM翻訳を実行する合図として使う。 */
export function getTranslation(articleId: string, lang: string): ArticleTranslation | null {
  return loadAll()[cacheKey(articleId, lang)] ?? null;
}

/**
 * 翻訳を保存する。id未指定ならローカル生成(P2P未共有の翻訳用)。上限件数を超えたら
 * 古いエントリから間引く。
 */
export function saveTranslation(record: Omit<ArticleTranslation, "id"> & { id?: string }): ArticleTranslation {
  const full: ArticleTranslation = { ...record, id: record.id ?? newTranslationId() };
  const all = loadAll();
  all[cacheKey(full.articleId, full.lang)] = full;
  // Drop oversized bodies from persistence (see module header comment) —
  // applies to every entry, not just the one just saved, since an entry
  // loaded from an earlier (pre-guard) persisted blob could still exceed
  // the cap.
  const persistable = Object.entries(all).filter(([, t]) => t.body.length <= MAX_PERSISTED_BODY_CHARS);
  if (persistable.length > MAX_TRANSLATIONS) {
    persistable.sort((a, b) => b[1].translatedAt - a[1].translatedAt);
    persistAll(Object.fromEntries(persistable.slice(0, MAX_TRANSLATIONS)));
  } else {
    persistAll(Object.fromEntries(persistable));
  }
  return full;
}

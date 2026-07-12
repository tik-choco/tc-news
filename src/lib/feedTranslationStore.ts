// Local read-through cache for translated FeedItem content, keyed by
// itemId×lang. Unlike translationStore.ts's article translations, these are
// never shared over P2P — a feed-item translation is a purely local
// convenience so the same item×language pair doesn't re-run the LLM every
// time the feed re-renders. Same defensive-parsing persistence pattern as
// translationStore.ts, but with a much smaller entry cap: each record can
// embed the full extracted-page HTML (see pageExtract.ts's cache, which
// caps at 30 for the same reason), so 500 entries' worth would be far too
// large a single value. Persisted via kvStore (mist KV, OPFS-backed;
// localStorage only as a pre-hydration/fallback path — see kvStore.ts's
// module header).

import { kvGetSync, kvSetSync } from "./kvStore";

const FEED_TRANSLATIONS_KEY = "tc-news:feed-translations";
const MAX_FEED_TRANSLATIONS = 20;

export interface FeedItemTranslation {
  itemId: string; // FeedItem.id
  lang: string; // UI locale the translation targets (lib/i18n Locale value)
  title: string;
  summary: string;
  html: string | null; // translated extracted-page HTML, or null when none was available at translate time
  truncated: boolean; // translation was cut short by feedTranslate's input cap
  translatedAt: number; // epoch ms
}

function cacheKey(itemId: string, lang: string): string {
  return `${itemId}::${lang}`;
}

function isFeedItemTranslation(value: unknown): value is FeedItemTranslation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.itemId === "string" &&
    typeof v.lang === "string" &&
    typeof v.title === "string" &&
    typeof v.summary === "string" &&
    (typeof v.html === "string" || v.html === null) &&
    typeof v.translatedAt === "number"
  );
}

function coerceFeedItemTranslation(value: unknown): FeedItemTranslation | null {
  if (!isFeedItemTranslation(value)) return null;
  return {
    itemId: value.itemId,
    lang: value.lang,
    title: value.title,
    summary: value.summary,
    html: value.html,
    truncated: typeof value.truncated === "boolean" ? value.truncated : false,
    translatedAt: value.translatedAt,
  };
}

function loadAll(): Record<string, FeedItemTranslation> {
  try {
    const raw = kvGetSync(FEED_TRANSLATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, FeedItemTranslation> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const record = coerceFeedItemTranslation(v);
      if (record) out[k] = record;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAll(all: Record<string, FeedItemTranslation>): void {
  kvSetSync(FEED_TRANSLATIONS_KEY, JSON.stringify(all));
}

/** フィードアイテム×言語の翻訳(あれば)。無ければnull — 呼び出し側はLLM翻訳を実行する合図として使う。 */
export function getFeedTranslation(itemId: string, lang: string): FeedItemTranslation | null {
  return loadAll()[cacheKey(itemId, lang)] ?? null;
}

/**
 * 翻訳を保存する。上限件数を超えたら古いエントリ(translatedAtが古い順)から間引く。
 */
export function saveFeedTranslation(record: FeedItemTranslation): void {
  const all = loadAll();
  all[cacheKey(record.itemId, record.lang)] = record;
  const entries = Object.entries(all);
  if (entries.length > MAX_FEED_TRANSLATIONS) {
    entries.sort((a, b) => b[1].translatedAt - a[1].translatedAt);
    persistAll(Object.fromEntries(entries.slice(0, MAX_FEED_TRANSLATIONS)));
  } else {
    persistAll(all);
  }
}

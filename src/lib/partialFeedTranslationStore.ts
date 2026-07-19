// Local, ephemeral store for in-progress feed-item HTML translations, keyed
// by itemId×lang — lets feedTranslate.ts resume a chunk-by-chunk translation
// job after a reload/crash/tab-close mid-job instead of restarting the whole
// (possibly many-chunk, many-LLM-call) job from scratch. Distinct from
// feedTranslationStore.ts's FeedItemTranslation cache: that one holds a
// *finished* translation persisted indefinitely (cap 20, cleared only by
// eviction); this one holds a job-in-flight snapshot that feedTranslate.ts
// itself clears the moment the job completes (or is abandoned via a
// sourceSig mismatch), and exists purely so an interrupted job doesn't lose
// chunks it already paid an LLM call for. Same defensive-parsing + kvStore
// persistence pattern as feedTranslationStore.ts, but with an even smaller
// entry cap (3, not 20): a record embeds every translated chunk completed so
// far — comparable in size to a full FeedItemTranslation's html — and
// there's realistically never more than a couple of these jobs in flight at
// once (a user reads one feed item's translation at a time), so a small cap
// still comfortably covers real usage while bounding worst-case KV size.
// Persisted via kvStore (mist KV, OPFS-backed; localStorage only as a
// pre-hydration/fallback path — see kvStore.ts's module header).

import { KV_VALUE_SOFT_LIMIT_BYTES, kvGetSync, kvSetSync, utf8ByteLength } from "./kvStore";

const PARTIAL_FEED_TRANSLATIONS_KEY = "tc-news:partial-feed-translations";
const MAX_PARTIAL_FEED_TRANSLATIONS = 3;

export interface PartialFeedTranslation {
  itemId: string; // FeedItem.id
  lang: string; // UI locale code (lib/i18n Locale value)
  title: string | null; // translated title once the title/summary call finished
  summary: string | null;
  chunks: string[]; // translated (fence-stripped, unsanitized-joined) chunks completed so far
  totalChunks: number;
  truncated: boolean; // input html exceeded MAX_TRANSLATE_HTML_CHARS
  sourceSig: string; // signature of the source content; invalidates resume when the page changed
  updatedAt: number; // epoch ms
}

function cacheKey(itemId: string, lang: string): string {
  return `${itemId}::${lang}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isPartialFeedTranslation(value: unknown): value is PartialFeedTranslation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.itemId === "string" &&
    typeof v.lang === "string" &&
    (typeof v.title === "string" || v.title === null) &&
    (typeof v.summary === "string" || v.summary === null) &&
    isStringArray(v.chunks) &&
    typeof v.totalChunks === "number" &&
    typeof v.sourceSig === "string" &&
    typeof v.updatedAt === "number"
  );
}

function coercePartialFeedTranslation(value: unknown): PartialFeedTranslation | null {
  if (!isPartialFeedTranslation(value)) return null;
  return {
    itemId: value.itemId,
    lang: value.lang,
    title: value.title,
    summary: value.summary,
    chunks: value.chunks,
    totalChunks: value.totalChunks,
    truncated: typeof value.truncated === "boolean" ? value.truncated : false,
    sourceSig: value.sourceSig,
    updatedAt: value.updatedAt,
  };
}

function loadAll(): Record<string, PartialFeedTranslation> {
  try {
    const raw = kvGetSync(PARTIAL_FEED_TRANSLATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, PartialFeedTranslation> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const record = coercePartialFeedTranslation(v);
      if (record) out[k] = record;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAll(all: Record<string, PartialFeedTranslation>): void {
  // Same byte-level safety net as translationStore.ts's persistAll: the mist
  // KV rejects any single value over ~1MiB, and MAX_PARTIAL_FEED_TRANSLATIONS
  // alone doesn't bound byte size (a single in-progress job can already carry
  // close to MAX_TRANSLATE_HTML_CHARS worth of chunk text). Trim oldest-first
  // (by updatedAt) until the serialized blob is back under the soft limit.
  let entries = Object.entries(all);
  let serialized = JSON.stringify(Object.fromEntries(entries));
  while (entries.length > 0 && utf8ByteLength(serialized) > KV_VALUE_SOFT_LIMIT_BYTES) {
    entries = entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, -1);
    serialized = JSON.stringify(Object.fromEntries(entries));
  }
  kvSetSync(PARTIAL_FEED_TRANSLATIONS_KEY, serialized);
}

/** フィードアイテム×言語の途中保存済み翻訳(あれば)。無ければnull — 呼び出し側は
 * フルの翻訳ジョブを新規に開始する合図として使う。 */
export function getPartialFeedTranslation(itemId: string, lang: string): PartialFeedTranslation | null {
  return loadAll()[cacheKey(itemId, lang)] ?? null;
}

/**
 * 途中保存を書き込む(または上書きする)。上限件数を超えたら updatedAt が古い順に間引く。
 */
export function savePartialFeedTranslation(p: PartialFeedTranslation): void {
  const all = loadAll();
  all[cacheKey(p.itemId, p.lang)] = p;
  const entries = Object.entries(all);
  if (entries.length > MAX_PARTIAL_FEED_TRANSLATIONS) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    persistAll(Object.fromEntries(entries.slice(0, MAX_PARTIAL_FEED_TRANSLATIONS)));
  } else {
    persistAll(all);
  }
}

/** ジョブ完了時、またはsourceSig不一致で再開を諦めるときに呼ぶ。 */
export function clearPartialFeedTranslation(itemId: string, lang: string): void {
  const all = loadAll();
  const key = cacheKey(itemId, lang);
  if (!(key in all)) return;
  delete all[key];
  persistAll(all);
}

// Ported from translationStore.ts's own copy of the same algorithm (that
// module needs an equivalent signature to detect stale resumable state) —
// duplicated rather than imported so this module has no cross-store
// coupling, same rationale as feedTranslate.ts's extractJson/stripCodeFences
// being local copies instead of shared imports. FNV-1a 32-bit: fast,
// deterministic, non-cryptographic — this only needs to detect "did the
// source content change since the partial was saved", never to resist
// tampering. Parts are joined with a single space before hashing so e.g.
// (["ab", "c"]) and (["a", "bc"]) don't collide.
export function computeFeedTranslationSourceSig(parts: string[]): string {
  const input = parts.join(" ");
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime, wrapped to int32 by Math.imul
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

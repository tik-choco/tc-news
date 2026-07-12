// Persistence for feed sources and collected feed items. Parsed defensively
// (never trust stored content) — same pattern as tc-town's appSettings.ts.
// feed-items is the bulky one (up to MAX_FEED_ITEMS entries with summaries)
// so it lives in the mist KV (see lib/kvStore.ts) instead of localStorage;
// the feeds list itself is small and stays in localStorage.
import type { FeedItem, FeedSource } from "../types";
import { safeSetItem } from "./safeStorage";
import { kvGetSync, kvSetSync, KV_VALUE_SOFT_LIMIT_BYTES, utf8ByteLength } from "./kvStore";

const FEEDS_KEY = "tc-news:feeds";
const FEED_ITEMS_KEY = "tc-news:feed-items";
const MAX_FEED_ITEMS = 500;

// 既定フィードは同梱しない: 特定の配信元の名称・URLを公開リポジトリに
// ハードコードしないポリシー。フィードはユーザーが自分で登録する。

function coerceFeedSource(value: unknown): FeedSource | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.url !== "string") return null;
  return {
    id: s.id,
    url: s.url,
    label: typeof s.label === "string" ? s.label : s.url,
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
    addedAt: typeof s.addedAt === "number" ? s.addedAt : Date.now(),
  };
}

function coerceFeedItem(value: unknown): FeedItem | null {
  if (!value || typeof value !== "object") return null;
  const i = value as Record<string, unknown>;
  if (typeof i.id !== "string" || typeof i.link !== "string") return null;
  const item: FeedItem = {
    id: i.id,
    feedId: typeof i.feedId === "string" ? i.feedId : "",
    feedLabel: typeof i.feedLabel === "string" ? i.feedLabel : "",
    title: typeof i.title === "string" ? i.title : "",
    link: i.link,
    summary: typeof i.summary === "string" ? i.summary : "",
    publishedAt: typeof i.publishedAt === "number" ? i.publishedAt : 0,
    fetchedAt: typeof i.fetchedAt === "number" ? i.fetchedAt : 0,
  };
  if (typeof i.imageUrl === "string" && i.imageUrl) item.imageUrl = i.imageUrl;
  if (typeof i.videoUrl === "string" && i.videoUrl) item.videoUrl = i.videoUrl;
  if (typeof i.category === "string" && i.category) item.category = i.category;
  return item;
}

export function loadFeeds(): FeedSource[] {
  try {
    const raw = localStorage.getItem(FEEDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceFeedSource).filter((f): f is FeedSource => f !== null);
  } catch {
    return [];
  }
}

export function saveFeeds(feeds: FeedSource[]): void {
  safeSetItem(FEEDS_KEY, JSON.stringify(feeds));
}

export function loadFeedItems(): FeedItem[] {
  try {
    const raw = kvGetSync(FEED_ITEMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceFeedItem).filter((i): i is FeedItem => i !== null);
  } catch {
    return [];
  }
}

/** Floor for the halve-and-retry degradation in saveFeedItems — below this,
 * further shrinking isn't worth the loss of feed history. */
const MIN_FEED_ITEMS = 50;

/** Persists items sorted by publishedAt descending, capped at MAX_FEED_ITEMS.
 * The mist KV rejects/soft-caps values above KV_VALUE_SOFT_LIMIT_BYTES
 * (lib/kvStore.ts) — if the serialized blob is still over that after the
 * MAX_FEED_ITEMS cap, degrade by halving the item count and re-measuring,
 * down to MIN_FEED_ITEMS — trading feed history for a write that actually
 * fits. If even MIN_FEED_ITEMS doesn't fit, save it anyway (kvSetSync itself
 * never rejects a write; the backend's own limit is the last resort). */
export function saveFeedItems(items: FeedItem[]): void {
  let toSave = [...items].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_FEED_ITEMS);
  let serialized = JSON.stringify(toSave);
  while (utf8ByteLength(serialized) > KV_VALUE_SOFT_LIMIT_BYTES && toSave.length > MIN_FEED_ITEMS) {
    toSave = toSave.slice(0, Math.max(MIN_FEED_ITEMS, Math.floor(toSave.length / 2)));
    serialized = JSON.stringify(toSave);
  }
  kvSetSync(FEED_ITEMS_KEY, serialized);
}

/** Merges incoming items into existing, de-duplicating by id (incoming wins,
 * so re-fetching a feed refreshes stale metadata for the same item) — except
 * `category`, which is enrichment applied after the fact by feedClassify.ts
 * and never present on freshly-parsed RSS items. Incoming items always carry
 * `category: undefined`, so a naive overwrite would silently wipe every
 * classification on the next refresh; fall back to the previous value instead. */
export function mergeFeedItems(existing: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  const byId = new Map<string, FeedItem>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of incoming) {
    const prev = byId.get(item.id);
    byId.set(item.id, prev ? { ...item, category: item.category ?? prev.category } : item);
  }
  return Array.from(byId.values());
}

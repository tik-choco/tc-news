// Imports a feed URL shared by another peer (see hooks/useNewsRoom.ts's
// shareFeed / FeedShareWire in lib/newsWire.ts) into the local feed list.
// Purely local: FeedSource lives in lib/feedStore.ts (localStorage), so once
// a feed-share wire has already arrived and been signature-verified by the
// room hook, "importing" it is just a dedupe-then-append against the user's
// own feeds.
import type { FeedSource } from "../types";
import { loadFeeds, saveFeeds } from "./feedStore";

/**
 * Loose normalization for duplicate detection: trims whitespace and any
 * trailing slash(es), so "https://example.com/feed" and
 * "https://example.com/feed/" are treated as the same feed. Deliberately
 * doesn't touch case or query strings — a feed URL differing only by those is
 * rare enough that folding them in risks more false-positive dedupes than it
 * prevents.
 */
function normalizeFeedUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface ImportSharedFeedResult {
  imported: boolean;
  reason?: "duplicate";
}

/**
 * Adds a peer-shared feed URL to the local feed list (lib/feedStore.ts),
 * de-duping against already-registered feeds by normalized URL. On success,
 * dispatches "tc-news:feeds-updated" so any live useFeeds() instance picks up
 * the new feed without a reload (see hooks/useFeeds.ts's listener for that
 * event — this module is the "other code path" its comment refers to).
 */
export function importSharedFeed(url: string, label: string): ImportSharedFeedResult {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return { imported: false };
  const normalized = normalizeFeedUrl(trimmedUrl);
  const feeds = loadFeeds();
  if (feeds.some((f) => normalizeFeedUrl(f.url) === normalized)) {
    return { imported: false, reason: "duplicate" };
  }
  const feed: FeedSource = {
    id: crypto.randomUUID(),
    url: trimmedUrl,
    label: label.trim() || trimmedUrl,
    enabled: true,
    addedAt: Date.now(),
  };
  saveFeeds([...feeds, feed]);
  window.dispatchEvent(new CustomEvent("tc-news:feeds-updated"));
  return { imported: true };
}

/** Whether `url` is already present among the locally-registered feeds
 * (same normalization as importSharedFeed's dedupe check). Used by SharedView
 * to render "already imported" instead of an active import button. */
export function isFeedAlreadyImported(url: string): boolean {
  const normalized = normalizeFeedUrl(url);
  return loadFeeds().some((f) => normalizeFeedUrl(f.url) === normalized);
}

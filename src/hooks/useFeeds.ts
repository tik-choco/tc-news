// Feed subscription management + polling. Owns the feeds/items localStorage
// round-trip so views just consume state.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AppSettings, FeedItem, FeedSource } from "../types";
import { fetchFeedItems } from "../lib/rss";
import { classifyFeedItems } from "../lib/feedClassify";
import { loadFeedItems, loadFeeds, mergeFeedItems, saveFeedItems, saveFeeds } from "../lib/feedStore";
import { subscribeKvHydrated } from "../lib/kvStore";

export function useFeeds(settings: AppSettings): {
  feeds: FeedSource[];
  addFeed(url: string, label?: string): void;
  removeFeed(id: string): void;
  toggleFeed(id: string): void;
  updateFeed(id: string, patch: { url?: string; label?: string }): void;
  items: FeedItem[];
  refreshing: boolean;
  refreshAll(): Promise<FeedItem[]>;
  lastRefreshedAt: number | null;
  errors: Record<string, string>;
} {
  const [feeds, setFeeds] = useState<FeedSource[]>(() => loadFeeds());
  const [items, setItems] = useState<FeedItem[]>(() => loadFeedItems());
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Refs mirror state so refreshAll always sees the latest values without
  // needing to be recreated (and re-triggering the interval effect) on
  // every feeds/items change.
  const feedsRef = useRef(feeds);
  feedsRef.current = feeds;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const refreshingRef = useRef(false);
  const corsProxyRef = useRef(settings.corsProxy);
  corsProxyRef.current = settings.corsProxy;
  // Guards classification so only one batch is ever in flight; a refresh
  // that lands mid-classification just skips it, and the next refresh picks
  // up whatever is still unclassified.
  const classifyingRef = useRef(false);

  const refreshAll = useCallback(async (): Promise<FeedItem[]> => {
    if (refreshingRef.current) return [];
    refreshingRef.current = true;
    setRefreshing(true);

    const targets = feedsRef.current.filter((f) => f.enabled);
    const results = await Promise.allSettled(
      targets.map((f) => fetchFeedItems(f, corsProxyRef.current)),
    );

    const existingIds = new Set(itemsRef.current.map((i) => i.id));
    const incoming: FeedItem[] = [];
    const nextErrors: Record<string, string> = {};

    results.forEach((result, idx) => {
      const feed = targets[idx];
      if (result.status === "fulfilled") {
        incoming.push(...result.value);
      } else {
        const reason = result.reason;
        nextErrors[feed.id] = reason instanceof Error ? reason.message : String(reason);
      }
    });

    const newItems = incoming.filter((i) => !existingIds.has(i.id));
    const merged = mergeFeedItems(itemsRef.current, incoming);
    saveFeedItems(merged);
    const persisted = loadFeedItems();

    setItems(persisted);
    setErrors(nextErrors);
    setLastRefreshedAt(Date.now());
    refreshingRef.current = false;
    setRefreshing(false);

    // Fire-and-forget best-effort categorization of whatever is still
    // uncategorized, one batched call per refresh. Applied onto the current
    // items ref (not the `persisted` snapshot above) since items may have
    // changed by the time the LLM call resolves.
    const unclassified = persisted.filter((i) => !i.category);
    if (unclassified.length > 0 && !classifyingRef.current) {
      classifyingRef.current = true;
      void (async () => {
        try {
          const map = await classifyFeedItems(unclassified, "");
          if (map.size === 0) return;
          const withCategories = itemsRef.current.map((item) => {
            const category = map.get(item.id);
            return category ? { ...item, category } : item;
          });
          saveFeedItems(withCategories);
          setItems(loadFeedItems());
        } finally {
          classifyingRef.current = false;
        }
      })();
    }

    return newItems;
  }, []);

  // Refresh once on mount.
  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `items` was seeded from loadFeedItems() before the mist KV finished
  // hydrating (lib/kvStore.ts) — pre-hydration reads fall back to
  // localStorage, which is empty once a previous session has migrated its
  // data into the KV. Re-read once hydration replaces that fallback so
  // history from earlier sessions actually shows up.
  useEffect(() => subscribeKvHydrated(() => setItems(loadFeedItems())), []);

  // Periodic refresh when enabled.
  useEffect(() => {
    if (!settings.refreshIntervalMin || settings.refreshIntervalMin <= 0) return;
    const ms = settings.refreshIntervalMin * 60 * 1000;
    const timer = setInterval(() => {
      refreshAll();
    }, ms);
    return () => clearInterval(timer);
  }, [settings.refreshIntervalMin, refreshAll]);

  const addFeed = useCallback((url: string, label?: string) => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    const feed: FeedSource = {
      id: crypto.randomUUID(),
      url: trimmedUrl,
      label: label?.trim() || trimmedUrl,
      enabled: true,
      addedAt: Date.now(),
    };
    setFeeds((prev) => {
      const next = [...prev, feed];
      saveFeeds(next);
      return next;
    });
  }, []);

  const removeFeed = useCallback((id: string) => {
    setFeeds((prev) => {
      const next = prev.filter((f) => f.id !== id);
      saveFeeds(next);
      return next;
    });
  }, []);

  const toggleFeed = useCallback((id: string) => {
    setFeeds((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f));
      saveFeeds(next);
      return next;
    });
  }, []);

  // Items already fetched keep the feedId they were created with, so
  // changing a feed's URL here only affects what gets fetched on future
  // refreshes, not any items already in the store.
  const updateFeed = useCallback((id: string, patch: { url?: string; label?: string }) => {
    setFeeds((prev) => {
      const next = prev.map((f) =>
        f.id === id
          ? { ...f, url: patch.url?.trim() || f.url, label: patch.label?.trim() || f.label }
          : f,
      );
      saveFeeds(next);
      return next;
    });
  }, []);

  return { feeds, addFeed, removeFeed, toggleFeed, updateFeed, items, refreshing, refreshAll, lastRefreshedAt, errors };
}

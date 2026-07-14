// Feed subscription management + polling. Owns the feeds/items localStorage
// round-trip so views just consume state.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AppSettings, FeedItem, FeedSource } from "../types";
import { fetchFeedItems, fetchFeedTitle } from "../lib/rss";
import { classifyFeedItems } from "../lib/feedClassify";
import { loadFeedItems, loadFeeds, mergeFeedItems, saveFeedItems, saveFeeds } from "../lib/feedStore";
import { subscribeKvHydrated } from "../lib/kvStore";

/** Placeholder label for a freshly added feed whose real title hasn't been
 * fetched yet (or never resolves). Falls back to the raw URL if it isn't
 * parseable, matching the previous no-label behavior. */
function hostnameLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

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

  // Other code paths (e.g. shared-article feed ingestion) can write feeds
  // directly through feedStore and then dispatch this event to tell any live
  // useFeeds instance to pick up the change. We only ever listen here — this
  // hook never dispatches "tc-news:feeds-updated" itself (addFeed/removeFeed/
  // toggleFeed/updateFeed all update `feeds` state directly) — so there's no
  // feedback loop even if some other listener re-dispatches after a reload.
  useEffect(() => {
    function handleFeedsUpdated() {
      setFeeds(loadFeeds());
    }
    window.addEventListener("tc-news:feeds-updated", handleFeedsUpdated);
    return () => window.removeEventListener("tc-news:feeds-updated", handleFeedsUpdated);
  }, []);

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
    const trimmedLabel = label?.trim();
    // No label typed: seed with a hostname placeholder and kick off a
    // best-effort fetch of the feed's own <title> to replace it once it
    // resolves. A typed label is always treated as final, never auto-updated.
    const autoLabel = !trimmedLabel;
    const feedId = crypto.randomUUID();
    const feed: FeedSource = {
      id: feedId,
      url: trimmedUrl,
      label: trimmedLabel || hostnameLabel(trimmedUrl),
      enabled: true,
      addedAt: Date.now(),
      ...(autoLabel ? { autoLabel: true } : {}),
    };
    setFeeds((prev) => {
      const next = [...prev, feed];
      saveFeeds(next);
      return next;
    });

    if (autoLabel) {
      void (async () => {
        let title: string | null = null;
        try {
          title = await fetchFeedTitle(trimmedUrl, corsProxyRef.current);
        } catch {
          // Best-effort: leave the hostname placeholder on any failure.
        }
        if (!title) return;
        setFeeds((prev) => {
          const target = prev.find((f) => f.id === feedId);
          // Bail if the feed was removed, or the user has since edited the
          // label by hand (autoLabel flipped to false) — never clobber a
          // manual edit with a late-arriving fetch result.
          if (!target || !target.autoLabel) return prev;
          const next = prev.map((f) => (f.id === feedId ? { ...f, label: title! } : f));
          saveFeeds(next);
          return next;
        });
      })();
    }
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
      const next = prev.map((f) => {
        if (f.id !== id) return f;
        const nextLabel = patch.label?.trim() || f.label;
        const updated: FeedSource = { ...f, url: patch.url?.trim() || f.url, label: nextLabel };
        // A label that actually changed means the user took over — stop
        // treating it as auto-derived so a pending/future title fetch (or
        // any other future auto-update) won't overwrite it.
        if (nextLabel !== f.label) updated.autoLabel = false;
        return updated;
      });
      saveFeeds(next);
      return next;
    });
  }, []);

  return { feeds, addFeed, removeFeed, toggleFeed, updateFeed, items, refreshing, refreshAll, lastRefreshedAt, errors };
}

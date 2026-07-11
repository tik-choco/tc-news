// Tracks how many Shared-tab articles the user hasn't seen yet, for the tab
// bar badge. "Seen" is a locally persisted set of article ids — arriving via
// either the private room or the global room counts the same way. While the
// Shared tab is active, everything currently visible is marked read (badge
// drops to 0); once the tab is left, newly arriving articles accumulate
// again.
import { useEffect, useRef, useState } from "preact/hooks";
import type { NewsArticle } from "../types";

const SEEN_IDS_KEY = "tc-news:shared-seen-ids";
const MAX_SEEN_IDS = 500;

function loadSeenIds(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_IDS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function saveSeenIds(ids: string[]): void {
  try {
    // Oldest-first eviction: keep only the most recently seen MAX_SEEN_IDS
    // ids (ids are only ever appended, never reordered).
    localStorage.setItem(SEEN_IDS_KEY, JSON.stringify(ids.slice(-MAX_SEEN_IDS)));
  } catch (error) {
    console.warn("tc-news: failed to persist seen shared ids", error);
  }
}

/** Count of `articles` whose id has not yet been marked seen. Marks all
 * current ids as seen (and returns 0) whenever `active` is true. */
export function useUnreadShared(articles: NewsArticle[], active: boolean): number {
  const [unread, setUnread] = useState(0);
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!seenRef.current) seenRef.current = new Set(loadSeenIds());
    const seen = seenRef.current;

    if (active) {
      let changed = false;
      for (const article of articles) {
        if (!seen.has(article.id)) {
          seen.add(article.id);
          changed = true;
        }
      }
      if (changed) saveSeenIds(Array.from(seen));
      setUnread(0);
    } else {
      setUnread(articles.filter((article) => !seen.has(article.id)).length);
    }
  }, [articles, active]);

  return unread;
}

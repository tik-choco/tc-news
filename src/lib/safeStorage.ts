// Quota-safe localStorage writes. tik-choco.github.io serves every tc-* app
// from the same origin, so all of them share a single (~5MB) localStorage
// quota — tc-news alone caches page extracts / translations / articles there,
// and once the quota is full even a tiny unguarded setItem throws an uncaught
// QuotaExceededError (e.g. from the add-feed form handler). All tc-news
// setItem calls should go through safeSetItem so a full quota degrades to
// evicting our own re-derivable caches instead of crashing the caller.
//
// Vendored shared-contract modules (sharedBus/appManifest) and crypto
// identity (didIdentity) are deliberately NOT migrated to this helper — they
// are synced copies of canonical reference implementations and must not
// drift.

/** tc-news keys that are pure re-derivable caches, cheapest-to-lose first.
 * Evicted one at a time (with a retry between each) when a write hits the
 * quota. Only tc-news's own keys — other apps' data on the shared origin is
 * never touched. */
const EVICTABLE_KEYS = [
  "tc-news:page-extracts", // up to 30 × 150K chars — by far the largest blob
  "tc-news:link-previews",
  "tc-news:feed-translations",
  "tc-news:translations",
  "tc-news:evaluations",
];

/** Per-room log/cache keys (`<prefix><roomId>`), evicted after the exact keys. */
const EVICTABLE_PREFIXES = ["tc-news:wirelog:", "tc-news:reactionlog:"];

/** Quota errors are reported inconsistently across browsers — match by name
 * and the two legacy codes rather than instanceof alone. */
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false;
  return (
    err.name === "QuotaExceededError" ||
    err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    err.code === 22 ||
    err.code === 1014
  );
}

function keysWithPrefix(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** setItem that survives a full quota: on QuotaExceededError it evicts
 * tc-news cache keys one at a time (retrying after each) and, if the quota
 * is still exhausted, drops the write with a console.warn instead of
 * throwing. Returns false when the write was dropped. Non-quota errors
 * (e.g. localStorage disabled entirely) also return false — persistence
 * here is always best-effort. */
export function safeSetItem(key: string, value: string): boolean {
  const attempt = (): boolean | "quota" => {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      return isQuotaError(err) ? "quota" : false;
    }
  };

  let result = attempt();
  if (result !== "quota") return result;

  let evictable: string[];
  try {
    evictable = [...EVICTABLE_KEYS, ...EVICTABLE_PREFIXES.flatMap(keysWithPrefix)];
  } catch {
    return false;
  }
  // Note: `key` itself is not filtered out — when a cache re-saves itself,
  // removing its own (old) persisted value is exactly what frees the space.
  for (const evictKey of evictable) {
    try {
      if (localStorage.getItem(evictKey) === null) continue;
      localStorage.removeItem(evictKey);
    } catch {
      return false;
    }
    result = attempt();
    if (result !== "quota") return result;
  }

  console.warn(
    `tc-news: localStorage quota exceeded even after evicting caches — dropped write to "${key}" (${value.length} chars). ` +
      "The origin-wide quota is shared with every tc-* app.",
  );
  return false;
}

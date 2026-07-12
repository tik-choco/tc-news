// Two-tier persistence for tc-news's bulky app state. The authoritative
// backend is mistlib's OPFS-backed KV (storage_kv_*, SPEC-17) which is not
// subject to the ~5MB localStorage quota shared by every tc-* app on the
// origin; localStorage remains as a synchronous fallback (tests, wasm init
// failure, pre-hydration writes).
//
// tc-news's store modules read and write synchronously at render time, so
// this module keeps an in-memory mirror and exposes a sync API:
//
// - kvGetSync/kvSetSync/kvDeleteSync operate on the mirror immediately.
//   Writes are flushed to the mist KV asynchronously (latest-wins per key);
//   while the backend isn't ready they fall back to localStorage via
//   safeSetItem.
// - initKvStore() (call once at app boot) waits for the mist node, then
//   hydrates the mirror and performs a one-time migration of each managed
//   key out of localStorage (freeing the shared origin quota). Hooks that
//   cached state before hydration should re-read on subscribeKvHydrated.
//
// Conflict rule during hydration, per key: mirror (this session's writes) >
// localStorage (implies a previous session wrote without the backend, so it
// is newer) > mist KV. Whichever wins is written back to the KV and the
// localStorage copy is removed.

import {
  storage_kv_delete,
  storage_kv_get,
  storage_kv_set,
} from "../vendor/mistlib/wrappers/web/index.js";
import { getNode } from "./mistClient";
import { safeSetItem } from "./safeStorage";

/** mist KV rejects values above 1MiB (SPEC-17). Stores whose serialized
 * blob can approach this must trim to KV_VALUE_SOFT_LIMIT_BYTES before
 * saving — the gap leaves headroom so a trim decision made on one estimate
 * never produces a hard reject. */
export const KV_VALUE_LIMIT_BYTES = 1_048_576;
export const KV_VALUE_SOFT_LIMIT_BYTES = 900_000;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Keys migrated out of localStorage into the mist KV at hydration. Fixed
 * list because the KV has no enumeration — per-room keys (tc-news:shared:*,
 * wirelog, reactionlog) deliberately stay in localStorage (bounded, and
 * still covered by safeStorage's eviction). */
export const KV_MANAGED_KEYS = [
  "tc-news:feed-items",
  "tc-news:articles",
  "tc-news:programs",
  "tc-news:translations",
  "tc-news:feed-translations",
  "tc-news:page-extracts",
  "tc-news:link-previews",
  "tc-news:evaluations",
];

const mirror = new Map<string, string>();
let backendReady = false;
let hydrated = false;
const hydrationListeners = new Set<() => void>();

// Latest-wins write queue: only the newest value per key is ever flushed,
// so a burst of saves to the same key costs one backend write.
const pending = new Map<string, string | null>(); // null = delete
let flushing = false;

async function flush(): Promise<void> {
  if (flushing || !backendReady) return;
  flushing = true;
  try {
    while (pending.size > 0) {
      const [key, value] = pending.entries().next().value as [string, string | null];
      pending.delete(key);
      try {
        if (value === null) {
          await storage_kv_delete(key);
        } else {
          await storage_kv_set(key, new TextEncoder().encode(value));
        }
      } catch (err) {
        // Dropped write: the mirror still has the value, so the next save
        // of this key retries; state is only stale across a reload.
        console.warn(`tc-news: kv write failed for "${key}"`, err);
      }
    }
  } finally {
    flushing = false;
  }
}

function enqueue(key: string, value: string | null): void {
  pending.set(key, value);
  void flush();
}

export function kvGetSync(key: string): string | null {
  if (hydrated) return mirror.get(key) ?? null;
  // Pre-hydration (and forever, in fallback mode): localStorage first so
  // legacy data renders on first paint and tests that manipulate
  // localStorage directly stay isolated (the mirror is deliberately NOT
  // seeded from reads here — it only holds real session writes until
  // hydration makes it authoritative). The mirror still backs reads when
  // localStorage has nothing, e.g. a pre-hydration write that safeSetItem
  // had to drop on a full quota.
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) return raw;
  } catch {
    // localStorage unavailable — mirror only.
  }
  return mirror.get(key) ?? null;
}

export function kvSetSync(key: string, value: string): void {
  mirror.set(key, value);
  if (backendReady) {
    enqueue(key, value);
  } else {
    // Backend not up (yet): persist where we can. If hydration completes
    // later, the mirror value wins and gets written through to the KV.
    safeSetItem(key, value);
  }
}

export function kvDeleteSync(key: string): void {
  mirror.delete(key);
  if (backendReady) {
    enqueue(key, null);
  } else {
    try {
      localStorage.removeItem(key);
    } catch {
      // localStorage unavailable — nothing to delete.
    }
  }
}

export function isKvHydrated(): boolean {
  return hydrated;
}

/** Returns an unsubscribe function. Fires once, after hydration replaces
 * pre-hydration fallback reads — subscribers should re-read their state. */
export function subscribeKvHydrated(listener: () => void): () => void {
  if (hydrated) {
    listener();
    return () => {};
  }
  hydrationListeners.add(listener);
  return () => hydrationListeners.delete(listener);
}

/** Test-only: clears every piece of module state so vitest cases (which
 * share the module instance) start from a blank mirror. */
export function resetKvStoreForTests(): void {
  mirror.clear();
  pending.clear();
  backendReady = false;
  hydrated = false;
  hydrationListeners.clear();
  initPromise = null;
}

let initPromise: Promise<void> | null = null;

/** Idempotent; call once at app boot. Never rejects — on any failure the
 * app simply stays on the localStorage fallback path. */
export function initKvStore(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        // The wasm module (and thus storage_kv_*) is initialized as part of
        // the shared MistNode singleton the app already boots for its P2P
        // rooms.
        await getNode();
      } catch (err) {
        console.warn("tc-news: mist unavailable — KV store stays on localStorage fallback", err);
        return;
      }
      backendReady = true;

      for (const key of KV_MANAGED_KEYS) {
        try {
          const sessionValue = mirror.get(key);
          let legacyValue: string | null = null;
          try {
            legacyValue = localStorage.getItem(key);
          } catch {
            legacyValue = null;
          }

          if (sessionValue !== undefined) {
            enqueue(key, sessionValue);
          } else if (legacyValue !== null) {
            mirror.set(key, legacyValue);
            enqueue(key, legacyValue);
          } else {
            const bytes = await storage_kv_get(key);
            if (bytes !== undefined) mirror.set(key, new TextDecoder().decode(bytes));
          }

          // Migration: the KV is now authoritative for this key — drop the
          // localStorage copy to free the shared origin quota.
          if (legacyValue !== null) {
            try {
              localStorage.removeItem(key);
            } catch {
              // Best-effort; a survivor copy only wastes quota, it can't
              // win over the KV again unless written anew.
            }
          }
        } catch (err) {
          console.warn(`tc-news: kv hydration failed for "${key}"`, err);
        }
      }

      hydrated = true;
      hydrationListeners.forEach((l) => l());
      hydrationListeners.clear();
    })();
  }
  return initPromise;
}

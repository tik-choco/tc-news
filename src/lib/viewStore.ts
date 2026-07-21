// Local aggregate of every article/program *view* this client has ever seen,
// from any room — a view wire (lib/newsWire.ts's ViewWire) is appended here
// once it's received/verified (see hooks/useNewsRoom.ts), independent of
// which room delivered it, mirroring reactionStore.ts exactly except there's
// no `kind`: a view is a single boolean signal ("fromId has opened
// targetId"), not a multi-kind tally. lib/ranking.ts consumes loadViews() to
// fold view counts into the daily ranking score alongside reactions; this
// module only owns storage + same-tab pub-sub, no ranking math.
//
// Dedup is by (targetId, fromId) forever — same policy as reactionStore's
// hasReacted (not "once per day"): a viewer's first-ever open of a target is
// the only one that's ever recorded, so re-opening an article can't inflate
// its view count, and the daily ranking naturally only credits a target for
// viewers whose *first* view landed on that calendar day (see ranking.ts).
// The DID pubkey (fromId) is what makes this dedup meaningful — a view wire
// is signed (wireSign.ts) and verified before being added here, so a peer
// can't forge views under someone else's identity to inflate a target's
// count.
//
// Persisted through lib/kvStore.ts (mist KV), same as reactionStore.ts.
import { KV_VALUE_SOFT_LIMIT_BYTES, kvGetSync, kvSetSync, utf8ByteLength } from "./kvStore";

export interface ViewRecord {
  targetId: string; // NewsArticle.id または RadioProgram.id
  targetType: "article" | "program";
  fromId: string; // 閲覧者DID
  timestamp: number;
}

const VIEWS_KEY = "tc-news:views";
const MAX_VIEWS = 5000;
/** Floor for the halve-and-retry trim in persist() below — same proportional
 * floor idiom as reactionStore.ts's MIN_REACTIONS. */
const MIN_VIEWS = 500;

function sanitizeRecord(value: unknown): ViewRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.targetId !== "string" || !v.targetId) return null;
  if (v.targetType !== "article" && v.targetType !== "program") return null;
  if (typeof v.fromId !== "string" || !v.fromId) return null;
  if (typeof v.timestamp !== "number") return null;
  return {
    targetId: v.targetId,
    targetType: v.targetType,
    fromId: v.fromId,
    timestamp: v.timestamp,
  };
}

function parse(raw: string | null): ViewRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeRecord).filter((r): r is ViewRecord => r !== null);
  } catch {
    return [];
  }
}

// In-memory read-through cache — same shape/invalidation idiom as
// reactionStore.ts's readAll()/rebuildIndexes().
let cacheInitialized = false;
let cachedRaw: string | null = null;
let cachedRecords: ViewRecord[] = [];
/** targetId -> distinct viewer count. */
let cachedCounts: Map<string, number> = new Map();
/** `${targetId}:${fromId}` -> true, for O(1) hasViewed(). */
let cachedViewedIndex: Set<string> = new Set();

function rebuildIndexes(records: ViewRecord[]): void {
  const counts = new Map<string, number>();
  const viewedIndex = new Set<string>();
  for (const r of records) {
    counts.set(r.targetId, (counts.get(r.targetId) ?? 0) + 1);
    viewedIndex.add(`${r.targetId}:${r.fromId}`);
  }
  cachedCounts = counts;
  cachedViewedIndex = viewedIndex;
}

function readAll(): ViewRecord[] {
  const raw = kvGetSync(VIEWS_KEY);
  if (cacheInitialized && raw === cachedRaw) return cachedRecords;
  cachedRaw = raw;
  cachedRecords = parse(raw);
  rebuildIndexes(cachedRecords);
  cacheInitialized = true;
  return cachedRecords;
}

/** Persists `records` (capped, oldest-first evicted, then further halved if
 * still over the mist KV's soft limit) and refreshes the cache — same
 * trimming policy as reactionStore.ts's persist(). */
function persist(records: ViewRecord[]): ViewRecord[] {
  let capped = records;
  if (capped.length > MAX_VIEWS) {
    capped = [...capped].sort((a, b) => a.timestamp - b.timestamp).slice(capped.length - MAX_VIEWS);
  }
  let raw = JSON.stringify(capped);
  while (utf8ByteLength(raw) > KV_VALUE_SOFT_LIMIT_BYTES && capped.length > MIN_VIEWS) {
    const oldestFirst = [...capped].sort((a, b) => a.timestamp - b.timestamp);
    capped = oldestFirst.slice(oldestFirst.length - Math.max(MIN_VIEWS, Math.floor(oldestFirst.length / 2)));
    raw = JSON.stringify(capped);
  }
  kvSetSync(VIEWS_KEY, raw);
  cachedRaw = raw;
  cachedRecords = capped;
  rebuildIndexes(cachedRecords);
  cacheInitialized = true;
  return capped;
}

export function loadViews(): ViewRecord[] {
  return [...readAll()];
}

/**
 * Dedup by (targetId, fromId): returns false and does nothing if `fromId`
 * has already viewed `targetId` (ever — see header comment); otherwise
 * persists and notifies subscribers.
 */
export function addView(record: ViewRecord): boolean {
  const all = readAll();
  if (hasViewed(record.targetId, record.fromId)) return false;
  persist([...all, record]);
  notify();
  return true;
}

/** O(1) via the `${targetId}:${fromId}`-indexed set (see readAll()/rebuildIndexes()). */
export function hasViewed(targetId: string, fromId: string): boolean {
  readAll();
  return cachedViewedIndex.has(`${targetId}:${fromId}`);
}

/** Distinct-viewer count for a single target. O(1) via the targetId-indexed counts map. */
export function countFor(targetId: string): number {
  readAll();
  return cachedCounts.get(targetId) ?? 0;
}

// --- Same-tab pub-sub (mirrors reactionStore.ts's listener set) -----------

const listeners = new Set<() => void>();

/** UI subscribes to be notified when a view is added; returns an unsubscribe fn. */
export function subscribeViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("viewStore: listener threw", error);
    }
  }
}

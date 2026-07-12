// Local aggregate of every reaction (👍🔥👏😂) this client has ever seen, from
// any room — a reaction wire (lib/newsWire.ts's ReactionWire) is appended
// here once it's received/verified (see hooks/useNewsRoom.ts), independent
// of which room delivered it, so a card can show its total tally regardless
// of which room the viewer is currently in. lib/ranking.ts consumes
// loadReactions() to compute the daily leaderboard; this module only owns
// storage + same-tab pub-sub, no ranking math (kept pure/testable there).
//
// Same defensive-parsing localStorage pattern as the rest of tc-news: JSON
// parsed in a try/catch, every field coerced to its expected type, invalid
// entries dropped. On top of that, an in-memory cache avoids re-parsing the
// (potentially large) reaction list on every countsFor() call from a card —
// the cache is keyed by raw-string identity, so it self-invalidates whenever
// the persisted value actually changes (including a bare `localStorage.clear()`
// from a test, with no need to call back into this module first).

import { REACTION_KINDS, type ReactionKind } from "../types";
import { safeSetItem } from "./safeStorage";

export interface ReactionRecord {
  targetId: string; // NewsArticle.id または RadioProgram.id
  targetType: "article" | "program";
  kind: ReactionKind;
  fromId: string; // 送信者DID
  fromName: string;
  timestamp: number;
}

const REACTIONS_KEY = "tc-news:reactions";
const MAX_REACTIONS = 5000;

function isReactionKind(value: unknown): value is ReactionKind {
  return typeof value === "string" && (REACTION_KINDS as readonly string[]).includes(value);
}

function sanitizeRecord(value: unknown): ReactionRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.targetId !== "string" || !v.targetId) return null;
  if (v.targetType !== "article" && v.targetType !== "program") return null;
  if (!isReactionKind(v.kind)) return null;
  if (typeof v.fromId !== "string" || !v.fromId) return null;
  if (typeof v.timestamp !== "number") return null;
  return {
    targetId: v.targetId,
    targetType: v.targetType,
    kind: v.kind,
    fromId: v.fromId,
    fromName: typeof v.fromName === "string" ? v.fromName : "",
    timestamp: v.timestamp,
  };
}

function parse(raw: string | null): ReactionRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeRecord).filter((r): r is ReactionRecord => r !== null);
  } catch {
    return [];
  }
}

// In-memory read-through cache. `cachedRaw` is the exact localStorage string
// the cache was built from; a mismatch (including null, e.g. after
// localStorage.clear()) means the cache is stale and gets rebuilt.
let cacheInitialized = false;
let cachedRaw: string | null = null;
let cachedRecords: ReactionRecord[] = [];

function readAll(): ReactionRecord[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(REACTIONS_KEY);
  } catch {
    return cacheInitialized ? cachedRecords : [];
  }
  if (cacheInitialized && raw === cachedRaw) return cachedRecords;
  cachedRaw = raw;
  cachedRecords = parse(raw);
  cacheInitialized = true;
  return cachedRecords;
}

/** Persists `records` (capped, oldest-first evicted) and refreshes the cache on success. */
function persist(records: ReactionRecord[]): ReactionRecord[] {
  let capped = records;
  if (capped.length > MAX_REACTIONS) {
    capped = [...capped].sort((a, b) => a.timestamp - b.timestamp).slice(capped.length - MAX_REACTIONS);
  }
  const raw = JSON.stringify(capped);
  if (safeSetItem(REACTIONS_KEY, raw)) {
    cachedRaw = raw;
    cachedRecords = capped;
    cacheInitialized = true;
  }
  // On failure, leave the cache untouched so subsequent reads stay
  // consistent with what's actually on disk.
  return capped;
}

function zeroCounts(): Record<ReactionKind, number> {
  const out = {} as Record<ReactionKind, number>;
  for (const kind of REACTION_KINDS) out[kind] = 0;
  return out;
}

export function loadReactions(): ReactionRecord[] {
  return [...readAll()];
}

/**
 * Dedup by (targetId, kind, fromId): returns false and does nothing for a
 * duplicate (a user reacting twice with the same emoji doesn't double-count);
 * otherwise persists and notifies subscribers.
 */
export function addReaction(record: ReactionRecord): boolean {
  const all = readAll();
  const isDuplicate = all.some(
    (r) => r.targetId === record.targetId && r.kind === record.kind && r.fromId === record.fromId,
  );
  if (isDuplicate) return false;
  persist([...all, record]);
  notify();
  return true;
}

export function hasReacted(targetId: string, kind: ReactionKind, fromId: string): boolean {
  return readAll().some((r) => r.targetId === targetId && r.kind === kind && r.fromId === fromId);
}

/** Zero-filled per-kind counts for a single target (article or program). */
export function countsFor(targetId: string): Record<ReactionKind, number> {
  const counts = zeroCounts();
  for (const r of readAll()) {
    if (r.targetId === targetId) counts[r.kind] += 1;
  }
  return counts;
}

// --- Same-tab pub-sub (mirrors lib/onboarding.ts's listener set) -----------

const listeners = new Set<() => void>();

/** UI subscribes to be notified when a reaction is added; returns an unsubscribe fn. */
export function subscribeReactions(listener: () => void): () => void {
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
      console.warn("reactionStore: listener threw", error);
    }
  }
}

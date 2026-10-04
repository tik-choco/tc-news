import type { InterestRecord, InterestState, RecommendationCandidate, RecommendationMode } from "./recommendationTypes";

const KEY = "tc-news:interests";
// Tiny, independent preference copy survives when the larger history cannot
// fit in localStorage. A persisted pause always wins over stale history.
const PREFERENCES_KEY = "tc-news:interest-preferences";
const MAX_BYTES = 300_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 500;
const MAX_READING_MS = 120_000;
const listeners = new Set<() => void>();
const readingSessions = new Map<string, { key: string }>();
const impressionSessions = new Set<string>();
let serial = 0;
let cachedRaw: string | null | undefined;
let cachedPreferences: string | null | undefined;
let snapshot: InterestState = freeze({ enabled: true, mode: "recommended", records: [] });
let expiresAt = Infinity;

function freeze(state: InterestState): InterestState {
  for (const record of state.records) {
    Object.freeze(record.candidate.tags);
    Object.freeze(record.candidate);
    Object.freeze(record);
  }
  Object.freeze(state.records);
  return Object.freeze(state);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function number(value: unknown, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
}

function candidate(value: unknown, now: number): RecommendationCandidate | null {
  if (!object(value) || (value.type !== "feed" && value.type !== "article")) return null;
  const key = text(value.key, 1024);
  const id = text(value.id, 512);
  if (!key || !id || value.key !== key || value.id !== id) return null;
  return {
    key, id, type: value.type, title: text(value.title, 300), summary: text(value.summary, 1200),
    category: text(value.category, 80) || undefined,
    tags: Array.isArray(value.tags) ? value.tags.slice(0, 12).map((tag) => text(tag, 60)).filter(Boolean) : [],
    source: text(value.source, 200), publishedAt: number(value.publishedAt, now),
  };
}

function activityAt(record: InterestRecord): number {
  // Merely seeing an article again must never prolong learned interests.
  return record.updatedAt || record.lastImpressionAt;
}

function bound(state: InterestState, now: number): InterestState {
  const seen = new Set<string>();
  const records = state.records.filter((record) => activityAt(record) > now - RETENTION_MS)
    .sort((a, b) => activityAt(b) - activityAt(a))
    .filter((record) => {
      if (seen.has(record.candidate.key)) return false;
      seen.add(record.candidate.key);
      return true;
    }).slice(0, MAX_RECORDS);
  const result = { ...state, records };
  // Bound the entire UTF-8 payload, including multibyte titles.
  while (records.length && new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES) records.pop();
  return result;
}

function decode(raw: string | null, now: number): InterestState {
  const fallback: InterestState = { enabled: true, mode: "recommended", records: [] };
  if (!raw || raw.length > 2_000_000) return fallback;
  try {
    const data: unknown = JSON.parse(raw);
    if (!object(data)) return fallback;
    const records: InterestRecord[] = [];
    for (const value of Array.isArray(data.records) ? data.records.slice(0, 2000) : []) {
      if (!object(value)) continue;
      const item = candidate(value.candidate, now);
      if (!item) continue;
      const openedAt = number(value.openedAt, now);
      const feedback = value.feedback === "more" || value.feedback === "less" ? value.feedback : null;
      records.push({
        candidate: item, openedAt,
        updatedAt: openedAt || feedback ? Math.max(openedAt, number(value.updatedAt, now)) : 0,
        activeMs: openedAt ? number(value.activeMs, MAX_READING_MS) : 0,
        feedback, impressions: number(value.impressions, 1000),
        lastImpressionAt: number(value.lastImpressionAt, now),
      });
    }
    return bound({ enabled: data.enabled !== false, mode: data.mode === "latest" ? "latest" : "recommended", records }, now);
  } catch { return fallback; }
}

function assign(state: InterestState): void {
  snapshot = freeze(state);
  expiresAt = Math.min(...state.records.map((record) => activityAt(record) + RETENTION_MS), Infinity);
}

function persist(state: InterestState): void {
  const preferences = JSON.stringify({ enabled: state.enabled, mode: state.mode });
  const raw = JSON.stringify(state);
  // Write the tiny pause preference first, before attempting bulky history.
  try { localStorage.setItem(PREFERENCES_KEY, preferences); cachedPreferences = preferences; } catch { /* Keep the live state. */ }
  try { localStorage.setItem(KEY, raw); cachedRaw = raw; } catch { /* Keep the live state. */ }
}

function preferencesOn(state: InterestState, raw: string | null): InterestState {
  try {
    const preferences: unknown = raw ? JSON.parse(raw) : null;
    if (object(preferences)) return {
      ...state,
      enabled: state.enabled && preferences.enabled !== false,
      mode: preferences.mode === "latest" || preferences.mode === "recommended" ? preferences.mode : state.mode,
    };
  } catch { /* Corrupt preferences cannot hide valid saved history. */ }
  return state;
}

export function loadInterests(): InterestState {
  const now = Date.now();
  let raw: string | null;
  let preferences: string | null;
  try {
    raw = localStorage.getItem(KEY);
    preferences = localStorage.getItem(PREFERENCES_KEY);
  } catch {
    if (now >= expiresAt) { assign(bound(snapshot, now)); persist(snapshot); }
    return snapshot;
  }
  const changed = raw !== cachedRaw || preferences !== cachedPreferences;
  if (changed || now >= expiresAt) {
    if (changed) {
      // Other tabs may pause/reset before their storage event is delivered.
      // Checking on every recording call invalidates their old reader tokens.
      readingSessions.clear();
      impressionSessions.clear();
    }
    cachedRaw = raw;
    cachedPreferences = preferences;
    assign(changed ? preferencesOn(decode(raw, now), preferences) : bound(snapshot, now));
    // Expired/corrupt history is removed from disk as well as from memory.
    if (JSON.stringify(snapshot) !== raw || preferences === null) persist(snapshot);
  }
  return snapshot;
}

function save(state: InterestState): void {
  const bounded = bound(state, Date.now());
  assign(bounded);
  persist(bounded);
  listeners.forEach((listener) => listener());
}

export function subscribeInterests(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === PREFERENCES_KEY || event.key === null) {
      loadInterests(); listener();
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function setInterestEnabled(enabled: boolean): void {
  const state = loadInterests();
  if (state.enabled === enabled) return;
  readingSessions.clear();
  impressionSessions.clear();
  save({ ...state, enabled });
}

export function setRecommendationMode(mode: RecommendationMode): void {
  if (mode !== "latest" && mode !== "recommended") return;
  const state = loadInterests();
  if (state.mode !== mode) save({ ...state, mode });
}

export function resetInterests(): void {
  const state = loadInterests();
  readingSessions.clear();
  impressionSessions.clear();
  save({ ...state, records: [] });
}

function initial(item: RecommendationCandidate): InterestRecord {
  return { candidate: item, openedAt: 0, updatedAt: 0, activeMs: 0, feedback: null, impressions: 0, lastImpressionAt: 0 };
}

function replace(state: InterestState, record: InterestRecord): void {
  save({ ...state, records: [record, ...state.records.filter((entry) => entry.candidate.key !== record.candidate.key)] });
}

export function beginReading(input: RecommendationCandidate): string | null {
  const state = loadInterests();
  const now = Date.now();
  const item = candidate(input, now);
  if (!state.enabled || !item) return null;
  const record = state.records.find((entry) => entry.candidate.key === item.key) ?? initial(item);
  const token = `reading-${++serial}`;
  readingSessions.set(token, { key: item.key });
  if (readingSessions.size > 100) readingSessions.delete(readingSessions.keys().next().value!);
  replace(state, { ...record, candidate: item, openedAt: now, updatedAt: now });
  return token;
}

export function updateReading(input: RecommendationCandidate, sessionId: string, activeMs: number, content: "full" | "summary"): void {
  const state = loadInterests();
  const session = readingSessions.get(sessionId);
  if (!state.enabled || !session || session.key !== input.key) return;
  const record = state.records.find((entry) => entry.candidate.key === session.key);
  if (!record) return;
  const duration = number(activeMs, content === "full" ? MAX_READING_MS : 10_000);
  // The strongest observed session is the evidence. Reopening short summaries
  // must not accumulate into an apparently engaged full-article reading.
  const total = Math.max(record.activeMs, duration);
  if (total === record.activeMs) return;
  replace(state, { ...record, activeMs: total, updatedAt: Date.now() });
}

export function setInterestFeedback(input: RecommendationCandidate, feedback: "more" | "less" | null): void {
  const state = loadInterests();
  const now = Date.now();
  const item = candidate(input, now);
  if (!item || (feedback !== null && feedback !== "more" && feedback !== "less")) return;
  const existing = state.records.find((entry) => entry.candidate.key === item.key);
  // Pausing stops collection, but the reader can still undo an existing
  // preference. Clearing must never create a record while collection is off.
  if (!state.enabled && (feedback !== null || !existing)) return;
  const record = existing ?? initial(item);
  if (record.feedback === feedback) return;
  replace(state, { ...record, candidate: item, feedback, updatedAt: now });
}

export function recordImpression(input: RecommendationCandidate, position: number, rankingVersion: string, sessionId: string): void {
  const state = loadInterests();
  const now = Date.now();
  const item = candidate(input, now);
  if (!state.enabled || !item || !Number.isFinite(position) || position < 0 || !rankingVersion || !sessionId) return;
  const dedup = JSON.stringify([item.key, rankingVersion.slice(0, 80), sessionId.slice(0, 120)]);
  if (impressionSessions.has(dedup)) return;
  impressionSessions.add(dedup);
  if (impressionSessions.size > 2000) impressionSessions.delete(impressionSessions.values().next().value!);
  const record = state.records.find((entry) => entry.candidate.key === item.key) ?? initial(item);
  replace(state, { ...record, impressions: Math.min(1000, record.impressions + 1), lastImpressionAt: now });
}

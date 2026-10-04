import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCandidate } from "./recommendationTypes";

const KEY = "tc-news:interests";
const PREFERENCES_KEY = "tc-news:interest-preferences";

let store: typeof import("./interestStore");
const NOW = 1_800_000_000_000;
const item = (id = "one"): RecommendationCandidate => ({
  key: `feed:${id}`, id, type: "feed", title: "Game industry news", summary: "AI and games",
  category: "technology", tags: ["games"], source: "example.com", publishedAt: NOW - 1000,
});

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  store = await import("./interestStore");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("local recommendation interests", () => {
  it("starts enabled without requiring settings and returns immutable stable snapshots", () => {
    const state = store.loadInterests();
    expect(state).toEqual({ enabled: true, mode: "recommended", records: [] });
    expect(store.loadInterests()).toBe(state);
    store.beginReading(item());
    const record = store.loadInterests().records[0];
    expect(Object.isFrozen(record.candidate.tags)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(state.records).toHaveLength(0);
  });

  it.each(["not json", "null", "[]", '{"records":[null,3,{}]}'])("recovers from malformed persisted state: %s", (raw) => {
    localStorage.setItem(KEY, raw);
    expect(store.loadInterests().records).toEqual([]);
  });

  it("sanitizes future dates, excessive text, invalid values and duplicate records", () => {
    const valid = {
      candidate: { ...item(), summary: "長".repeat(5000), tags: ["x", null], publishedAt: NOW * 2 },
      openedAt: NOW * 2, updatedAt: NOW * 2, activeMs: 1e30, feedback: "wrong", impressions: -3,
      lastImpressionAt: "tomorrow",
    };
    localStorage.setItem(KEY, JSON.stringify({ records: [valid, valid, { candidate: { ...item("bad"), key: "" } }] }));
    const records = store.loadInterests().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ openedAt: NOW, updatedAt: NOW, activeMs: 120_000, feedback: null, impressions: 0, lastImpressionAt: 0 });
    expect(records[0].candidate.summary).toHaveLength(1200);
    expect(records[0].candidate.tags).toEqual(["x"]);
    expect(records[0].candidate.publishedAt).toBe(NOW);
  });

  it("applies cumulative reading idempotently and caps summary evidence across reopenings", () => {
    const first = store.beginReading(item())!;
    store.updateReading(item(), first, 5000, "summary");
    store.updateReading(item(), first, 5000, "summary");
    expect(store.loadInterests().records[0].activeMs).toBe(5000);
    store.updateReading(item(), first, 60_000, "summary");
    const second = store.beginReading(item())!;
    store.updateReading(item(), second, 60_000, "summary");
    expect(store.loadInterests().records[0].activeMs).toBe(10_000);
    store.updateReading(item(), second, 12_000, "full");
    expect(store.loadInterests().records[0].activeMs).toBe(12_000);
    store.updateReading(item(), second, 1e10, "full");
    expect(store.loadInterests().records[0].activeMs).toBe(120_000);
  });

  it("rejects unknown tokens, mismatched items and invalid durations", () => {
    const token = store.beginReading(item())!;
    store.updateReading(item(), "invented", 30_000, "full");
    store.updateReading(item("other"), token, 30_000, "full");
    store.updateReading(item(), token, NaN, "full");
    store.updateReading(item(), token, -100, "full");
    expect(store.loadInterests().records[0].activeMs).toBe(0);
  });

  it("stops every recording path while disabled and invalidates old sessions on resume", () => {
    const token = store.beginReading(item())!;
    store.setInterestEnabled(false);
    store.setInterestFeedback(item("other"), "more");
    store.recordImpression(item("other"), 0, "v1", "s1");
    expect(store.beginReading(item("other"))).toBeNull();
    store.updateReading(item(), token, 30_000, "full");
    store.setInterestEnabled(true);
    store.updateReading(item(), token, 30_000, "full");
    expect(store.loadInterests().records).toHaveLength(1);
    expect(store.loadInterests().records[0].activeMs).toBe(0);
  });

  it("reset clears exclusions and prevents pending reader ticks from recreating history", () => {
    store.setRecommendationMode("latest");
    const token = store.beginReading(item())!;
    store.setInterestFeedback(item(), "less");
    store.resetInterests();
    store.updateReading(item(), token, 60_000, "full");
    expect(store.loadInterests()).toEqual({ enabled: true, mode: "latest", records: [] });
  });

  it("allows undoing existing preferences while paused without collecting new feedback", () => {
    store.setInterestFeedback(item(), "less");
    store.setInterestEnabled(false);
    store.setInterestFeedback(item(), "more");
    expect(store.loadInterests().records[0].feedback).toBe("less");
    store.setInterestFeedback(item("new"), null);
    store.setInterestFeedback(item("new"), "more");
    store.setInterestFeedback(item("new"), "less");
    store.setInterestFeedback(item(), null);
    expect(store.loadInterests().enabled).toBe(false);
    expect(store.loadInterests().records).toHaveLength(1);
    expect(store.loadInterests().records[0].feedback).toBeNull();
  });

  it("counts unique exposures without inventing positive interest or refreshing interest age", () => {
    store.recordImpression(item(), 0, "v1", "s1");
    store.recordImpression(item(), 1, "v1", "s1");
    expect(store.loadInterests().records[0]).toMatchObject({ impressions: 1, openedAt: 0, updatedAt: 0, activeMs: 0, feedback: null });
    store.beginReading(item());
    vi.spyOn(Date, "now").mockReturnValue(NOW + 10_000);
    store.recordImpression(item(), 0, "v1", "s2");
    expect(store.loadInterests().records[0]).toMatchObject({ impressions: 2, openedAt: NOW, updatedAt: NOW, lastImpressionAt: NOW + 10_000 });
  });

  it("expires old interest even when impressions were recent and trims live snapshots", () => {
    store.beginReading(item());
    vi.spyOn(Date, "now").mockReturnValue(NOW + 29 * 86_400_000);
    store.recordImpression(item(), 0, "v1", "s1");
    vi.spyOn(Date, "now").mockReturnValue(NOW + 30 * 86_400_000);
    expect(store.loadInterests().records).toEqual([]);
  });

  it("bounds records and actual UTF-8 storage size", () => {
    for (let i = 0; i < 520; i++) store.beginReading(item(String(i)));
    expect(store.loadInterests().records).toHaveLength(500);
    for (let i = 0; i < 250; i++) store.beginReading({ ...item(`large-${i}`), summary: "長".repeat(1200) });
    expect(new TextEncoder().encode(localStorage.getItem(KEY)!).length).toBeLessThanOrEqual(300_000);
  });

  it("keeps live state in memory when persistence throws", () => {
    const save = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    store.beginReading(item());
    expect(store.loadInterests().records).toHaveLength(1);
    store.setInterestFeedback(item(), "more");
    expect(store.loadInterests().records[0].feedback).toBe("more");
    save.mockRestore();
    store.setRecommendationMode("latest");
    expect(JSON.parse(localStorage.getItem(KEY)!).records[0].feedback).toBe("more");
  });

  it("reads another tab's pause before recording, notifies subscribers and unsubscribes", () => {
    expect(store.loadInterests().records).toHaveLength(0);
    const listener = vi.fn();
    const unsubscribe = store.subscribeInterests(listener);
    localStorage.setItem(KEY, JSON.stringify({ enabled: false, mode: "latest", records: [] }));
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ enabled: false, mode: "latest" }));
    expect(store.beginReading(item())).toBeNull();
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.loadInterests()).toMatchObject({ enabled: false, mode: "latest" });
    unsubscribe();
    store.setInterestEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("persists pruning on startup and expiry without losing the saved pause", () => {
    store.beginReading(item());
    store.setInterestEnabled(false);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 31 * 86_400_000);
    expect(store.loadInterests()).toMatchObject({ enabled: false, records: [] });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ enabled: false, records: [] });
  });

  it("cleans expired history on first load before any open or impression can overwrite a pause", () => {
    localStorage.setItem(KEY, JSON.stringify({ enabled: false, mode: "recommended", records: [{
      candidate: item(), openedAt: NOW - 31 * 86_400_000, updatedAt: NOW - 31 * 86_400_000,
      activeMs: 30_000, feedback: "more", impressions: 0, lastImpressionAt: 0,
    }] }));
    expect(store.beginReading(item("new"))).toBeNull();
    store.recordImpression(item("new"), 0, "v1", "new-session");
    expect(store.loadInterests()).toMatchObject({ enabled: false, records: [] });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ enabled: false, records: [] });
  });

  it("keeps pause across reload when the history write exceeds quota", async () => {
    store.beginReading(item());
    const set = localStorage.setItem.bind(localStorage);
    const save = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === KEY) throw new Error("quota");
      set(key, value);
    });
    store.setInterestEnabled(false);
    vi.resetModules();
    const reloaded = await import("./interestStore");
    expect(reloaded.loadInterests().enabled).toBe(false);
    expect(reloaded.beginReading(item("other"))).toBeNull();
    save.mockRestore();
  });

  it("does not revive another tab's cleared history with a stale reading token", () => {
    const token = store.beginReading(item())!;
    localStorage.setItem(KEY, JSON.stringify({ enabled: true, mode: "recommended", records: [] }));
    store.updateReading(item(), token, 60_000, "full");
    expect(store.loadInterests().records).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY)!).records).toEqual([]);
  });
});

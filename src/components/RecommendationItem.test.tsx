import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadInterests, resetInterests, setInterestEnabled } from "../lib/interestStore";
import type { RankedRecommendation } from "../lib/recommendationTypes";
import { RecommendationItem } from "./RecommendationItem";
import { setDeveloperMode } from "../hooks/useDeveloperMode";

const backend = vi.hoisted(() => ({ raw: null as string | null }));
vi.mock("../lib/kvStore", () => ({
  kvGetSync: () => backend.raw,
  kvSetSync: (_key: string, value: string) => { backend.raw = value; },
  subscribeKvHydrated: () => () => {},
  utf8ByteLength: (value: string) => new TextEncoder().encode(value).length,
  KV_VALUE_SOFT_LIMIT_BYTES: 900_000,
}));
vi.mock("./RecommendationFeedback", () => ({ RecommendationFeedback: () => null }));

const entry: RankedRecommendation = {
  candidate: { key: "feed:one", id: "one", type: "feed", title: "Games", summary: "News", tags: [], source: "example.com", publishedAt: 1 },
  score: 0.7, reason: "related",
};
const props = { entry, position: 0, sessionId: "list-session", enabled: true, personalized: true, children: "Article" };
const observers: FakeObserver[] = [];
class FakeObserver {
  target!: Element;
  private callback: IntersectionObserverCallback;
  observe = vi.fn((target: Element) => { this.target = target; });
  disconnect = vi.fn();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  emit(...ratios: number[]) {
    act(() => {
      this.callback(ratios.map((ratio) => ({
        target: this.target, isIntersecting: ratio > 0, intersectionRatio: ratio,
      } as IntersectionObserverEntry)), this as unknown as IntersectionObserver);
    });
  }
}
function observer() { return observers[observers.length - 1]!; }
function advance(ms: number) { act(() => { vi.advanceTimersByTime(ms); }); }
function impressions() { return loadInterests().records[0]?.impressions ?? 0; }
function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  observers.length = 0;
  backend.raw = null;
  setDeveloperMode(false);
  resetInterests();
  setInterestEnabled(true);
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  visibility("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("requires at least half the card to remain visible for a full second", () => {
  render(<RecommendationItem {...props} />);
  observer().emit(0.49);
  advance(2_000);
  expect(impressions()).toBe(0);
  observer().emit(0.5);
  advance(999);
  expect(impressions()).toBe(0);
  advance(1);
  expect(impressions()).toBe(1);
});

it("shows recommendation reasons only while this app's developer mode is enabled", () => {
  const ui = render(<RecommendationItem {...props} />);
  expect(ui.container.querySelector(".recommendation-reason")).toBeNull();
  act(() => { setDeveloperMode(true); });
  expect(ui.container.querySelector(".recommendation-reason")?.textContent).toBe("読んだ記事に近い話題");
  act(() => { setDeveloperMode(false); });
  expect(ui.container.querySelector(".recommendation-reason")).toBeNull();
});

it("preserves the timer across observer callbacks that remain above the threshold", () => {
  const { rerender } = render(<RecommendationItem {...props} />);
  observer().emit(0.5);
  advance(600);
  observer().emit(0.8);
  rerender(<RecommendationItem {...props} entry={{ ...entry }} position={2} />);
  advance(400);
  expect(impressions()).toBe(1);
  observer().emit(1);
  advance(3_000);
  expect(impressions()).toBe(1);
});

it("requires uninterrupted exposure and uses the final entry of an observer batch", () => {
  render(<RecommendationItem {...props} />);
  observer().emit(0.8);
  advance(600);
  observer().emit(0.7, 0.2);
  advance(2_000);
  expect(impressions()).toBe(0);
  observer().emit(0.8);
  advance(999);
  expect(impressions()).toBe(0);
  advance(1);
  expect(impressions()).toBe(1);
});

it("excludes hidden tabs and honors blur even when hasFocus still reports true", () => {
  visibility("hidden");
  render(<RecommendationItem {...props} />);
  observer().emit(1);
  advance(2_000);
  expect(impressions()).toBe(0);
  visibility("visible");
  advance(500);
  act(() => { window.dispatchEvent(new Event("blur")); });
  expect(document.hasFocus()).toBe(true);
  observer().emit(0.8);
  advance(2_000);
  expect(impressions()).toBe(0);
  act(() => { window.dispatchEvent(new Event("focus")); });
  advance(1_000);
  expect(impressions()).toBe(1);
});

it("does not start while unfocused and reacts to the explicit focus transition", () => {
  vi.mocked(document.hasFocus).mockReturnValue(false);
  render(<RecommendationItem {...props} />);
  observer().emit(1);
  advance(2_000);
  expect(impressions()).toBe(0);
  act(() => { window.dispatchEvent(new Event("focus")); });
  advance(1_000);
  expect(impressions()).toBe(1);
});

it("does not observe while disabled and cancels pending exposure when disabled", () => {
  const { rerender } = render(<RecommendationItem {...props} enabled={false} />);
  expect(observers).toHaveLength(0);
  rerender(<RecommendationItem {...props} />);
  const active = observer();
  active.emit(1);
  advance(500);
  rerender(<RecommendationItem {...props} enabled={false} />);
  advance(2_000);
  expect(impressions()).toBe(0);
  expect(active.disconnect).toHaveBeenCalledOnce();
});

it("cleans up timers, listeners, and late observer callbacks on unmount", () => {
  const { unmount } = render(<RecommendationItem {...props} />);
  const active = observer();
  active.emit(1);
  advance(500);
  unmount();
  active.emit(1);
  act(() => { window.dispatchEvent(new Event("focus")); });
  advance(2_000);
  expect(impressions()).toBe(0);
  expect(active.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("deduplicates exposures across remounts in one list session but counts a new session", () => {
  const first = render(<RecommendationItem {...props} />);
  observer().emit(1);
  advance(1_000);
  first.unmount();
  const second = render(<RecommendationItem {...props} />);
  observer().emit(1);
  advance(1_000);
  expect(impressions()).toBe(1);
  second.rerender(<RecommendationItem {...props} sessionId="next-list-session" />);
  observer().emit(1);
  advance(1_000);
  expect(impressions()).toBe(2);
});

it("renders without tracking when IntersectionObserver is unavailable", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const { getByText } = render(<RecommendationItem {...props} />);
  expect(getByText("Article")).toBeTruthy();
  advance(2_000);
  expect(impressions()).toBe(0);
});

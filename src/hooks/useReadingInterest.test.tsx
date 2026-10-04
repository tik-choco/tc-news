import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginReading, updateReading } from "../lib/interestStore";
import type { RecommendationCandidate } from "../lib/recommendationTypes";
import { useReadingInterest, type ReadingContentState } from "./useReadingInterest";

vi.mock("../lib/interestStore", () => ({ beginReading: vi.fn(), updateReading: vi.fn() }));

const candidate: RecommendationCandidate = {
  key: "feed:one", id: "one", type: "feed", title: "Games", summary: "News",
  tags: [], source: "example.com", publishedAt: 1,
};

function Reader({ item = candidate, state = "full" }: {
  item?: RecommendationCandidate | null;
  state?: ReadingContentState;
}) {
  useReadingInterest(item, state);
  return null;
}

function advance(ms: number) { act(() => { vi.advanceTimersByTime(ms); }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(beginReading).mockReturnValue("session-one");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("reading interest measurement", () => {
  it("opens once and does not count extraction or translation waiting", () => {
    const { rerender } = render(<Reader state="loading" />);
    advance(20_000);
    expect(updateReading).not.toHaveBeenCalled();
    rerender(<Reader item={{ ...candidate }} state="full" />);
    advance(5_000);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 5_000, "full");
    rerender(<Reader item={{ ...candidate, title: "Translated title" }} state="loading" />);
    advance(20_000);
    rerender(<Reader state="full" />);
    advance(5_000);
    expect(beginReading).toHaveBeenCalledTimes(1);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 10_000, "full");
  });

  it("flushes on backgrounding and excludes hidden and unfocused time", () => {
    render(<Reader />);
    advance(3_000);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 3_000, "full");
    advance(20_000);
    act(() => { window.dispatchEvent(new Event("focus")); });
    advance(2_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    advance(20_000);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 5_000, "full");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    advance(5_000);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 10_000, "full");
  });

  it("caps summary time separately so it cannot manufacture a full read", () => {
    const { rerender } = render(<Reader state="summary" />);
    advance(25_000);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 10_000, "summary");
    rerender(<Reader state="full" />);
    advance(5_000);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 5_000, "full");
  });

  it("stops after inactivity, resumes on interaction, and bounds total reading", () => {
    render(<Reader />);
    advance(90_000);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 30_000, "full");
    for (let i = 0; i < 6; i++) {
      act(() => { document.dispatchEvent(new Event("scroll")); });
      advance(20_000);
    }
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 120_000, "full");
  });

  it("flushes the previous candidate on navigation and stops on unmount", () => {
    const { rerender, unmount } = render(<Reader />);
    advance(2_000);
    const next = { ...candidate, key: "feed:two", id: "two" };
    rerender(<Reader item={next} />);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 2_000, "full");
    expect(beginReading).toHaveBeenCalledTimes(2);
    advance(1_000);
    unmount();
    expect(updateReading).toHaveBeenLastCalledWith(next, "session-one", 1_000, "full");
    const count = vi.mocked(updateReading).mock.calls.length;
    advance(60_000);
    expect(updateReading).toHaveBeenCalledTimes(count);
  });

  it("does not learn when disabled and never replaces the reset-invalidated session token", () => {
    vi.mocked(beginReading).mockReturnValueOnce(null);
    const { rerender } = render(<Reader />);
    advance(10_000);
    expect(updateReading).not.toHaveBeenCalled();
    rerender(<Reader item={null} />);
    rerender(<Reader />);
    advance(5_000);
    // A reset invalidates this token in the store. Re-renders must not silently
    // start a fresh session and reconstruct the deleted history on cleanup.
    vi.mocked(beginReading).mockReturnValue("new-session-after-reset");
    rerender(<Reader item={{ ...candidate }} state="summary" />);
    advance(5_000);
    expect(beginReading).toHaveBeenCalledTimes(2);
    expect(updateReading).toHaveBeenLastCalledWith(candidate, "session-one", 5_000, "summary");
  });
});

// @vitest-environment happy-dom
//
// safeSetItem's quota-recovery path is simulated by spying on
// localStorage.setItem and throwing a real QuotaExceededError DOMException —
// mirrors how browsers actually report a full quota (see isQuotaError()).
// The spy is restored in afterEach so it never leaks between tests (and so
// beforeEach's localStorage.clear() keeps working against the real store).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeSetItem } from "./safeStorage";

function quotaError(): DOMException {
  return new DOMException("quota exceeded", "QuotaExceededError");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeSetItem", () => {
  it("writes normally and returns true when there's no quota pressure", () => {
    expect(safeSetItem("tc-news:app-settings", "hello")).toBe(true);
    expect(localStorage.getItem("tc-news:app-settings")).toBe("hello");
  });

  it("evicts its own cache keys one at a time on QuotaExceededError, then succeeds", () => {
    localStorage.setItem("tc-news:page-extracts", "big-cache-blob");
    localStorage.setItem("tc-news:link-previews", "another-cache-blob");

    const realSetItem = localStorage.setItem.bind(localStorage);
    let calls = 0;
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      calls += 1;
      // Fail every attempt until the first evictable key (page-extracts,
      // first in EVICTABLE_KEYS) has actually been removed — this exercises
      // the "evict, then retry" loop rather than just a single retry.
      if (calls <= 1 && localStorage.getItem("tc-news:page-extracts") !== null) {
        throw quotaError();
      }
      realSetItem(key, value);
    });

    expect(safeSetItem("tc-news:articles", "[]")).toBe(true);
    expect(localStorage.getItem("tc-news:articles")).toBe("[]");
    // The cheapest-to-lose cache was evicted to make room.
    expect(localStorage.getItem("tc-news:page-extracts")).toBeNull();
    // A cache that wasn't needed for the retry to succeed is left alone.
    expect(localStorage.getItem("tc-news:link-previews")).toBe("another-cache-blob");
  });

  it("returns false without throwing when every eviction still leaves the quota full", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw quotaError();
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => safeSetItem("tc-news:articles", "[]")).not.toThrow();
    expect(safeSetItem("tc-news:articles", "[]")).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });
});

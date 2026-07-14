import { beforeEach, describe, expect, it } from "vitest";
import { importSharedFeed, isFeedAlreadyImported } from "./feedShare";
import { loadFeeds, saveFeeds } from "./feedStore";
import type { FeedSource } from "../types";

function feed(overrides: Partial<FeedSource> = {}): FeedSource {
  return {
    id: "feed-1",
    url: "https://example.com/feed.xml",
    label: "Example",
    enabled: true,
    addedAt: 0,
    ...overrides,
  };
}

describe("importSharedFeed", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("adds a new feed and reports imported: true", () => {
    const result = importSharedFeed("https://example.com/feed.xml", "Example Feed");
    expect(result).toEqual({ imported: true });
    const feeds = loadFeeds();
    expect(feeds).toHaveLength(1);
    expect(feeds[0].url).toBe("https://example.com/feed.xml");
    expect(feeds[0].label).toBe("Example Feed");
    expect(feeds[0].enabled).toBe(true);
  });

  it("falls back to the URL as the label when label is blank", () => {
    importSharedFeed("https://example.com/feed.xml", "   ");
    expect(loadFeeds()[0].label).toBe("https://example.com/feed.xml");
  });

  it("dispatches tc-news:feeds-updated on success", () => {
    let fired = 0;
    const handler = () => {
      fired += 1;
    };
    window.addEventListener("tc-news:feeds-updated", handler);
    try {
      importSharedFeed("https://example.com/feed.xml", "Example");
      expect(fired).toBe(1);
    } finally {
      window.removeEventListener("tc-news:feeds-updated", handler);
    }
  });

  it("reports duplicate and does not add when the URL is already registered", () => {
    saveFeeds([feed()]);
    const result = importSharedFeed("https://example.com/feed.xml", "Reshared label");
    expect(result).toEqual({ imported: false, reason: "duplicate" });
    expect(loadFeeds()).toHaveLength(1);
  });

  it("treats a trailing slash as the same feed for dedup purposes", () => {
    saveFeeds([feed({ url: "https://example.com/feed.xml/" })]);
    const result = importSharedFeed("https://example.com/feed.xml", "Example");
    expect(result).toEqual({ imported: false, reason: "duplicate" });
    expect(loadFeeds()).toHaveLength(1);
  });

  it("does not dispatch the update event on a duplicate", () => {
    saveFeeds([feed()]);
    let fired = 0;
    const handler = () => {
      fired += 1;
    };
    window.addEventListener("tc-news:feeds-updated", handler);
    try {
      importSharedFeed("https://example.com/feed.xml", "Example");
      expect(fired).toBe(0);
    } finally {
      window.removeEventListener("tc-news:feeds-updated", handler);
    }
  });

  it("returns imported: false for a blank URL without touching storage", () => {
    const result = importSharedFeed("   ", "Example");
    expect(result).toEqual({ imported: false });
    expect(loadFeeds()).toEqual([]);
  });
});

describe("isFeedAlreadyImported", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns false when no feed matches", () => {
    expect(isFeedAlreadyImported("https://example.com/feed.xml")).toBe(false);
  });

  it("returns true for an exact URL match", () => {
    saveFeeds([feed()]);
    expect(isFeedAlreadyImported("https://example.com/feed.xml")).toBe(true);
  });

  it("returns true when only trailing-slash differs", () => {
    saveFeeds([feed()]);
    expect(isFeedAlreadyImported("https://example.com/feed.xml/")).toBe(true);
  });
});

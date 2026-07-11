import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FeedItem } from "../types";
import { pickHeroImage } from "./generate";

// fetchLinkPreview hits the network; mock it so the OGP fallback path is
// deterministic. It never rejects in the real module, so tests only need to
// cover its resolved-value shapes.
const fetchLinkPreview = vi.fn<(url: string) => Promise<{ imageUrl?: string } | null>>();
vi.mock("./linkPreview", () => ({
  fetchLinkPreview: (url: string) => fetchLinkPreview(url),
}));

beforeEach(() => {
  fetchLinkPreview.mockReset();
});

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "item-1",
    feedId: "feed-1",
    title: "Title",
    link: "https://example.com/a",
    summary: "",
    feedLabel: "Feed",
    publishedAt: Date.now(),
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("pickHeroImage", () => {
  it("uses the first item's own imageUrl without calling fetchLinkPreview", async () => {
    const items = [item({ imageUrl: "https://example.com/hero.jpg" }), item({ link: "https://example.com/b" })];
    const result = await pickHeroImage(items);
    expect(result).toBe("https://example.com/hero.jpg");
    expect(fetchLinkPreview).not.toHaveBeenCalled();
  });

  it("falls back to the OGP image of the first source link when no item has an imageUrl", async () => {
    fetchLinkPreview.mockResolvedValueOnce({ imageUrl: "https://example.com/ogp.jpg" });
    const items = [item()];
    const result = await pickHeroImage(items);
    expect(result).toBe("https://example.com/ogp.jpg");
    expect(fetchLinkPreview).toHaveBeenCalledWith("https://example.com/a");
  });

  it("tries up to the first 3 items in order and stops at the first hit", async () => {
    fetchLinkPreview
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ imageUrl: "https://example.com/second.jpg" });
    const items = [
      item({ link: "https://example.com/1" }),
      item({ link: "https://example.com/2" }),
      item({ link: "https://example.com/3" }),
    ];
    const result = await pickHeroImage(items);
    expect(result).toBe("https://example.com/second.jpg");
    expect(fetchLinkPreview).toHaveBeenCalledTimes(2);
  });

  it("does not look past the first 3 items", async () => {
    fetchLinkPreview.mockResolvedValue(null);
    const items = [
      item({ link: "https://example.com/1" }),
      item({ link: "https://example.com/2" }),
      item({ link: "https://example.com/3" }),
      item({ link: "https://example.com/4" }),
    ];
    const result = await pickHeroImage(items);
    expect(result).toBeUndefined();
    expect(fetchLinkPreview).toHaveBeenCalledTimes(3);
  });

  it("resolves to undefined when nothing has an image", async () => {
    fetchLinkPreview.mockResolvedValue(null);
    const result = await pickHeroImage([item()]);
    expect(result).toBeUndefined();
  });
});

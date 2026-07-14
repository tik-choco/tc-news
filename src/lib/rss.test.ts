// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeedItems, fetchFeedTitle, parseFeedTitle, parseFeedXml } from "./rss";
import { tGlobal } from "./i18n";
import type { FeedSource } from "../types";

function makeSource(overrides: Partial<FeedSource> = {}): FeedSource {
  return {
    id: "feed-1",
    url: "https://example.com/feed.xml",
    label: "Example Feed",
    enabled: true,
    addedAt: 0,
    ...overrides,
  };
}

const RSS2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Channel</title>
    <link>https://example.com</link>
    <item>
      <title>First Article</title>
      <link>https://example.com/articles/first</link>
      <description>&lt;p&gt;This is the &lt;b&gt;first&lt;/b&gt; article summary.&lt;/p&gt;</description>
      <pubDate>Mon, 01 Jan 2024 09:00:00 GMT</pubDate>
      <guid>urn:example:first</guid>
    </item>
    <item>
      <title>Second Article</title>
      <link>https://example.com/articles/second</link>
      <description>Second summary without HTML.</description>
      <pubDate>Tue, 02 Jan 2024 10:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <entry>
    <title>Atom Entry One</title>
    <link rel="alternate" href="https://example.com/atom/one" />
    <id>tag:example.com,2024:atom-one</id>
    <updated>2024-01-03T12:00:00Z</updated>
    <summary>Atom entry summary &amp; more.</summary>
  </entry>
  <entry>
    <title>Atom Entry Two</title>
    <link href="https://example.com/atom/two" />
    <published>2024-01-04T08:15:00Z</published>
    <content type="html">&lt;div&gt;Full content body&lt;/div&gt;</content>
  </entry>
</feed>`;

describe("parseFeedXml", () => {
  it("parses RSS 2.0 items with guid, plain-text summary, and publishedAt", () => {
    const source = makeSource();
    const items = parseFeedXml(RSS2_XML, source, 1_700_000_000_000);

    expect(items).toHaveLength(2);

    const [first, second] = items;
    expect(first.id).toBe("urn:example:first");
    expect(first.title).toBe("First Article");
    expect(first.link).toBe("https://example.com/articles/first");
    expect(first.summary).toBe("This is the first article summary.");
    expect(first.feedId).toBe("feed-1");
    expect(first.feedLabel).toBe("Example Feed");
    expect(first.publishedAt).toBe(Date.parse("Mon, 01 Jan 2024 09:00:00 GMT"));
    expect(first.fetchedAt).toBe(1_700_000_000_000);

    // No <guid> present: falls back to a stable hash of the link.
    expect(second.id).toBeTruthy();
    expect(second.id).not.toBe("");
    expect(second.summary).toBe("Second summary without HTML.");
  });

  it("produces a stable id from the link when no guid is present", () => {
    const source = makeSource();
    const items1 = parseFeedXml(RSS2_XML, source);
    const items2 = parseFeedXml(RSS2_XML, source);
    expect(items1[1].id).toBe(items2[1].id);
  });

  it("parses Atom entries with id, href link, and updated/published dates", () => {
    const source = makeSource({ id: "feed-atom", label: "Atom Source" });
    const items = parseFeedXml(ATOM_XML, source, 1_700_000_000_000);

    expect(items).toHaveLength(2);

    const [first, second] = items;
    expect(first.id).toBe("tag:example.com,2024:atom-one");
    expect(first.title).toBe("Atom Entry One");
    expect(first.link).toBe("https://example.com/atom/one");
    expect(first.summary).toBe("Atom entry summary & more.");
    expect(first.publishedAt).toBe(Date.parse("2024-01-03T12:00:00Z"));
    expect(first.feedId).toBe("feed-atom");
    expect(first.feedLabel).toBe("Atom Source");

    // No <id>: falls back to a stable hash of the link.
    expect(second.id).toBeTruthy();
    expect(second.link).toBe("https://example.com/atom/two");
    expect(second.summary).toBe("Full content body");
    expect(second.publishedAt).toBe(Date.parse("2024-01-04T08:15:00Z"));
  });

  it("returns an empty array for XML with neither RSS items nor Atom entries", () => {
    const source = makeSource();
    const items = parseFeedXml("<rss><channel></channel></rss>", source);
    expect(items).toEqual([]);
  });

  it("truncates overly long summaries to 500 characters", () => {
    const longDescription = "a".repeat(1000);
    const xml = `<rss><channel><item><title>Long</title><link>https://example.com/long</link><description>${longDescription}</description></item></channel></rss>`;
    const items = parseFeedXml(xml, makeSource());
    expect(items[0].summary).toHaveLength(500);
  });

  it("leaves imageUrl/videoUrl undefined when an item has no media", () => {
    const items = parseFeedXml(RSS2_XML, makeSource());
    expect(items[0].imageUrl).toBeUndefined();
    expect(items[0].videoUrl).toBeUndefined();
  });

  it("picks the largest media:thumbnail by width", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <item>
      <title>Thumb Item</title>
      <link>https://example.com/articles/thumb</link>
      <description>No inline image here.</description>
      <media:thumbnail url="https://example.com/thumbs/small.jpg" width="100" />
      <media:thumbnail url="https://example.com/thumbs/large.jpg" width="300" />
    </item>
  </channel>
</rss>`;
    const items = parseFeedXml(xml, makeSource());
    expect(items[0].imageUrl).toBe("https://example.com/thumbs/large.jpg");
    expect(items[0].videoUrl).toBeUndefined();
  });

  it("picks the largest media:content flagged as an image, ignoring non-image content", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <item>
      <title>Content Item</title>
      <link>https://example.com/articles/content</link>
      <description>desc</description>
      <media:content url="https://example.com/media/small.jpg" width="200" type="image/jpeg" />
      <media:content url="https://example.com/media/large.jpg" width="800" type="image/jpeg" />
      <media:content url="https://example.com/media/audio.mp3" type="audio/mpeg" />
    </item>
  </channel>
</rss>`;
    const items = parseFeedXml(xml, makeSource());
    expect(items[0].imageUrl).toBe("https://example.com/media/large.jpg");
  });

  it("reads media:content/media:thumbnail nested inside media:group (YouTube Atom style) and rejects a player-page videoUrl", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>YouTube Channel</title>
  <entry>
    <title>YouTube Video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc123" />
    <id>yt:video:abc123</id>
    <published>2024-02-01T00:00:00Z</published>
    <media:group>
      <media:content url="https://www.youtube.com/v/abc123?version=3" type="application/x-shockwave-flash" width="640" height="390" medium="video" />
      <media:thumbnail url="https://i.ytimg.com/vi/abc123/hqdefault.jpg" width="480" height="360" />
    </media:group>
  </entry>
</feed>`;
    const items = parseFeedXml(xml, makeSource());
    expect(items[0].imageUrl).toBe("https://i.ytimg.com/vi/abc123/hqdefault.jpg");
    // medium="video" but the URL is a player page, not a direct media file.
    expect(items[0].videoUrl).toBeUndefined();
  });

  it("uses an <enclosure type=\"image/*\"> as imageUrl", () => {
    const xml = `<rss><channel><item><title>Enclosure Image</title><link>https://example.com/articles/enc-image</link><description>desc</description><enclosure url="https://example.com/enc/photo.png" type="image/png" length="1000" /></item></channel></rss>`;
    const items = parseFeedXml(xml, makeSource());
    expect(items[0].imageUrl).toBe("https://example.com/enc/photo.png");
  });

  it("uses an <enclosure type=\"video/*\"> pointing at a direct file as videoUrl", () => {
    const xml = `<rss><channel><item><title>Enclosure Video</title><link>https://example.com/articles/enc-video</link><description>desc</description><enclosure url="https://example.com/enc/clip.mp4" type="video/mp4" length="2000" /></item></channel></rss>`;
    const items = parseFeedXml(xml, makeSource());
    expect(items[0].videoUrl).toBe("https://example.com/enc/clip.mp4");
    expect(items[0].imageUrl).toBeUndefined();
  });

  it("extracts the first <img src> from an HTML description as a last resort", () => {
    // Note: happy-dom's XML parser (the environment these tests run under)
    // doesn't support CDATA sections at all, so this uses the equally
    // common entity-escaped-HTML form of embedding markup in a description
    // — DOMParser decodes it to the same textContent CDATA would produce.
    const xml = `<rss><channel><item><title>Escaped Image</title><link>https://example.com/articles/escaped-image</link><description>&lt;p&gt;Look at this &lt;img src="https://example.com/inline/pic.jpg" alt="pic" /&gt; photo.&lt;/p&gt;</description></item></channel></rss>`;
    const items = parseFeedXml(xml, makeSource());
    expect(items[0].imageUrl).toBe("https://example.com/inline/pic.jpg");
  });

  it("resolves a relative media URL against the item's link", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <item>
      <title>Relative Image</title>
      <link>https://example.com/articles/relative</link>
      <description>desc</description>
      <media:thumbnail url="/thumbs/rel.jpg" width="200" />
    </item>
  </channel>
</rss>`;
    const items = parseFeedXml(xml, makeSource());
    expect(items[0].imageUrl).toBe("https://example.com/thumbs/rel.jpg");
  });
});

describe("parseFeedTitle", () => {
  it("extracts the channel title from RSS 2.0", () => {
    expect(parseFeedTitle(RSS2_XML)).toBe("Example Channel");
  });

  it("extracts the feed title from Atom, not an entry's own title", () => {
    expect(parseFeedTitle(ATOM_XML)).toBe("Example Atom Feed");
  });

  it("extracts the channel title from RSS 1.0 / RDF feeds", () => {
    const rdfXml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://example.com/">
    <title>Example RDF Channel</title>
    <link>https://example.com</link>
  </channel>
  <item rdf:about="https://example.com/articles/first">
    <title>First Article</title>
    <link>https://example.com/articles/first</link>
  </item>
</rdf:RDF>`;
    expect(parseFeedTitle(rdfXml)).toBe("Example RDF Channel");
  });

  it("returns null for XML with neither a channel nor a feed title", () => {
    expect(parseFeedTitle("<rss><channel></channel></rss>")).toBeNull();
  });

  it("returns null for unparseable XML", () => {
    expect(parseFeedTitle("not xml at all <<<")).toBeNull();
  });
});

describe("fetchFeedTitle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the feed's title on a successful direct fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => RSS2_XML }),
    );
    await expect(fetchFeedTitle("https://example.com/feed.xml", "")).resolves.toBe("Example Channel");
  });

  it("falls back to the CORS proxy on a direct network-layer failure and still resolves the title", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => ATOM_XML });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchFeedTitle("https://example.com/feed.xml", "https://proxy.example.com/?url="),
    ).resolves.toBe("Example Atom Feed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves null (never throws) when both the direct and proxied fetch fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(
      fetchFeedTitle("https://example.com/feed.xml", "https://proxy.example.com/?url="),
    ).resolves.toBeNull();
  });
});

describe("fetchFeedItems", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws the dedicated no-CORS-proxy error when the direct fetch fails at the network layer and no proxy is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    const source = makeSource({ label: "The Verge" });

    await expect(fetchFeedItems(source, "")).rejects.toThrow(
      tGlobal("errors.feedFetchNoCorsProxy", { label: "The Verge" }),
    );
    // No proxy configured means there's nothing to retry through.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic feedFetchFailed error when a CORS proxy is configured but both the direct and proxied fetch fail", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const source = makeSource({ label: "The Verge" });

    await expect(fetchFeedItems(source, "https://proxy.example.com/?url=")).rejects.toThrow(
      tGlobal("errors.feedFetchFailed", { label: "The Verge", detail: "Failed to fetch" }),
    );
    // Direct attempt, then one retry through the proxy.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the generic feedFetchFailed error for a non-2xx HTTP response even with no proxy configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "" }),
    );
    const source = makeSource({ label: "The Verge" });

    await expect(fetchFeedItems(source, "")).rejects.toThrow(
      tGlobal("errors.feedFetchFailed", { label: "The Verge", detail: "HTTP 404" }),
    );
  });
});

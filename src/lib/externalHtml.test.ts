import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ARTICLE_URL = "https://publisher.example/news/story?topic=game%20design&lang=en#comments";
const CORS_PROXY = "https://proxy.example/?url=";
const ARTICLE_HTML = "<article><p>The complete article.</p></article>";

function setLocation(origin: string): void {
  vi.stubGlobal("location", new URL(`${origin}/tc-news/`));
}

function requestUrl(input: RequestInfo | URL): string {
  const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(value, location.href).href;
}

function proxyStatus(): Response {
  return new Response(JSON.stringify({ service: "tik-choco-dev-proxy", apps: ["tc-news", "tc-papers"] }), {
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DEV", true);
  setLocation("http://localhost:8180");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fetchExternalHtml", () => {
  it("loads RSS items and the feed title through the same relay without direct requests", async () => {
    const url = "https://publisher.example/feed.xml";
    const xml = '<rss><channel><title>News</title><item><guid>one</guid><title>Story</title></item></channel></rss>';
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => Promise.resolve(
      requestUrl(input).endsWith("/__dev__/status") ? proxyStatus() : new Response(xml),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFeedItems, fetchFeedTitle } = await import("./rss");
    const source = { id: "feed", url, label: "News", enabled: true, addedAt: 0 };

    expect(await fetchFeedItems(source, "")).toMatchObject([{ id: "one", title: "Story" }]);
    expect(await fetchFeedTitle(url, "")).toBe("News");
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "http://localhost:8180/__dev__/status",
      `http://localhost:8180/__cors/${url}`,
      `http://localhost:8180/__cors/${url}`,
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: "omit" });
  });

  it("retains the feed proxy fallback when the workspace relay fails", async () => {
    const url = "https://publisher.example/feed.xml";
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(proxyStatus())
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response('<rss><channel><title>News</title></channel></rss>'));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFeedTitle } = await import("./rss");

    expect(await fetchFeedTitle(url, CORS_PROXY)).toBe("News");
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "http://localhost:8180/__dev__/status",
      `http://localhost:8180/__cors/${url}`,
      url,
      CORS_PROXY + encodeURIComponent(url),
    ]);
  });

  it("uses the verified local relay without cookies and preserves the target query on every loopback host", async () => {
    for (const origin of ["http://localhost:8180", "http://127.0.0.1:8180", "http://[::1]:9234"]) {
      vi.resetModules();
      setLocation(origin);
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(proxyStatus())
        .mockResolvedValueOnce(new Response(ARTICLE_HTML));
      vi.stubGlobal("fetch", fetchMock);
      const { fetchExternalHtml } = await import("./externalHtml");

      expect(await fetchExternalHtml(ARTICLE_URL, CORS_PROXY)).toBe(ARTICLE_HTML);
      expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
        `${origin}/__dev__/status`,
        `${origin}/__cors/https://publisher.example/news/story?topic=game%20design&lang=en`,
      ]);
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: "omit" });
    }
  });

  it("falls back through direct fetching and the configured proxy when the local relay fails", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(proxyStatus())
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(ARTICLE_HTML));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchExternalHtml } = await import("./externalHtml");

    expect(await fetchExternalHtml(ARTICLE_URL, CORS_PROXY)).toBe(ARTICLE_HTML);
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "http://localhost:8180/__dev__/status",
      "http://localhost:8180/__cors/https://publisher.example/news/story?topic=game%20design&lang=en",
      ARTICLE_URL,
      CORS_PROXY + encodeURIComponent(ARTICLE_URL),
    ]);
  });

  it("returns null after all routes fail and skips an unconfigured proxy", async () => {
    vi.stubEnv("DEV", false);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchExternalHtml } = await import("./externalHtml");

    expect(await fetchExternalHtml(ARTICLE_URL, CORS_PROXY)).toBeNull();
    expect(await fetchExternalHtml(ARTICLE_URL, "")).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      ARTICLE_URL,
      CORS_PROXY + encodeURIComponent(ARTICLE_URL),
      ARTICLE_URL,
    ]);
  });

  it("does not probe for a local relay in production or on a non-loopback host", async () => {
    for (const [development, origin] of [[false, "http://localhost:8180"], [true, "https://news.example"]] as const) {
      vi.resetModules();
      vi.stubEnv("DEV", development);
      setLocation(origin);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(ARTICLE_HTML));
      vi.stubGlobal("fetch", fetchMock);
      const { fetchExternalHtml } = await import("./externalHtml");

      expect(await fetchExternalHtml(ARTICLE_URL, CORS_PROXY)).toBe(ARTICLE_HTML);
      expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([ARTICLE_URL]);
    }
  });

  it("uses direct fetching when the server is Vite alone or does not identify a mounted tc-news proxy", async () => {
    const statuses = [
      () => new Response("Not found", { status: 404 }),
      () => new Response("<!doctype html><html><body>Vite application</body></html>"),
      () => new Response(JSON.stringify({ service: "another-service", apps: ["tc-news"] })),
      () => new Response(JSON.stringify({ service: "tik-choco-dev-proxy", apps: ["tc-papers"] })),
    ];
    for (const status of statuses) {
      vi.resetModules();
      setLocation("http://localhost:5106");
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(status())
        .mockResolvedValueOnce(new Response(ARTICLE_HTML));
      vi.stubGlobal("fetch", fetchMock);
      const { fetchExternalHtml } = await import("./externalHtml");

      expect(await fetchExternalHtml(ARTICLE_URL, CORS_PROXY)).toBe(ARTICLE_HTML);
      expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
        "http://localhost:5106/__dev__/status", ARTICLE_URL,
      ]);
    }
  });

  it("shares the status probe across concurrent and later article requests", async () => {
    let resolveStatus!: (response: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => { resolveStatus = resolve; });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) =>
      requestUrl(input).endsWith("/__dev__/status")
        ? statusPromise
        : Promise.resolve(new Response(ARTICLE_HTML)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchExternalHtml } = await import("./externalHtml");

    const first = fetchExternalHtml("https://publisher.example/first", CORS_PROXY);
    const second = fetchExternalHtml("https://publisher.example/second", CORS_PROXY);
    resolveStatus(proxyStatus());
    expect(await Promise.all([first, second])).toEqual([ARTICLE_HTML, ARTICLE_HTML]);
    expect(await fetchExternalHtml("https://publisher.example/third", CORS_PROXY)).toBe(ARTICLE_HTML);
    const requests = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(requests.filter((url) => url.endsWith("/__dev__/status"))).toHaveLength(1);
    expect(requests.filter((url) => url.includes("/__cors/"))).toHaveLength(3);
  });

  it("does not relay same-origin or non-HTTP URLs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => Promise.resolve(
      requestUrl(input).endsWith("/__dev__/status") ? proxyStatus() : new Response(ARTICLE_HTML),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchExternalHtml } = await import("./externalHtml");

    for (const url of ["http://localhost:8180/article", "data:text/html,hello"]) {
      expect(await fetchExternalHtml(url, "")).toBe(ARTICLE_HTML);
    }
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes("/__cors/"))).toBe(false);
  });

  it("abandons an unresponsive status probe after 1.5 seconds and loads the article directly", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, options) => {
      if (!requestUrl(input).endsWith("/__dev__/status")) return Promise.resolve(new Response(ARTICLE_HTML));
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchExternalHtml } = await import("./externalHtml");

    const result = fetchExternalHtml(ARTICLE_URL, CORS_PROXY);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBe(ARTICLE_HTML);
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "http://localhost:8180/__dev__/status", ARTICLE_URL,
    ]);
  });
});

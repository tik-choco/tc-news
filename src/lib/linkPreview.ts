// OGP (Open Graph) link-preview fetching, parsing, and caching for the
// "URL card" mechanism — turning a plain article link into a title/image
// card the way chat apps do. Fetched HTML pages are parsed client-side (no
// server-side scraping service), cached via kvStore (mist KV, OPFS-backed;
// localStorage only as a pre-hydration/fallback path — see kvStore.ts's
// module header) to avoid re-fetching the same URL across sessions, and
// rate-limited so a feed view with dozens of links doesn't fire dozens of
// simultaneous requests.
import type { AppSettings } from "../types";
import { loadAppSettings } from "./appSettings";
import { kvGetSync, kvSetSync } from "./kvStore";

export interface LinkPreview {
  url: string; // the page URL this preview is for
  title?: string;
  description?: string;
  imageUrl?: string; // absolute http(s) URL
  videoUrl?: string; // only direct video files (.mp4/.webm/.ogv/.mov or og:video:type video/*) — never player/embed pages
  siteName?: string;
}

// ---------------------------------------------------------------------------
// Small URL/video helpers (deliberately not shared with rss.ts — this module
// stays self-contained so it has no coupling to feed-parsing internals).
// ---------------------------------------------------------------------------

function resolveUrl(raw: string | null | undefined, base: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    const url = base ? new URL(trimmed, base) : new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

const DIRECT_VIDEO_EXT_RE = /\.(mp4|webm|ogv|mov)(?:[?#]|$)/i;

/** Same rule as rss.ts: only accept URLs that clearly point at a playable
 * media file, so we never try to <video> an embed/watch page. */
function looksLikeDirectVideoFile(url: string): boolean {
  try {
    return /\.(mp4|webm|ogv|mov)$/i.test(new URL(url).pathname);
  } catch {
    return DIRECT_VIDEO_EXT_RE.test(url);
  }
}

// ---------------------------------------------------------------------------
// Pure HTML parsing
// ---------------------------------------------------------------------------

function metaContent(doc: Document, key: string): string | undefined {
  const el = doc.querySelector(`meta[property="${key}"]`) ?? doc.querySelector(`meta[name="${key}"]`);
  const content = el?.getAttribute("content")?.trim();
  return content || undefined;
}

/** Pure parser, exported for tests. Reads OGP tags (tolerating sites that
 * use `name=` instead of the spec-correct `property=`, and vice versa),
 * falling back to Twitter Card tags, then to plain <title>/<meta
 * name="description">. All URLs are resolved against `baseUrl`. */
export function parseLinkPreviewHtml(html: string, baseUrl: string): LinkPreview {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const title = metaContent(doc, "og:title") ?? metaContent(doc, "twitter:title") ?? textOf(doc.querySelector("title"));
  const description =
    metaContent(doc, "og:description") ?? metaContent(doc, "twitter:description") ?? metaContent(doc, "description");
  const siteName = metaContent(doc, "og:site_name");

  const ogImageRaw = metaContent(doc, "og:image:secure_url") ?? metaContent(doc, "og:image") ?? metaContent(doc, "twitter:image");
  let imageUrl = resolveUrl(ogImageRaw, baseUrl);
  if (!imageUrl) {
    const linkImageSrc = doc.querySelector('link[rel="image_src"]')?.getAttribute("href");
    imageUrl = resolveUrl(linkImageSrc, baseUrl);
  }
  if (!imageUrl) {
    const firstRealImg = Array.from(doc.querySelectorAll("img"))
      .map((img) => img.getAttribute("src"))
      .find((src) => src && !src.trim().toLowerCase().startsWith("data:"));
    imageUrl = resolveUrl(firstRealImg, baseUrl);
  }

  const ogVideoType = (metaContent(doc, "og:video:type") || "").toLowerCase();
  const ogVideoRaw = metaContent(doc, "og:video:secure_url") ?? metaContent(doc, "og:video:url") ?? metaContent(doc, "og:video");
  let videoUrl: string | undefined;
  if (ogVideoRaw) {
    const resolved = resolveUrl(ogVideoRaw, baseUrl);
    if (resolved && (looksLikeDirectVideoFile(resolved) || ogVideoType.startsWith("video/"))) {
      videoUrl = resolved;
    }
  }

  const preview: LinkPreview = { url: baseUrl };
  if (title) preview.title = title;
  if (description) preview.description = description;
  if (siteName) preview.siteName = siteName;
  if (imageUrl) preview.imageUrl = imageUrl;
  if (videoUrl) preview.videoUrl = videoUrl;
  return preview;
}

function textOf(el: Element | null | undefined): string | undefined {
  const text = el?.textContent?.trim();
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** loadAppSettings().showMediaPreviews !== false */
export function mediaPreviewsEnabled(): boolean {
  return loadAppSettings().showMediaPreviews !== false;
}

// ---------------------------------------------------------------------------
// Cache (kvStore-backed, in-memory mirrored)
// ---------------------------------------------------------------------------

const CACHE_KEY = "tc-news:link-previews";
const MAX_CACHE_ENTRIES = 300;
const TTL_HIT_MS = 7 * 24 * 60 * 60 * 1000; // successful previews: 7 days
const TTL_MISS_MS = 24 * 60 * 60 * 1000; // negative cache (fetch/parse failed): 1 day

interface CacheEntry {
  p: LinkPreview | null;
  at: number;
}

// In-memory mirror so repeated synchronous getCachedLinkPreview() calls
// (e.g. from render loops) don't re-parse the cached JSON blob each time.
// Lazily populated on first access.
let memoryCache: Record<string, CacheEntry> | null = null;

function loadCache(): Record<string, CacheEntry> {
  if (memoryCache) return memoryCache;
  try {
    const raw = kvGetSync(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    memoryCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, CacheEntry>) : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache;
}

function saveCache(cache: Record<string, CacheEntry>): void {
  let toPersist = cache;
  const entries = Object.entries(cache);
  if (entries.length > MAX_CACHE_ENTRIES) {
    // Evict oldest first.
    entries.sort((a, b) => b[1].at - a[1].at);
    toPersist = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
  }
  memoryCache = toPersist;
  // kvSetSync never throws; a dropped/fallback write degrades to
  // in-memory only — memoryCache above still keeps this session fast.
  kvSetSync(CACHE_KEY, JSON.stringify(toPersist));
}

function isFresh(entry: CacheEntry, now: number): boolean {
  const ttl = entry.p ? TTL_HIT_MS : TTL_MISS_MS;
  return now - entry.at < ttl;
}

function getFreshEntry(url: string): CacheEntry | undefined {
  const entry = loadCache()[url];
  return entry && isFresh(entry, Date.now()) ? entry : undefined;
}

function setCached(url: string, preview: LinkPreview | null): void {
  saveCache({ ...loadCache(), [url]: { p: preview, at: Date.now() } });
}

/** Synchronous cache lookup. null = not cached, expired, or negative-cached. */
export function getCachedLinkPreview(url: string): LinkPreview | null {
  const entry = getFreshEntry(url);
  return entry ? entry.p : null;
}

// ---------------------------------------------------------------------------
// Fetch: direct, then via CORS proxy; 10s timeout; small global concurrency
// limit so a view with dozens of links doesn't fire dozens of requests.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_FETCHES = 4;

let activeFetches = 0;
const waitQueue: Array<() => void> = [];

/** Resolves once a concurrency slot is free, with a release callback. FIFO
 * order, since feed items are usually requested roughly top-to-bottom. */
function acquireSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const release = () => {
      activeFetches--;
      const next = waitQueue.shift();
      if (next) next();
    };
    const tryAcquire = () => {
      activeFetches++;
      resolve(release);
    };
    if (activeFetches < MAX_CONCURRENT_FETCHES) tryAcquire();
    else waitQueue.push(tryAcquire);
  });
}

async function fetchWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url: string, settings: AppSettings): Promise<string | null> {
  try {
    return await fetchWithTimeout(url);
  } catch {
    // fall through to proxy below
  }
  if (settings.corsProxy) {
    try {
      return await fetchWithTimeout(settings.corsProxy + encodeURIComponent(url));
    } catch {
      // fall through to null below
    }
  }
  return null;
}

async function fetchAndParse(url: string): Promise<LinkPreview | null> {
  const settings = loadAppSettings();
  const html = await fetchHtml(url, settings);
  if (html === null) return null;
  try {
    return parseLinkPreviewHtml(html, url);
  } catch {
    return null;
  }
}

// Dedupe concurrent requests for the same URL.
const inFlight = new Map<string, Promise<LinkPreview | null>>();

/** Fetch (direct, then via corsProxy from loadAppSettings()), parse OGP, and
 * cache. Never rejects — resolves null on failure (and negative-caches it).
 * Concurrent calls for the same URL share one in-flight request. */
export function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  if (!mediaPreviewsEnabled()) return Promise.resolve(null);

  const fresh = getFreshEntry(url);
  if (fresh) return Promise.resolve(fresh.p);

  const existing = inFlight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    const release = await acquireSlot();
    try {
      const preview = await fetchAndParse(url);
      setCached(url, preview);
      return preview;
    } catch {
      // Belt-and-braces: fetchAndParse already swallows its own errors, but
      // this function must truly never reject.
      setCached(url, null);
      return null;
    } finally {
      release();
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, promise);
  return promise;
}

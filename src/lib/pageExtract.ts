// Readability-style full-text article extraction, used by the feed-item
// detail modal's "全文表示" (show full text) action. We don't reach for a
// library (e.g. @mozilla/readability) because the actual heuristic that
// matters here is small: score candidate containers by how much of their
// text lives in real <p> elements versus <a> elements (link farms —
// "related articles" rails, tag clouds — are mostly anchor text), pick the
// best-scoring one, resolve its relative URLs, and reduce it to a small
// allowed tag/attribute set. Keeping it in-house avoids a second,
// differently-shaped DOM dependency next to the DOMParser-based
// fetch/parse/cache pattern already established by rss.ts and
// linkPreview.ts, and keeps the whole thing testable as a pure function
// (extractReadableHtml takes no network/storage dependency at all).
//
// Deviation from the original plan: the tag/attribute allowlisting that
// would normally be DOMPurify's job is done here with plain DOM
// manipulation (see applyAllowlist below), and DOMPurify.sanitize() is only
// applied afterward, once, inside fetchReadablePage as a defense-in-depth
// pass (same spot ArticleReader.tsx calls it, right before
// dangerouslySetInnerHTML). Reason: under this repo's vitest environment
// (happy-dom), DOMPurify.sanitize() is unreliable — even a bare
// DOMPurify.sanitize("<p>hello</p>") with no config strips the <p> wrapper
// while DOMPurify.sanitize("<p><b>bold</b> text</p>") keeps <b> but not
// <p>, and configs passed via ALLOWED_TAGS/ALLOWED_ATTR were observed to
// have no effect at all in some calls within the same test file. DOMPurify
// upstream only documents/tests jsdom for non-browser DOM use, not
// happy-dom, so this looks like a happy-dom interop gap rather than a bug
// in our usage. Doing the real allowlist enforcement in plain DOM code
// means extractReadableHtml's output is deterministic and fully unit
// testable without depending on that interop; DOMPurify remains in the
// fetch path as a second, independent safety net for anything the manual
// pass missed (e.g. mutation-XSS-style edge cases), exactly like
// ArticleReader.tsx already relies on it for marked() output.
import DOMPurify from "dompurify";
import type { AppSettings } from "../types";
import { loadAppSettings } from "./appSettings";

export interface ExtractedPage {
  url: string;
  html: string; // DOMPurify-sanitized article HTML, safe for dangerouslySetInnerHTML
}

// ---------------------------------------------------------------------------
// Pure extraction (DOM scoring + cleanup + allowlist). No network, no
// storage — this is the part covered by pageExtract.test.ts.
// ---------------------------------------------------------------------------

// Elements/regions that are never article content, removed before scoring
// so they can't inflate a wrapper's paragraph-text score just by being a
// sibling of the real article body.
const NOISE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "iframe",
  "form",
  "nav",
  "aside",
  "header",
  "footer",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  ".share",
  ".sns",
  ".related",
  ".comments",
  ".ad",
  '[class*="advert"]',
].join(",");

const CANDIDATE_SELECTOR = 'article, main, [role="main"], [itemprop="articleBody"], div, section';

// Below this many characters of (link-discounted) paragraph text, a page is
// treated as having no real article body — e.g. a listing/index page, a
// paywall stub, or a login wall.
const MIN_PARAGRAPH_TEXT = 300;

// Rough cap on the sanitized output size. Extracted articles are rendered
// inline in a modal, not paginated, so an unbounded page (a "best of 2024"
// listicle, a live-blog) could otherwise balloon localStorage and the DOM.
const MAX_OUTPUT_CHARS = 150_000;

const ALLOWED_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "em",
  "strong",
  "a",
  "img",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "br",
  "hr",
  "span",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title"];
const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS);
const ALLOWED_ATTR_SET = new Set(ALLOWED_ATTR);

function removeNoise(root: ParentNode): void {
  root.querySelectorAll(NOISE_SELECTOR).forEach((el) => el.remove());
}

/** Sum of paragraph textContent length, with text inside <a> discounted by
 * half — a container whose paragraphs are mostly link text (nav rails,
 * "related articles" lists rendered as <p><a>...) scores much lower than one
 * with genuine prose, without needing to hard-exclude anything by tag name. */
function scoreElement(el: Element): number {
  let score = 0;
  el.querySelectorAll("p").forEach((p) => {
    const text = p.textContent || "";
    let linkLength = 0;
    p.querySelectorAll("a").forEach((a) => {
      linkLength += (a.textContent || "").length;
    });
    score += Math.max(0, text.length - linkLength * 0.5);
  });
  return score;
}

/** Picks the highest-scoring candidate container in `doc`. Ties keep the
 * first one encountered in document order (typically the outermost/most
 * semantic match, e.g. <article> before a nested <div>). Returns null when
 * nothing clears MIN_PARAGRAPH_TEXT — callers treat that as "no article
 * content on this page" rather than a hard error. */
function pickBestCandidate(doc: Document): Element | null {
  let best: Element | null = null;
  let bestScore = 0;
  doc.querySelectorAll(CANDIDATE_SELECTOR).forEach((el) => {
    const score = scoreElement(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  });
  if (!best || bestScore < MIN_PARAGRAPH_TEXT) return null;
  return best;
}

function resolveAttr(el: Element, attr: string, baseUrl: string): void {
  const raw = el.getAttribute(attr);
  if (!raw) return;
  try {
    const resolved = new URL(raw, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      el.removeAttribute(attr);
      return;
    }
    el.setAttribute(attr, resolved.toString());
  } catch {
    el.removeAttribute(attr);
  }
}

/** Resolves <img src> and <a href> against baseUrl in place, dropping the
 * attribute entirely when it doesn't resolve to an http(s) URL (relative
 * paths become absolute; javascript:/data:/mailto: etc. are stripped). */
function resolveUrls(root: Element, baseUrl: string): void {
  root.querySelectorAll("img[src]").forEach((el) => resolveAttr(el, "src", baseUrl));
  root.querySelectorAll("a[href]").forEach((el) => resolveAttr(el, "href", baseUrl));
}

/** Reduces `root`'s subtree to ALLOWED_TAGS/ALLOWED_ATTR in place: disallowed
 * elements (div wrappers, buttons, event-handler-bearing custom markup,
 * anything script/style already missed) are unwrapped — replaced by their
 * own children — rather than deleted outright, so legitimate text/inline
 * content nested inside a wrapper isn't lost; disallowed attributes
 * (onclick, style, class, ...) are simply removed. `root` itself is never
 * unwrapped (only its descendants) since callers only use its innerHTML.
 * Walking bottom-up (children before self) means unwrapping a node can't
 * disturb an ancestor's still-pending traversal. */
function applyAllowlist(root: Element): void {
  const visit = (el: Element) => {
    Array.from(el.children).forEach(visit);

    for (const attr of Array.from(el.attributes)) {
      if (!ALLOWED_ATTR_SET.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }

    if (el !== root && !ALLOWED_TAG_SET.has(el.tagName.toLowerCase())) {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
    }
  };
  visit(root);
}

/** Drops trailing children (not mid-tag truncation) until innerHTML fits
 * under the cap, or there's nothing left to drop. */
function capOutputSize(container: Element, maxChars: number): void {
  while (container.innerHTML.length > maxChars && container.lastElementChild) {
    container.removeChild(container.lastElementChild);
  }
}

/** Pure extraction (exported for tests). Parses `rawHtml`, scores candidate
 * containers by paragraph-text density, resolves URLs, and reduces the
 * winner to the ALLOWED_TAGS/ALLOWED_ATTR set — or returns null when
 * nothing article-like is found. Note: this does NOT run the result through
 * DOMPurify (see the module header comment for why); fetchReadablePage
 * applies that as an additional pass before caching/returning. */
export function extractReadableHtml(rawHtml: string, baseUrl: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(rawHtml, "text/html");
  } catch {
    return null;
  }

  removeNoise(doc);
  const best = pickBestCandidate(doc);
  if (!best) return null;

  const container = best.cloneNode(true) as Element;
  resolveUrls(container, baseUrl);
  applyAllowlist(container);
  capOutputSize(container, MAX_OUTPUT_CHARS);

  const cleaned = container.innerHTML.trim();
  return cleaned.length > 0 ? cleaned : null;
}

// ---------------------------------------------------------------------------
// Cache (localStorage-backed, in-memory mirrored) — mirrors linkPreview.ts's
// cache shape. Positive results are small in count but individually large
// (full article HTML), hence the much smaller MAX_CACHE_ENTRIES than
// link-previews get. Negative results (fetch failed, or the page had no
// extractable article) are cached in-memory only for the session: they're
// cheap to recompute and not worth risking localStorage quota on.
// ---------------------------------------------------------------------------

const CACHE_KEY = "tc-news:page-extracts";
const MAX_CACHE_ENTRIES = 30;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day, in-memory only

interface CacheEntry {
  html: string;
  at: number;
}

let memoryCache: Record<string, CacheEntry> | null = null;
const negativeCache = new Map<string, number>(); // url -> cached-at

function loadCache(): Record<string, CacheEntry> {
  if (memoryCache) return memoryCache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
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
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(toPersist));
  } catch {
    // Quota exceeded (extracted article HTML is large) or storage
    // unavailable (private mode) — degrade to in-memory only; memoryCache
    // above still keeps this session fast.
  }
}

function getFreshEntry(url: string): CacheEntry | undefined {
  const entry = loadCache()[url];
  return entry && Date.now() - entry.at < TTL_MS ? entry : undefined;
}

function setCached(url: string, html: string): void {
  saveCache({ ...loadCache(), [url]: { html, at: Date.now() } });
}

function isFreshNegative(url: string): boolean {
  const at = negativeCache.get(url);
  return at !== undefined && Date.now() - at < NEGATIVE_TTL_MS;
}

function setNegative(url: string): void {
  negativeCache.set(url, Date.now());
}

// ---------------------------------------------------------------------------
// Fetch: direct, then via CORS proxy; ~12s timeout. Same shape as
// rss.ts/linkPreview.ts's fetch fallback.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 12_000;

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

// Dedupe concurrent requests for the same URL.
const inFlight = new Map<string, Promise<ExtractedPage | null>>();

/** Fetch (direct, then via corsProxy from loadAppSettings()) + extract +
 * sanitize + cache. Never rejects — resolves null on any failure (network,
 * timeout, or "no article content found"). Concurrent calls for the same
 * URL share one in-flight request. */
export function fetchReadablePage(url: string): Promise<ExtractedPage | null> {
  const fresh = getFreshEntry(url);
  if (fresh) return Promise.resolve({ url, html: fresh.html });

  if (isFreshNegative(url)) return Promise.resolve(null);

  const existing = inFlight.get(url);
  if (existing) return existing;

  const promise = (async (): Promise<ExtractedPage | null> => {
    try {
      const settings = loadAppSettings();
      const rawHtml = await fetchHtml(url, settings);
      if (rawHtml === null) {
        setNegative(url);
        return null;
      }
      const extracted = extractReadableHtml(rawHtml, url);
      if (extracted === null) {
        setNegative(url);
        return null;
      }
      // Second, independent sanitization pass on top of extractReadableHtml's
      // own allowlist walk (see module header comment) — same DOMPurify call
      // shape ArticleReader.tsx uses for marked() output.
      const html = DOMPurify.sanitize(extracted, { ALLOWED_TAGS, ALLOWED_ATTR }).trim();
      if (html.length === 0) {
        setNegative(url);
        return null;
      }
      setCached(url, html);
      return { url, html };
    } catch {
      // Belt-and-braces: the steps above already swallow their own errors,
      // but this function must truly never reject.
      setNegative(url);
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, promise);
  return promise;
}

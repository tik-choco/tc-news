// RSS 2.0 / Atom feed fetching and parsing. No external XML library — the
// browser's DOMParser handles both formats well enough, and this keeps the
// dependency list (and bundle size) small.
import type { FeedItem, FeedSource } from "../types";
import { tGlobal } from "./i18n";

const MAX_SUMMARY_LENGTH = 500;

/** FNV-1a 32-bit hash, hex-encoded. Stable across sessions — used as a
 * fallback item id when the feed provides no guid/id. */
function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function textOf(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? "";
}

/** Strips HTML tags and decodes common entities, then truncates. Feed
 * descriptions are frequently HTML fragments even though they're delivered
 * as plain text/CDATA. */
function stripHtml(html: string): string {
  if (!html) return "";
  const withoutTags = html.replace(/<[^>]*>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SUMMARY_LENGTH ? collapsed.slice(0, MAX_SUMMARY_LENGTH) : collapsed;
}

function parseDate(value: string): number {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NaN : ms;
}

// ---------------------------------------------------------------------------
// Media extraction (imageUrl / videoUrl)
//
// RSS/Atom media conventions are inconsistent across publishers, so we try a
// priority-ordered list of well-known extension points before falling back
// to sniffing the first <img> in the item's HTML body. Everything here is
// best-effort: any failure (bad URL, missing attribute) just leaves the
// field unset rather than throwing, since a feed item without a thumbnail
// is still a perfectly valid item.
// ---------------------------------------------------------------------------

const CONTAINER_LOCAL_NAMES = new Set(["item", "entry"]);

function localNameOf(el: Element): string {
  const tag = el.tagName;
  const idx = tag.indexOf(":");
  return (idx === -1 ? tag : tag.slice(idx + 1)).toLowerCase();
}

/** True if `el` is nested inside `parent` without passing through another
 * item/entry container first. Needed because getElementsByTagName* searches
 * the *entire* subtree, and we only want elements that logically belong to
 * `parent` (an item, entry, or a media:group nested inside one) — not, say,
 * an element with the same local name that happens to live in a sibling
 * item somewhere further down the tree. */
function belongsDirectlyTo(el: Element, parent: Element): boolean {
  let cur = el.parentElement;
  while (cur && cur !== parent) {
    if (CONTAINER_LOCAL_NAMES.has(localNameOf(cur))) return false;
    cur = cur.parentElement;
  }
  return cur === parent;
}

/** Finds descendants of `parent` matching local name `local` (optionally
 * with an exact prefix like "media:content"), regardless of how namespaces
 * were declared in the source document. querySelector can't match
 * namespaced tags reliably across browsers, so we combine a literal-prefix
 * lookup with a namespace-wildcard lookup and dedupe the results. */
function childrenByLocalName(parent: Element, local: string, prefix?: string): Element[] {
  const seen = new Set<Element>();
  const results: Element[] = [];
  const collect = (list: HTMLCollectionOf<Element>) => {
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (seen.has(el) || !belongsDirectlyTo(el, parent)) continue;
      seen.add(el);
      results.push(el);
    }
  };
  collect(parent.getElementsByTagName(prefix ? `${prefix}:${local}` : local));
  collect(parent.getElementsByTagNameNS("*", local));
  return results;
}

function widthOf(el: Element): number {
  const n = parseInt(el.getAttribute("width") || "", 10);
  return Number.isFinite(n) ? n : -1;
}

/** Picks the element with the largest `width` attribute; ties keep the
 * first one encountered. Returns undefined for an empty list. */
function pickLargestByWidth(elements: Element[]): Element | undefined {
  return elements.reduce<Element | undefined>(
    (best, el) => (best === undefined || widthOf(el) > widthOf(best) ? el : best),
    undefined,
  );
}

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

/** A "video" enclosure/media:content is only useful to us if it points at an
 * actual media file we can hand to <video>. Player/embed pages (YouTube
 * watch URLs, Vimeo pages, etc.) also get tagged medium="video" by some
 * feeds, but they need an <iframe>, not <video> — we exclude those here and
 * rely on the thumbnail instead. */
function looksLikeDirectVideoFile(url: string): boolean {
  try {
    return /\.(mp4|webm|ogv|mov)$/i.test(new URL(url).pathname);
  } catch {
    return DIRECT_VIDEO_EXT_RE.test(url);
  }
}

const IMG_SRC_RE = /<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i;

/** Regex-scans a raw (unparsed) HTML fragment for the first <img src>. Used
 * on item descriptions/content, which are HTML strings embedded in the feed
 * XML — we deliberately avoid re-parsing them with DOMParser since they can
 * be arbitrarily large, and this only needs to run once as a last resort. */
function firstImgSrcInHtml(html: string): string | undefined {
  return IMG_SRC_RE.exec(html)?.[1];
}

/** Extracts imageUrl/videoUrl from an RSS <item> or Atom <entry>, per the
 * priority order documented on FeedItem. `base` resolves relative URLs and
 * should be the item's own link (falling back to the feed URL). */
function extractMedia(item: Element, base: string): { imageUrl?: string; videoUrl?: string } {
  const mediaGroups = childrenByLocalName(item, "group", "media");
  const mediaContents = [
    ...childrenByLocalName(item, "content", "media"),
    ...mediaGroups.flatMap((g) => childrenByLocalName(g, "content", "media")),
  ];
  const mediaThumbnails = [
    ...childrenByLocalName(item, "thumbnail", "media"),
    ...mediaGroups.flatMap((g) => childrenByLocalName(g, "thumbnail", "media")),
  ];
  const enclosures = childrenByLocalName(item, "enclosure");

  let imageUrl: string | undefined;

  // 1) media:content flagged as an image (largest width wins).
  const imageContents = mediaContents.filter((el) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    return type.startsWith("image/") || el.getAttribute("medium") === "image";
  });
  imageUrl = resolveUrl(pickLargestByWidth(imageContents)?.getAttribute("url"), base);

  // 2) media:thumbnail (largest width wins).
  if (!imageUrl) {
    imageUrl = resolveUrl(pickLargestByWidth(mediaThumbnails)?.getAttribute("url"), base);
  }

  // 3) <enclosure type="image/*">
  if (!imageUrl) {
    const imageEnclosure = enclosures.find((el) => (el.getAttribute("type") || "").toLowerCase().startsWith("image/"));
    imageUrl = resolveUrl(imageEnclosure?.getAttribute("url"), base);
  }

  // 4) <itunes:image href="...">
  if (!imageUrl) {
    const itunesImage = childrenByLocalName(item, "image", "itunes")[0];
    imageUrl = resolveUrl(itunesImage?.getAttribute("href"), base);
  }

  // 5) first <img> found in the item's raw HTML body.
  if (!imageUrl) {
    const encoded = childrenByLocalName(item, "encoded", "content")[0];
    const htmlCandidates = [
      textOf(item.querySelector("description")),
      textOf(encoded),
      textOf(item.querySelector("content")),
      textOf(item.querySelector("summary")),
    ];
    for (const html of htmlCandidates) {
      imageUrl = resolveUrl(firstImgSrcInHtml(html), base);
      if (imageUrl) break;
    }
  }

  let videoUrl: string | undefined;

  const videoEnclosure = enclosures.find((el) => (el.getAttribute("type") || "").toLowerCase().startsWith("video/"));
  if (videoEnclosure) {
    const url = videoEnclosure.getAttribute("url");
    if (url && looksLikeDirectVideoFile(url)) videoUrl = resolveUrl(url, base);
  }
  if (!videoUrl) {
    const videoContent = mediaContents.find((el) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return type.startsWith("video/") || el.getAttribute("medium") === "video";
    });
    const url = videoContent?.getAttribute("url");
    if (url && looksLikeDirectVideoFile(url)) videoUrl = resolveUrl(url, base);
  }

  const result: { imageUrl?: string; videoUrl?: string } = {};
  if (imageUrl) result.imageUrl = imageUrl;
  if (videoUrl) result.videoUrl = videoUrl;
  return result;
}

function parseRss2Item(item: Element, source: FeedSource, now: number): FeedItem {
  const title = textOf(item.querySelector("title"));
  const link = textOf(item.querySelector("link"));
  const description = textOf(item.querySelector("description"));
  const pubDate = textOf(item.querySelector("pubDate")) || textOf(item.querySelector("date"));
  const guid = textOf(item.querySelector("guid"));

  const publishedAt = parseDate(pubDate);
  const id = guid || (link ? fnv1aHash(link) : fnv1aHash(title + pubDate));

  return {
    id,
    feedId: source.id,
    feedLabel: source.label,
    title,
    link,
    summary: stripHtml(description),
    publishedAt: Number.isNaN(publishedAt) ? now : publishedAt,
    fetchedAt: now,
    ...extractMedia(item, link || source.url),
  };
}

function atomEntryLink(entry: Element): string {
  // Prefer rel="alternate" (or no rel, which defaults to alternate); fall
  // back to the first link with an href if none match.
  const links = Array.from(entry.querySelectorAll("link"));
  const alternate = links.find((l) => {
    const rel = l.getAttribute("rel");
    return !rel || rel === "alternate";
  });
  return (alternate ?? links[0])?.getAttribute("href")?.trim() ?? "";
}

function parseAtomEntry(entry: Element, source: FeedSource, now: number): FeedItem {
  const title = textOf(entry.querySelector("title"));
  const link = atomEntryLink(entry);
  const summaryEl = entry.querySelector("summary") ?? entry.querySelector("content");
  const summary = textOf(summaryEl);
  const dateStr = textOf(entry.querySelector("updated")) || textOf(entry.querySelector("published"));
  const idEl = textOf(entry.querySelector("id"));

  const publishedAt = parseDate(dateStr);
  const id = idEl || (link ? fnv1aHash(link) : fnv1aHash(title + dateStr));

  return {
    id,
    feedId: source.id,
    feedLabel: source.label,
    title,
    link,
    summary: stripHtml(summary),
    publishedAt: Number.isNaN(publishedAt) ? now : publishedAt,
    fetchedAt: now,
    ...extractMedia(entry, link || source.url),
  };
}

/** Parses raw feed XML (RSS 2.0 or Atom) into normalized FeedItem[]. Returns
 * [] for unparseable input rather than throwing — callers treat an empty
 * result as "nothing new", which is the safe default for a background poll. */
export function parseFeedXml(xml: string, source: FeedSource, now: number = Date.now()): FeedItem[] {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return [];
  }
  if (doc.querySelector("parsererror")) return [];

  const rssItems = Array.from(doc.querySelectorAll("channel > item"));
  if (rssItems.length > 0) {
    return rssItems.map((item) => parseRss2Item(item, source, now));
  }

  const atomEntries = Array.from(doc.querySelectorAll("feed > entry"));
  if (atomEntries.length > 0) {
    return atomEntries.map((entry) => parseAtomEntry(entry, source, now));
  }

  return [];
}

/** Extracts the feed-wide title (not an item/entry title) for auto-labeling
 * a newly added source. `channel > title` covers both RSS 2.0 and RSS
 * 1.0/RDF (whose <channel> is a direct child of the <rdf:RDF> root, in the
 * feed's default namespace, so the unprefixed selector still matches).
 * `feed > title` covers Atom — a direct-child selector so it doesn't pick up
 * an <entry>'s own <title> instead. Returns null for unparseable XML or a
 * feed with no discoverable title. */
export function parseFeedTitle(xml: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return null;
  }
  if (doc.querySelector("parsererror")) return null;

  const channelTitle = textOf(doc.querySelector("channel > title"));
  if (channelTitle) return channelTitle;

  const feedTitle = textOf(doc.querySelector("feed > title"));
  if (feedTitle) return feedTitle;

  return null;
}

async function tryFetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Fetches `url` directly; on any failure (network error or non-2xx),
 * retries once through `corsProxy` (if configured) before giving up. Shared
 * by fetchFeedItems and fetchFeedTitle so both get the same direct→proxy
 * fallback behavior. */
async function fetchXmlWithProxyFallback(
  url: string,
  corsProxy: string,
): Promise<{ xml: string | null; directFailedAsNetworkError: boolean; lastError: unknown }> {
  let xml: string | null = null;
  let lastError: unknown = null;
  // TypeError is what fetch() throws for network-layer failures (a CORS
  // rejection or being offline) — as opposed to the `Error("HTTP …")` that
  // tryFetchText throws for a non-2xx response, which no proxy can fix.
  let directFailedAsNetworkError = false;

  try {
    xml = await tryFetchText(url);
  } catch (err) {
    lastError = err;
    directFailedAsNetworkError = err instanceof TypeError;
  }

  if (xml === null && corsProxy) {
    try {
      xml = await tryFetchText(corsProxy + encodeURIComponent(url));
    } catch (err) {
      lastError = err;
    }
  }

  return { xml, directFailedAsNetworkError, lastError };
}

/** Fetches a feed directly; on any failure (network error or non-2xx),
 * retries once through the configured CORS proxy before giving up. */
export async function fetchFeedItems(source: FeedSource, corsProxy: string): Promise<FeedItem[]> {
  const { xml, directFailedAsNetworkError, lastError } = await fetchXmlWithProxyFallback(source.url, corsProxy);

  if (xml === null) {
    // Direct fetch failed at the network layer and there's no proxy
    // configured to retry through: this is a permanent CORS dead end, not a
    // transient failure, so point the user at the fix instead of the raw
    // (unhelpful, unclearable) network error message.
    if (directFailedAsNetworkError && !corsProxy) {
      throw new Error(tGlobal("errors.feedFetchNoCorsProxy", { label: source.label || source.url }));
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(tGlobal("errors.feedFetchFailed", { label: source.label || source.url, detail }));
  }

  return parseFeedXml(xml, source, Date.now());
}

/** Best-effort fetch of a feed's title, for auto-populating a newly added
 * source's label. Unlike fetchFeedItems, failures resolve to null instead of
 * throwing — a missing title just leaves the caller's placeholder label in
 * place, which is not worth surfacing as an error. */
export async function fetchFeedTitle(url: string, corsProxy: string): Promise<string | null> {
  const { xml } = await fetchXmlWithProxyFallback(url, corsProxy);
  if (xml === null) return null;
  return parseFeedTitle(xml);
}

// Shared article/preview/feed transport. The workspace dev proxy can fetch public
// pages server-side; identify it before using its same-origin CORS relay.
const FETCH_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 1_500;
let devProxyAvailable: Promise<boolean> | undefined;

async function fetchText(url: string, timeout = FETCH_TIMEOUT_MS, options: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function localRelayUrl(url: string): Promise<string | null> {
  if (!import.meta.env.DEV || typeof location === "undefined") return null;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return null;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(target.protocol) || target.origin === location.origin) return null;

  // A plain Vite server also runs on localhost. Its SPA fallback must never
  // be mistaken for article HTML, so require the shared proxy's status reply.
  devProxyAvailable ??= fetchText(`${location.origin}/__dev__/status`, PROBE_TIMEOUT_MS, {
    credentials: "omit",
    redirect: "error",
  }).then((text) => {
    const status = JSON.parse(text);
    return status?.service === "tik-choco-dev-proxy" && Array.isArray(status.apps) && status.apps.includes("tc-news");
  }).catch(() => false);

  if (!(await devProxyAvailable)) return null;
  target.hash = "";
  // This relay expects the raw absolute URL, including its original query.
  return `${location.origin}/__cors/${target.href}`;
}

/** Fetch text through the verified workspace relay, if available. */
export async function fetchLocalRelayText(
  url: string,
  timeout = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const relayUrl = await localRelayUrl(url);
  if (relayUrl) {
    try {
      // The workspace relay forwards request headers. Do not send local
      // browser cookies to the external article's server through it.
      return await fetchText(relayUrl, timeout, { credentials: "omit" });
    } catch {
      // The relay or this particular site may be unavailable; try normally.
    }
  }
  return null;
}

/** Best-effort HTML fetch. Prefer an identified local dev relay; otherwise
 * use the original direct -> configured CORS proxy fallback. */
export async function fetchExternalHtml(
  url: string,
  corsProxy: string,
  timeout = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const relayed = await fetchLocalRelayText(url, timeout);
  if (relayed !== null) return relayed;
  try {
    return await fetchText(url, timeout);
  } catch {
    // Cross-origin sites commonly reject browser fetches.
  }
  if (corsProxy) {
    try {
      return await fetchText(corsProxy + encodeURIComponent(url), timeout);
    } catch {
      // Preserve the callers' summary/preview fallback on failure.
    }
  }
  return null;
}

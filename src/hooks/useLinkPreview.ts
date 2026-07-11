// Fetches and caches a lightweight link preview (title/description/media)
// for a single URL. Reads a synchronous cache hit on mount (or a negative
// cache entry) so previously-fetched previews render without a flash, then
// falls back to an async fetch that guards against unmount and against the
// url prop changing mid-flight (stale-response check).
import { useEffect, useState } from "preact/hooks";
import {
  fetchLinkPreview,
  getCachedLinkPreview,
  mediaPreviewsEnabled,
  type LinkPreview,
} from "../lib/linkPreview";

export function useLinkPreview(url: string | null | undefined): LinkPreview | null {
  const [preview, setPreview] = useState<LinkPreview | null>(() =>
    url && mediaPreviewsEnabled() ? getCachedLinkPreview(url) : null,
  );

  useEffect(() => {
    if (!url || !mediaPreviewsEnabled()) {
      setPreview(null);
      return;
    }

    const cached = getCachedLinkPreview(url);
    setPreview(cached);
    if (cached) return;

    let cancelled = false;
    void fetchLinkPreview(url).then((result) => {
      if (cancelled) return;
      setPreview(result);
    });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return preview;
}

export type { LinkPreview } from "../lib/linkPreview";

// Feed item detail modal: opened from a FeedItemCard click. Shows the
// item's full text (via lib/pageExtract's readability fetch, falling back to
// the RSS summary + OGP description when extraction fails) plus a compact
// horizontal URL-preview card (same .source-link-card look as the article
// reader's source list — a full-width hero image pushed the text below the
// fold), a category chip, a translate-on-demand control that enqueues into
// the global AI job queue (lib/jobQueue) and mirrors the
// article reader's original/translated toggle — the job survives the modal
// being closed, since the queue (not local state) owns its lifecycle — and
// a footer that mirrors the card's selection affordance so the generate
// flow works the same way from either place.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Check, ExternalLink, Languages, Loader2, Sparkles, X } from "lucide-preact";
import type { FeedItem } from "../types";
import { useLinkPreview } from "../hooks/useLinkPreview";
import { mediaPreviewsEnabled } from "../lib/linkPreview";
import { fetchReadablePage, type ExtractedPage } from "../lib/pageExtract";
import { formatRelativeTime } from "./ArticleCard";
import { LOCALE_LABELS, useLocale, useT } from "../lib/i18n";
import { categoryLabelKey, coerceCategory } from "../lib/categories";
import { translateFeedContent } from "../lib/feedTranslate";
import { getFeedTranslation, saveFeedTranslation } from "../lib/feedTranslationStore";
import { enqueueJob, isCancelError } from "../lib/jobQueue";
import { useJobQueue } from "../hooks/useJobQueue";
import "../styles/components.css";
import "../styles/feedModal.css";

/** Exit-animation duration — must match the `.fim-*--closing` CSS duration
 * in styles/feedModal.css so the unmount is delayed exactly long enough for
 * the reverse animation to finish. */
const CLOSE_ANIM_MS = 200;

export function FeedItemModal(props: {
  item: FeedItem;
  selected: boolean;
  onToggleSelect: () => void;
  onClose: () => void;
}): JSX.Element {
  const { item, selected, onToggleSelect, onClose } = props;
  const t = useT();
  const { locale } = useLocale();

  // Unlike FeedItemCard, always fetch the OGP preview (cached) even when the
  // feed provided media — the link card below also wants title/description/
  // site name, which only OGP can supply.
  const preview = useLinkPreview(mediaPreviewsEnabled() ? item.link : null);
  const imageUrl = mediaPreviewsEnabled() ? (item.imageUrl ?? preview?.imageUrl) : undefined;
  const videoUrl = mediaPreviewsEnabled() ? (item.videoUrl ?? preview?.videoUrl) : undefined;
  const [imgFailed, setImgFailed] = useState(false);

  const category = coerceCategory(item.category);

  // undefined = still loading, null = extraction failed/unavailable.
  const [page, setPage] = useState<ExtractedPage | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setPage(undefined);
    void fetchReadablePage(item.link).then((result) => {
      if (cancelled) return;
      setPage(result);
    });
    return () => {
      cancelled = true;
    };
  }, [item.link]);

  // Translate flow state. Single-flight is now enforced by the global
  // AI job queue (dedup on kind+targetId+lang), not local state — we
  // just look up whether a job for this item+locale is still in flight.
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [showTranslated, setShowTranslated] = useState(false);
  // Not stateful — re-read on every render, same idiom as ArticlesView's
  // cachedTranslation.
  const cachedTranslation = getFeedTranslation(item.id, locale);

  // Re-renders whenever any queued job changes, which is what lets the
  // per-render getFeedTranslation() read above pick up a completed
  // translation even though we don't hold the result in local state.
  const jobs = useJobQueue();
  const pendingJob =
    jobs.find(
      (j) =>
        j.kind === "feed" &&
        j.targetId === item.id &&
        j.lang === locale &&
        (j.status === "queued" || j.status === "running" || j.status === "cancelling"),
    ) ?? null;

  function handleTranslate() {
    setTranslateError(null);
    void enqueueJob(
      { kind: "feed", targetId: item.id, label: item.title || item.link, lang: locale },
      async (signal) => {
        // Fetch (or re-use the cached) readable page inside the job so the
        // translation survives the modal closing and doesn't wait on the
        // modal's own extraction effect. fetchReadablePage dedupes in-flight
        // requests and caches, so this is free when the modal already loaded it.
        const extracted = await fetchReadablePage(item.link);
        const result = await translateFeedContent(
          { title: item.title, summary: item.summary, html: extracted?.html ?? null },
          { profileId: "", targetLanguage: LOCALE_LABELS[locale], signal },
        );
        saveFeedTranslation({ itemId: item.id, lang: locale, ...result, translatedAt: Date.now() });
        return result;
      },
    )
      .then(() => setShowTranslated(true))
      .catch((err) => {
        // setShowTranslated/setTranslateError after unmount is a harmless
        // no-op in Preact — the queue toast is the durable progress surface,
        // this local state only matters while the modal is still open.
        if (!isCancelError(err)) setTranslateError(err instanceof Error ? err.message : String(err));
      });
  }

  // All close paths (overlay click, X button, Escape) funnel through here so
  // the exit animation always plays before the item actually unmounts.
  const [closing, setClosing] = useState(false);
  function requestClose() {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, CLOSE_ANIM_MS);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  return (
    <div class={`fim-overlay${closing ? " fim-overlay--closing" : ""}`} onClick={requestClose}>
      <div
        class={`fim-panel${closing ? " fim-panel--closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("feed.itemDialogAria")}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          class="fim-close"
          onClick={requestClose}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <X size={18} />
        </button>

        <header class="fim-header">
          <a class="fim-title" href={item.link} target="_blank" rel="noopener noreferrer">
            {(showTranslated && cachedTranslation ? cachedTranslation.title : item.title) || t("feed.untitledItem")}
          </a>
          <div class="fim-meta">
            <span>{item.feedLabel}</span>
            <span class="fim-dot" aria-hidden="true">
              ・
            </span>
            <span>{formatRelativeTime(item.publishedAt, locale)}</span>
            {category ? <span class="category-chip">{t(categoryLabelKey(category))}</span> : null}
            {showTranslated && cachedTranslation ? (
              <span class="badge">{t("translate.translatedBadge", { lang: LOCALE_LABELS[locale] })}</span>
            ) : null}
          </div>
        </header>

        {mediaPreviewsEnabled() ? (
          <div class="fim-linkcard">
            <a class="source-link-card" href={item.link} target="_blank" rel="noopener noreferrer">
              {videoUrl ? (
                <video
                  class="source-link-card-thumb"
                  src={videoUrl}
                  controls
                  preload="none"
                  poster={imageUrl}
                  playsInline
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                />
              ) : imageUrl && !imgFailed ? (
                <img
                  class="source-link-card-thumb"
                  src={imageUrl}
                  alt=""
                  loading="lazy"
                  referrerpolicy="no-referrer"
                  onError={() => setImgFailed(true)}
                />
              ) : (
                <div class="source-link-card-thumb source-link-card-thumb--placeholder">
                  <ExternalLink size={18} />
                </div>
              )}
              <div class="source-link-card-body">
                <span class="source-link-card-title">{preview?.title || item.title || item.link}</span>
                {preview?.description ? (
                  <span class="source-link-card-desc">{preview.description}</span>
                ) : null}
                <span class="source-link-card-site">{preview?.siteName || hostnameOf(item.link)}</span>
              </div>
            </a>
          </div>
        ) : null}

        <div class="fim-body">
          {translateError ? <p class="fim-translate-error">{translateError}</p> : null}
          {showTranslated && cachedTranslation ? (
            <>
              {cachedTranslation.html ? (
                <div class="fim-article" dangerouslySetInnerHTML={{ __html: cachedTranslation.html }} />
              ) : (
                <p class="fim-summary">{cachedTranslation.summary}</p>
              )}
              {cachedTranslation.truncated ? <p class="fim-fallback-note">{t("translate.truncatedNote")}</p> : null}
            </>
          ) : page === undefined ? (
            <div class="fim-loading">
              <Loader2 size={16} class="spin" />
              <span>{t("feed.fullTextLoading")}</span>
            </div>
          ) : page ? (
            <div class="fim-article" dangerouslySetInnerHTML={{ __html: page.html }} />
          ) : (
            <>
              {item.summary ? <p class="fim-summary">{item.summary}</p> : null}
              {preview?.description ? <p class="fim-summary">{preview.description}</p> : null}
              <p class="fim-fallback-note">{t("feed.fullTextFailed")}</p>
            </>
          )}
        </div>

        <footer class="fim-footer">
          <button type="button" class="btn btn-primary" onClick={onToggleSelect}>
            {selected ? <Check size={15} /> : <Sparkles size={15} />}
            {selected ? t("feed.removeFromSelection") : t("feed.addToSelection")}
          </button>
          {cachedTranslation ? (
            <button type="button" class="btn btn-ghost" onClick={() => setShowTranslated((v) => !v)}>
              <Languages size={15} />
              {showTranslated ? t("translate.showOriginal") : t("translate.showTranslated")}
            </button>
          ) : (
            <button
              type="button"
              class="btn btn-ghost"
              disabled={pendingJob !== null}
              onClick={handleTranslate}
            >
              <Languages size={15} />
              {pendingJob?.status === "queued"
                ? t("translate.statusQueued")
                : pendingJob
                  ? t("translate.translating")
                  : t("translate.translate")}
            </button>
          )}
          <a class="btn btn-ghost" href={item.link} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} />
            {t("feed.readOriginal")}
          </a>
        </footer>
      </div>
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Compact article summary card: title, excerpt, tag chips, author + relative
// time. Used by ArticlesView (own articles, with an actions slot for
// share/delete) and SharedView (received articles, read-only). Hover lifts
// the card slightly (translateY + shadow) — see styles/components.css.
import type { ComponentChildren, JSX } from "preact";
import { memo } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import type { NewsArticle } from "../types";
import { translate, useLocale, useT, type Locale } from "../lib/i18n";
import { categoryLabelKey, coerceCategory } from "../lib/categories";
import { mediaPreviewsEnabled } from "../lib/linkPreview";
import { useLinkPreview } from "../hooks/useLinkPreview";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Intl.RelativeTimeFormat construction is non-trivial and formatRelativeTime
// is called once per card per render — cache one formatter per locale
// instead of rebuilding it on every call (there are typically only 1-2
// locales in play, so this map stays tiny for the life of the tab).
const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function getRelativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  let rtf = relativeTimeFormatters.get(locale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeTimeFormatters.set(locale, rtf);
  }
  return rtf;
}

/** "3分前" 形式の相対時刻。1週間を超えたら日付表示に切り替える。 */
export function formatRelativeTime(ms: number, locale: Locale): string {
  const diff = Date.now() - ms;
  if (diff < 0 || diff < MINUTE_MS) return translate(locale, "articles.justNow");
  const rtf = getRelativeTimeFormatter(locale);
  if (diff < HOUR_MS) return rtf.format(-Math.floor(diff / MINUTE_MS), "minute");
  if (diff < DAY_MS) return rtf.format(-Math.floor(diff / HOUR_MS), "hour");
  if (diff < DAY_MS * 7) return rtf.format(-Math.floor(diff / DAY_MS), "day");
  return new Date(ms).toLocaleDateString(locale);
}

function ArticleCardImpl(props: {
  article: NewsArticle;
  active?: boolean;
  /** Receives the clicked article's id — lets callers pass a stable handler
   * reference (e.g. `onClick={onOpenArticle}`) instead of a per-card inline
   * closure, so memo()'s shallow prop comparison actually holds. */
  onClick?: (id: string) => void;
  /** Slot for per-card action buttons (share/delete). Rendered outside the
   * clickable title/excerpt area so buttons don't also trigger onClick. */
  actions?: ComponentChildren;
  /** Latest evaluation's overall score (0-100), if the article has been
   * judged. null/undefined render nothing — evaluation is optional. */
  evaluationScore?: number | null;
}): JSX.Element {
  const { article, active, onClick, actions, evaluationScore } = props;
  const t = useT();
  const { locale } = useLocale();
  const category = article.category ? coerceCategory(article.category) : null;
  // Thumbnail is opt-in per settings and drops itself silently on load
  // failure — no broken-image icon in a list of cards. Articles without a
  // stored imageUrl fall back to the OGP image of their first source link.
  const [thumbFailed, setThumbFailed] = useState(false);
  const needsFallback = !article.imageUrl && mediaPreviewsEnabled();
  const preview = useLinkPreview(needsFallback ? article.sourceLinks?.[0]?.url : undefined);
  const thumbUrl = article.imageUrl ?? preview?.imageUrl;
  const showThumb = Boolean(thumbUrl) && mediaPreviewsEnabled() && !thumbFailed;

  useEffect(() => {
    setThumbFailed(false);
  }, [thumbUrl]);
  return (
    <div class={`article-card${active ? " article-card--active" : ""}`}>
      <button type="button" class="article-card-main" onClick={() => onClick?.(article.id)}>
        <div class="article-card-text">
          <h3 class="article-card-title">{article.title || t("articles.untitledArticle")}</h3>
          {article.excerpt ? <p class="article-card-excerpt">{article.excerpt}</p> : null}
          {category || article.tags.length > 0 ? (
            <div class="article-card-tags">
              {category ? <span class="category-chip">{t(categoryLabelKey(category))}</span> : null}
              {article.tags.slice(0, 4).map((tag) => (
                <span key={tag} class="chip">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          <div class="article-card-meta">
            <span class="article-card-author">{article.authorName || t("common.anonymous")}</span>
            <span class="article-card-dot" aria-hidden="true">
              ・
            </span>
            <span class="article-card-time">{formatRelativeTime(article.createdAt, locale)}</span>
            {article.shared ? <span class="badge badge--shared">{t("articles.sharedBadge")}</span> : null}
            {typeof evaluationScore === "number" ? (
              <span class="eval-score-pill" title={t("articles.evalOverall")}>
                {Math.round(evaluationScore)}
              </span>
            ) : null}
          </div>
        </div>
        {showThumb ? (
          <img
            class="article-card-thumb"
            src={thumbUrl}
            alt={article.title || ""}
            loading="lazy"
            referrerpolicy="no-referrer"
            onError={() => setThumbFailed(true)}
          />
        ) : null}
      </button>
      {actions ? <div class="article-card-actions">{actions}</div> : null}
    </div>
  );
}

// Rendered in unbounded/large lists (HomeArticleSections, SharedView, ...) —
// memoized so a parent re-render doesn't cascade into re-rendering every
// visible card when this card's own props are unchanged (shallow compare).
// onClick takes the article id (see above) so callers can pass a stable
// handler reference; `actions` still gets a fresh element per render at
// call sites that need per-card content (e.g. ReactionBar), which is fine
// since ReactionBar itself is cheap and independently memo-able.
export const ArticleCard = memo(ArticleCardImpl);

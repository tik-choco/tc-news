// Full article reader: renders the Markdown body as sanitized HTML inside a
// 720px-max reading column, with title/author/date/tags up top and the
// source-link list at the bottom. Used by ArticlesView and SharedView.
import { useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { ExternalLink } from "lucide-preact";
import type { NewsArticle, SourceLink } from "../types";
import { LOCALE_LABELS, isLocale, useT } from "../lib/i18n";
import { categoryLabelKey, coerceCategory } from "../lib/categories";
import { mediaPreviewsEnabled } from "../lib/linkPreview";
import { useLinkPreview } from "../hooks/useLinkPreview";
import "../styles/components.css";

function renderMarkdown(source: string): string {
  const raw = marked.parse(source, { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(raw);
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ArticleReader(props: { article: NewsArticle }): JSX.Element {
  const { article } = props;
  const t = useT();
  const html = useMemo(() => renderMarkdown(article.body), [article.body]);
  const category = article.category ? coerceCategory(article.category) : null;
  // Hero image is opt-in per settings and hides itself silently on load
  // failure — no broken-image icon at the top of the reading column.
  const [heroFailed, setHeroFailed] = useState(false);
  const showHero = Boolean(article.imageUrl) && mediaPreviewsEnabled() && !heroFailed;

  return (
    <article class="article-reader">
      <header class="article-reader-header">
        <h1 class="article-reader-title">{article.title || t("articles.untitledArticle")}</h1>
        {article.excerpt ? <p class="article-reader-excerpt">{article.excerpt}</p> : null}
        <div class="article-reader-meta">
          <span class="article-reader-author">{article.authorName || t("common.anonymous")}</span>
          <span class="article-reader-dot" aria-hidden="true">
            ・
          </span>
          <time class="article-reader-date">{formatDateTime(article.createdAt)}</time>
          {article.shared ? <span class="badge badge--shared">{t("articles.sharedBadge")}</span> : null}
          {category ? <span class="category-chip">{t(categoryLabelKey(category))}</span> : null}
          {article.lang && isLocale(article.lang) ? (
            <span class="chip">{LOCALE_LABELS[article.lang]}</span>
          ) : null}
        </div>
        {article.tags.length > 0 ? (
          <div class="article-reader-tags">
            {article.tags.map((tag) => (
              <span key={tag} class="chip">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      {showHero ? (
        <figure class="article-reader-hero">
          <img
            src={article.imageUrl}
            alt={article.title || ""}
            loading="lazy"
            referrerpolicy="no-referrer"
            onError={() => setHeroFailed(true)}
          />
        </figure>
      ) : null}

      <div class="article-reader-body" dangerouslySetInnerHTML={{ __html: html }} />

      {article.sourceLinks.length > 0 ? (
        <footer class="article-reader-sources">
          <h2 class="article-reader-sources-title">{t("articles.sourcesTitle")}</h2>
          <ul class="article-reader-sources-list">
            {article.sourceLinks.map((link) => (
              <li key={link.url}>
                <SourceLinkCard link={link} />
              </li>
            ))}
          </ul>
        </footer>
      ) : null}
    </article>
  );
}

/** Rich "URL preview card" for a single source link — image/video thumb,
 * title, description, and site name, like pasting a URL into a chat app.
 * Renders gracefully off link.title/hostname alone while the OGP fetch
 * (or when previews are disabled) leaves useLinkPreview() at null. */
function SourceLinkCard(props: { link: SourceLink }): JSX.Element {
  const { link } = props;
  const preview = useLinkPreview(link.url);
  const [thumbFailed, setThumbFailed] = useState(false);
  const title = preview?.title || link.title || link.url;
  const description = preview?.description;
  let hostname = link.url;
  try {
    hostname = new URL(link.url).hostname;
  } catch {
    // link.url isn't a valid absolute URL — fall back to showing it as-is.
  }
  const siteName = preview?.siteName || hostname;
  const showImage = Boolean(preview?.imageUrl) && !thumbFailed;

  return (
    <a class="source-link-card" href={link.url} target="_blank" rel="noopener noreferrer">
      {preview?.videoUrl ? (
        <video
          class="source-link-card-thumb"
          controls
          preload="none"
          poster={preview.imageUrl}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <source src={preview.videoUrl} />
        </video>
      ) : showImage ? (
        <img
          class="source-link-card-thumb"
          src={preview!.imageUrl}
          alt={title}
          loading="lazy"
          referrerpolicy="no-referrer"
          onError={() => setThumbFailed(true)}
        />
      ) : (
        <span class="source-link-card-thumb source-link-card-thumb--placeholder" aria-hidden="true">
          <ExternalLink size={20} />
        </span>
      )}
      <span class="source-link-card-body">
        <span class="source-link-card-title">{title}</span>
        {description ? <span class="source-link-card-desc">{description}</span> : null}
        <span class="source-link-card-site">{siteName}</span>
      </span>
    </a>
  );
}

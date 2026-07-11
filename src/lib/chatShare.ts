// Publishes a generated tc-news article onto the shared bus's "note-article"
// topic (see protocol/docs/data-contracts/docs/SHARED_BUS.md) so a tc-chat
// tab on the same origin can pick it up and post it as a board node. tc-chat
// already subscribes to this topic (see its useNoteArticleImport.ts) — we
// just need to publish records shaped the way it expects.
//
// Unlike tc-note's shareArticle.ts (which only inlines the markdown body in
// meta.text when storage_add fails), tc-news always inlines the full
// markdown in meta.text regardless of whether storage_add succeeded — this
// gives readers a body they can render without a mistlib round trip, while
// still populating `cid` when content-addressing succeeded.
import type { NewsArticle } from "../types";
import { getNode, storage_add } from "./mistClient";
import { publishShared } from "./sharedBus";
import { tGlobal } from "./i18n";

/** Builds the Markdown document published for `article`:
 * `# title\n\n excerpt \n\n body` plus a trailing source-links section when
 * the article has any. */
function buildArticleMarkdown(article: NewsArticle): string {
  const parts = [`# ${article.title}`, "", article.excerpt, "", article.body];
  if (article.sourceLinks.length > 0) {
    parts.push("", "---", "", `## ${tGlobal("errors.sourceLinksHeading")}`, "");
    for (const link of article.sourceLinks) {
      parts.push(`- [${link.title}](${link.url})`);
    }
  }
  return parts.join("\n");
}

/**
 * Publishes `article` as a "note-article" shared record. Tries to
 * content-address the Markdown body via mistlib's storage_add first; the
 * full text is always included in `meta.text` as an inline fallback
 * (dual-shape), and `cid` is set to "" if storage_add throws or mistlib is
 * unavailable.
 */
export async function publishArticleToChat(article: NewsArticle): Promise<void> {
  const markdown = buildArticleMarkdown(article);

  let cid = "";
  try {
    await getNode();
    cid = await storage_add(`tc-news-article-${article.id}.md`, new TextEncoder().encode(markdown));
  } catch (error) {
    console.warn("publishArticleToChat: storage_add failed, falling back to inline text", error);
    cid = "";
  }

  const meta: Record<string, unknown> = {
    title: article.title,
    format: "markdown",
    excerpt: article.excerpt,
    publishedAt: new Date(article.createdAt).toISOString(),
    text: markdown,
  };

  publishShared("note-article", cid, meta);
}

/** URL to open the article's room in tc-chat. Same-origin sibling deploy is
 * assumed (production: `https://tik-choco.github.io/tc-chat/`); using an
 * origin-relative path (rather than a hardcoded absolute URL) keeps this
 * from producing a malformed link when the app runs under a different host
 * in dev. */
export function chatUrl(roomId: string): string {
  return `/tc-chat/#/${roomId}`;
}

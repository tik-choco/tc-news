// Article generation: turns a selection of FeedItems (+ an optional user
// instruction) into a NewsArticle by asking the configured LLM to write a
// self-contained Markdown news article and return it as strict JSON. JSON
// parsing follows tc-town's evaluation.ts extractJson pattern (first "{" to
// last "}"), and — unlike evaluation.ts — a parse failure never throws: the
// raw response text becomes the article body so callers always get a usable
// NewsArticle. Only the LLM call itself (network/HTTP/empty response) throws.

import type { ChatMessage } from "@tik-choco/mistai";
import type { FeedItem, NewsArticle, SourceLink } from "../types";
import { requestChatCompletion } from "./llm";
import { tGlobal } from "./i18n";
import { coerceCategory } from "./categories";

// English-based prompt so it behaves consistently regardless of the target
// article language, which is injected via {language}. The JSON output shape
// ({"title","excerpt","tags","body"}) is a hard contract with the parsing
// logic below and must not change.
function buildSystemPrompt(language: string): string {
  return (
    "You are a web news editor. Based on the given headlines and summaries " +
    "(and any additional instructions), write a news article that stands on its own as a piece " +
    `of Markdown writing. Write the article entirely in ${language}. ` +
    'Return only the following JSON: {"title": string, "excerpt": string, "tags": string[], ' +
    '"body": string (markdown, with headings and paragraphs), "category": string}. ' +
    "category must be exactly one of: tech, business, society, science, culture, sports, life, other " +
    "(single best fit). " +
    "Only write facts that are within the scope of the given information, and clearly flag " +
    "speculation as such."
  );
}

// Ported verbatim from tc-town's evaluation.ts extractJson: grabs the
// outermost {...} span so a reply wrapped in prose/code-fences still parses.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString("ja-JP");
  } catch {
    return "";
  }
}

function buildUserMessage(items: FeedItem[], instruction?: string): string {
  const lines = items.map(
    (item) => `- [${item.title}](${item.link}) (${item.feedLabel}, ${formatDate(item.publishedAt)}): ${item.summary}`,
  );
  let message = lines.join("\n");
  const trimmedInstruction = instruction?.trim();
  if (trimmedInstruction) {
    message += `\n\nAdditional instructions: ${trimmedInstruction}`;
  }
  return message;
}

function buildSourceLinks(items: FeedItem[]): SourceLink[] {
  return items.map((item) => ({ title: item.title, url: item.link }));
}

/** 最初に画像を持つソースアイテムのサムネイルをヒーロー画像として採用する。 */
export function pickHeroImage(items: FeedItem[]): string | undefined {
  return items.find((i) => i.imageUrl)?.imageUrl;
}

function newArticleId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `article-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function firstNonEmptyLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().replace(/^#+\s*/, "") : tGlobal("articles.untitledArticle");
}

export interface GenerateArticleOptions {
  profileId: string;
  instruction?: string;
  authorDid: string;
  authorName: string;
  /** Endonym of the target language for the generated article, e.g. "English". */
  language: string;
  /** Locale code stamped onto the article as NewsArticle.lang, e.g. "en". */
  locale: string;
  onDelta?: (full: string) => void;
}

export async function generateArticle(items: FeedItem[], opts: GenerateArticleOptions): Promise<NewsArticle> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(opts.language) },
    { role: "user", content: buildUserMessage(items, opts.instruction) },
  ];

  // Only this call is allowed to throw — a network/HTTP/empty-response
  // failure surfaces to the caller as-is (llm.ts already formats it in the
  // current locale). Everything after this point degrades gracefully instead.
  const responseText = await requestChatCompletion(opts.profileId, messages, {
    onDelta: opts.onDelta ? (_delta, full) => opts.onDelta?.(full) : undefined,
  });

  const sourceLinks = buildSourceLinks(items);
  const createdAt = Date.now();
  const id = newArticleId();

  try {
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : firstNonEmptyLine(responseText);
    const excerpt = typeof data.excerpt === "string" ? data.excerpt : "";
    const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === "string") : [];
    const body = typeof data.body === "string" && data.body.trim() ? data.body : responseText;
    const category = coerceCategory(data.category);

    return {
      id,
      title,
      excerpt,
      body,
      tags,
      sourceLinks,
      imageUrl: pickHeroImage(items),
      authorDid: opts.authorDid,
      authorName: opts.authorName,
      createdAt,
      lang: opts.locale,
      ...(category ? { category } : {}),
    };
  } catch {
    // Non-JSON (or malformed JSON) reply: fall back to the raw text as the
    // body so the user still gets a readable article instead of an error.
    return {
      id,
      title: firstNonEmptyLine(responseText).slice(0, 80),
      excerpt: "",
      body: responseText,
      tags: [],
      sourceLinks,
      imageUrl: pickHeroImage(items),
      authorDid: opts.authorDid,
      authorName: opts.authorName,
      createdAt,
      lang: opts.locale,
    };
  }
}

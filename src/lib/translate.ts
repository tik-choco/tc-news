// Translates an existing NewsArticle's title/excerpt/body into another
// language. Reuses the same requestChatCompletion + extractJson pattern as
// generate.ts/articleEvaluation.ts. Unlike evaluation (local-only by
// design), a translation's whole point is to be shared over P2P — see
// hooks/useNewsRoom.ts's shareTranslation — so the LLM call only has to run
// once per article×language across an entire room.

import type { ChatMessage } from "@tik-choco/mistai";
import type { NewsArticle } from "../types";
import { requestChatCompletion } from "./llm";
import { tGlobal } from "./i18n";

export interface TranslatedContent {
  title: string;
  excerpt: string;
  body: string;
}

export interface TranslateArticleOptions {
  profileId: string;
  /** Endonym of the target language, e.g. "English" — same convention as generate.ts's `language`. */
  targetLanguage: string;
}

// English-based prompt for consistent behavior regardless of the target
// language, which is injected via {targetLanguage} — mirrors generate.ts.
function buildSystemPrompt(targetLanguage: string): string {
  return (
    "You are a professional translator for a web news article. Translate the given " +
    `title, excerpt, and Markdown body into ${targetLanguage}, preserving the original ` +
    "meaning exactly and keeping the Markdown structure (headings, paragraphs, links, emphasis) intact. " +
    "Do not summarize, add, or omit content. " +
    'Return only the following JSON: {"title": string, "excerpt": string, "body": string}.'
  );
}

function buildUserMessage(article: NewsArticle): string {
  return `Title: ${article.title}\n\nExcerpt: ${article.excerpt || "(none)"}\n\nBody:\n${article.body}`;
}

// Ported from generate.ts's extractJson: grabs the outermost {...} span so a
// reply wrapped in prose/code-fences still parses.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

export async function translateArticle(
  article: NewsArticle,
  opts: TranslateArticleOptions,
): Promise<TranslatedContent> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(opts.targetLanguage) },
    { role: "user", content: buildUserMessage(article) },
  ];

  // Only this call is allowed to throw — a network/HTTP/empty-response
  // failure surfaces to the caller. A malformed JSON reply degrades
  // gracefully below instead of failing the whole translation.
  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, { temperature: 0.2 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.translateFailed", { detail }));
  }

  try {
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    const title = typeof data.title === "string" && data.title.trim() ? data.title : article.title;
    const excerpt = typeof data.excerpt === "string" ? data.excerpt : "";
    const body = typeof data.body === "string" && data.body.trim() ? data.body : responseText;
    return { title, excerpt, body };
  } catch {
    return { title: article.title, excerpt: "", body: responseText };
  }
}

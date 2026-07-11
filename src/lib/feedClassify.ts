// Best-effort auto-categorization for freshly fetched feed items — one
// batched LLM call classifies many items at once instead of one call per
// item. Never throws: any failure (LLM unconfigured, network, parse) just
// resolves to an empty Map, matching the "silent enrichment" contract used
// by useFeeds (see hooks/useFeeds.ts). Parsing style mirrors
// articleEvaluation.ts's extractJson/defensive-JSON approach.

import type { ChatMessage } from "@tik-choco/mistai";
import type { FeedItem } from "../types";
import { ARTICLE_CATEGORIES, coerceCategory, type ArticleCategory } from "./categories";
import { requestChatCompletion } from "./llm";

const MAX_ITEMS = 40;
const SUMMARY_PREVIEW_CHARS = 120;

function buildSystemPrompt(): string {
  const categoryList = ARTICLE_CATEGORIES.join(", ");
  return (
    "You are a classifier for news feed items. Each item has an id, a title, " +
    "and a short summary snippet; titles and summaries may be in any language. " +
    `Classify every item into exactly one of these categories: ${categoryList}. ` +
    'If an item is unclear or does not fit any category well, use "other". ' +
    "Reply with ONLY a JSON object mapping each item's id to its category string, " +
    'like {"id1": "tech", "id2": "other"}. Do not include any other text.'
  );
}

function buildUserMessage(items: FeedItem[]): string {
  return items
    .map((item) => {
      const summary = item.summary.slice(0, SUMMARY_PREVIEW_CHARS);
      return `${item.id} | ${item.title} | ${summary}`;
    })
    .join("\n");
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

/**
 * Classifies `items` into ARTICLE_CATEGORIES with a single LLM call.
 * Best-effort: resolves a map of id -> category for the items it could
 * confidently classify; never rejects. Caps input at the 40 newest items
 * (by publishedAt) to keep the prompt small.
 */
export async function classifyFeedItems(
  items: FeedItem[],
  profileId: string,
): Promise<Map<string, ArticleCategory>> {
  const result = new Map<string, ArticleCategory>();
  if (items.length === 0) return result;

  const targets =
    items.length > MAX_ITEMS
      ? [...items].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_ITEMS)
      : items;
  const validIds = new Set(targets.map((item) => item.id));

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserMessage(targets) },
  ];

  try {
    const responseText = await requestChatCompletion(profileId, messages, { temperature: 0.1 });
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    for (const [id, rawCategory] of Object.entries(data)) {
      if (!validIds.has(id)) continue;
      const category = coerceCategory(rawCategory);
      if (category) result.set(id, category);
    }
  } catch (err) {
    console.warn("classifyFeedItems: classification failed", err);
    return new Map();
  }

  return result;
}

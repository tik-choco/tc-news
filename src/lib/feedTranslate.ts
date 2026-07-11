// Translates a feed item's title/summary and (optionally) its
// readability-extracted page HTML (see pageExtract.ts) shown in
// FeedItemModal. Unlike translate.ts's article translation — whose whole
// point is to be shared over P2P (hooks/useNewsRoom.ts's shareTranslation)
// so the LLM call only has to run once per article×language across a room —
// a feed-item translation is LOCAL-ONLY: it's a convenience for the viewer
// of a single raw feed entry, never persisted to or read from the room, so
// every peer pays for their own call.
//
// Chunking exists because pageExtract.ts's extracted pages can be up to
// MAX_OUTPUT_CHARS (150_000) characters — far too large for one chat
// completion, especially against local models with small context windows.
// We cap the total translated amount (MAX_TRANSLATE_HTML_CHARS) and, within
// that cap, split into per-call chunks (TRANSLATE_HTML_CHUNK_CHARS) at
// top-level element boundaries so a translated chunk is always well-formed
// HTML on its own. Chunks are translated sequentially — not Promise.all —
// because the target is frequently a local model / rate-limited endpoint
// where concurrent requests would just queue or fail.

import type { ChatMessage } from "@tik-choco/mistai";
import DOMPurify from "dompurify";
import { requestChatCompletion } from "./llm";
import { tGlobal } from "./i18n";

export interface FeedTranslationInput {
  title: string;
  summary: string; // plain text, may be ""
  html: string | null; // DOMPurify-sanitized extracted page HTML (lib/pageExtract), or null when unavailable
}

export interface TranslatedFeedContent {
  title: string;
  summary: string;
  html: string | null; // sanitized translated HTML, or null when input.html was null
  truncated: boolean; // true when input.html exceeded the translation cap and only a prefix was translated
}

export interface TranslateFeedOptions {
  profileId: string; // LLM preset id, "" = shared-config default (same convention as translate.ts)
  targetLanguage: string; // endonym of target language, e.g. "English" (LOCALE_LABELS value)
  signal?: AbortSignal; // optional cooperative-cancellation signal (translation jobs run through lib/jobQueue)
}

// Total amount of extracted-page HTML we're willing to translate at all.
// Anything beyond this prefix is left untranslated and `truncated` is set.
const MAX_TRANSLATE_HTML_CHARS = 40_000;

// Per-LLM-call chunk size, well under typical context limits even after
// accounting for the prompt overhead and the translated reply itself.
const TRANSLATE_HTML_CHUNK_CHARS = 12_000;

// Cooperative cancellation: checked between LLM calls, never while one is in
// flight — requestChatCompletion doesn't accept an AbortSignal, so an
// in-flight call can't itself be interrupted; cancellation only takes effect
// once it resolves/rejects and control returns to us. Mirrors tc-pdf-viewer's
// throwIfCancelled; kept as an explicit helper (not signal.throwIfAborted())
// for happy-dom test-environment compatibility and a consistent error shape.
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("Request cancelled.");
  err.name = "AbortError";
  throw err;
}

// English-based prompt for consistent behavior regardless of the target
// language — mirrors translate.ts's buildSystemPrompt.
function buildTitleSummarySystemPrompt(targetLanguage: string): string {
  return (
    "You are a professional translator for a web news feed item. Translate the given " +
    `title and summary into ${targetLanguage}, preserving the original meaning exactly. ` +
    "Do not summarize, add, or omit content. " +
    'Return only the following JSON: {"title": string, "summary": string}.'
  );
}

function buildTitleSummaryUserMessage(input: FeedTranslationInput): string {
  return `Title: ${input.title}\n\nSummary: ${input.summary || "(none)"}`;
}

function buildHtmlChunkSystemPrompt(targetLanguage: string): string {
  return (
    "You are a professional translator for a web news article fragment. Translate the given " +
    `HTML fragment into ${targetLanguage}. Preserve every tag and attribute exactly as-is; ` +
    "translate only the human-readable text content. Do not add, remove, or summarize anything. " +
    "Return ONLY the translated HTML, with no code fences, explanation, or other commentary."
  );
}

// Ported from translate.ts's extractJson: grabs the outermost {...} span so a
// reply wrapped in prose/code-fences still parses.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

// Some models wrap their HTML reply in a ```html ... ``` fence even when
// told not to; strip it so the result is plain HTML.
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Exported for tests. Splits sanitized article HTML into chunks of at most
 * maxChars, cutting only at top-level element (and interleaved text-node)
 * boundaries within document.body — a single top-level element larger than
 * maxChars becomes its own oversized chunk rather than being cut mid-tag.
 * Pure function: no network/storage. */
export function splitHtmlIntoChunks(html: string, maxChars: number): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const chunks: string[] = [];
  let current = "";

  for (const node of Array.from(doc.body.childNodes)) {
    const piece = node.nodeType === Node.ELEMENT_NODE ? (node as Element).outerHTML : node.textContent || "";
    if (!piece) continue;

    if (current && current.length + piece.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += piece;
  }
  if (current) chunks.push(current);

  return chunks;
}

async function translateTitleSummary(
  input: FeedTranslationInput,
  opts: TranslateFeedOptions,
): Promise<{ title: string; summary: string }> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildTitleSummarySystemPrompt(opts.targetLanguage) },
    { role: "user", content: buildTitleSummaryUserMessage(input) },
  ];

  throwIfAborted(opts.signal);

  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, { temperature: 0.2 });
  } catch (err) {
    // Rethrow cancellation as-is so the queue (lib/jobQueue) can
    // tell it apart from an actual failure by err.name, instead of burying
    // it in the localized translateFailed message below.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.translateFailed", { detail }));
  }

  try {
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    const title = typeof data.title === "string" && data.title.trim() ? data.title : input.title;
    // Only fall back to the raw response text when there's no usable JSON
    // summary field at all — an explicit "" is a valid (if odd) translation.
    const summary = typeof data.summary === "string" ? data.summary : responseText;
    return { title, summary };
  } catch {
    return { title: input.title, summary: responseText };
  }
}

async function translateHtmlChunk(chunk: string, opts: TranslateFeedOptions): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildHtmlChunkSystemPrompt(opts.targetLanguage) },
    { role: "user", content: chunk },
  ];

  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, { temperature: 0.2 });
  } catch (err) {
    // Same reasoning as translateTitleSummary: don't wrap cancellation.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.translateFailed", { detail }));
  }

  return stripCodeFences(responseText);
}

async function translateHtml(
  html: string,
  opts: TranslateFeedOptions,
): Promise<{ html: string; truncated: boolean }> {
  const truncated = html.length > MAX_TRANSLATE_HTML_CHARS;
  const capped = truncated ? html.slice(0, MAX_TRANSLATE_HTML_CHARS) : html;

  const chunks = splitHtmlIntoChunks(capped, TRANSLATE_HTML_CHUNK_CHARS);

  // Sequential, not Promise.all: the target is frequently a local model /
  // rate-limited endpoint where concurrent requests would just queue or fail.
  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    // Cancellation takes effect only between chunk calls, not mid-call — see
    // throwIfAborted's comment above.
    throwIfAborted(opts.signal);
    translatedChunks.push(await translateHtmlChunk(chunk, opts));
  }

  const joined = translatedChunks.join("\n");
  // Defense-in-depth: translation output flows into dangerouslySetInnerHTML
  // (same reasoning as pageExtract.ts's fetchReadablePage), even though the
  // input was already sanitized before we ever saw it. If sanitize somehow
  // collapses everything to an empty string (unexpected — the input passed
  // sanitization once already), prefer showing the untranslated original
  // over silently rendering nothing.
  const sanitized = DOMPurify.sanitize(joined).trim();
  return { html: sanitized.length > 0 ? sanitized : html, truncated };
}

export async function translateFeedContent(
  input: FeedTranslationInput,
  opts: TranslateFeedOptions,
): Promise<TranslatedFeedContent> {
  throwIfAborted(opts.signal);

  const { title, summary } = await translateTitleSummary(input, opts);

  if (input.html === null) {
    return { title, summary, html: null, truncated: false };
  }

  const { html, truncated } = await translateHtml(input.html, opts);
  return { title, summary, html, truncated };
}

// Translates an existing NewsArticle's title/excerpt/body into another
// language. Reuses the same requestChatCompletion + extractJson pattern as
// generate.ts/articleEvaluation.ts. Unlike evaluation (local-only by
// design), a translation's whole point is to be shared over P2P — see
// hooks/useNewsRoom.ts's shareTranslation — so the LLM call only has to run
// once per article×language across an entire room.
//
// The body is translated as a two-phase pipeline rather than one big JSON
// request: (1) a small JSON call for title+excerpt, then (2) the Markdown
// body split into chunks (markdownChunks.ts) and translated one chunk at a
// time. This mirrors feedTranslate.ts's HTML-chunk approach and for the same
// two reasons — article bodies can be far too long for one completion
// against a small-context (often local) model, and chunking makes streaming
// + partial progress possible via onProgress. Chunks are translated
// sequentially, not Promise.all, again matching feedTranslate.ts: the target
// is frequently a local/rate-limited endpoint where concurrent requests
// would just queue or fail.
//
// If `opts.lang` is supplied, every completed piece (title/excerpt, then
// each translated chunk) is persisted to partialTranslationStore as it
// finishes. That makes translateArticle resumable: a cancelled or
// interrupted run (lib/jobQueue) picks back up from the last completed
// chunk on the next call, instead of re-paying the LLM cost for the whole
// article. Resumption is gated on sourceSig + totalChunks matching the
// current article — if the article changed since the partial was saved, the
// partial is discarded and translation starts fresh.

import type { ChatMessage } from "@tik-choco/mistai";
import type { NewsArticle } from "../types";
import { requestChatCompletion } from "./llm";
import { tGlobal } from "./i18n";
import { splitMarkdownIntoChunks } from "./markdownChunks";
import {
  clearPartialTranslation,
  computeTranslationSourceSig,
  getPartialTranslation,
  savePartialTranslation,
} from "./partialTranslationStore";

export interface TranslatedContent {
  title: string;
  excerpt: string;
  body: string;
}

/** Emitted as translation progresses so callers (the translation job queue /
 * UI) can render a live preview instead of waiting for the whole article.
 * title/excerpt are null until the title/excerpt call resolves (or a
 * resumed partial already had them); body is every completed chunk joined
 * with "\n\n", plus whatever of the in-flight chunk has streamed in so far. */
export interface ArticleTranslationProgressUpdate {
  title: string | null;
  excerpt: string | null;
  body: string;
  doneChunks: number;
  totalChunks: number;
}

export interface TranslateArticleOptions {
  profileId: string;
  /** Endonym of the target language, e.g. "English" — same convention as generate.ts's `language`. */
  targetLanguage: string;
  /** Locale code (i18n Locale value) used to key partial-translation resume
   * state. Omitted => no partial persistence/resume, for backward
   * compatibility with callers that don't care about resumability. */
  lang?: string;
  signal?: AbortSignal;
  onProgress?: (p: ArticleTranslationProgressUpdate) => void;
}

// Same chunk-size convention as tc-pdf-viewer's MARKDOWN_TRANSLATION_CHUNK_SIZE
// (src/services/ai.js) — markdownChunks.ts is a straight port of that file's
// splitMarkdownForTranslation, so this stays at the same value to keep
// per-call payload size (and thus latency/timeout risk against small-context
// models) consistent with the app it was ported from.
const ARTICLE_CHUNK_CHARS = 4_500;

// Minimum spacing between onProgress emits driven by in-flight streaming
// deltas (as opposed to the unconditional emits on title/excerpt and
// chunk-completion, below). Mirrors feedTranslate.ts's PROGRESS_THROTTLE_MS
// (that module uses 150ms for its DOMPurify.sanitize()-per-emit cost; body
// text here has no such cost, so a tighter 120ms is fine). Anything
// throttled away is still caught by the next chunk-completion emit, so no
// progress is lost, only coalesced.
const PROGRESS_THROTTLE_MS = 120;

// Cooperative cancellation: checked between LLM calls, never while one is in
// flight — requestChatCompletion doesn't accept an AbortSignal, so an
// in-flight call can't itself be interrupted; cancellation only takes effect
// once it resolves/rejects and control returns to us. Deliberately a local
// copy rather than importing feedTranslate.ts's throwIfAborted — same
// reasoning that module gives for not using signal.throwIfAborted()
// (happy-dom test-environment compatibility, consistent error shape), but
// kept file-local so each translation module can evolve independently.
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("Request cancelled.");
  err.name = "AbortError";
  throw err;
}

// English-based prompt for consistent behavior regardless of the target
// language, which is injected via {targetLanguage} — mirrors generate.ts.
// Body is intentionally excluded here; it's translated separately, chunk by
// chunk, by buildChunkSystemPrompt below.
function buildTitleExcerptSystemPrompt(targetLanguage: string): string {
  return (
    "You are a professional translator for a web news article. Translate the given " +
    `title and excerpt into ${targetLanguage}, preserving the original meaning exactly. ` +
    "Do not summarize, add, or omit content. " +
    'Return only the following JSON: {"title": string, "excerpt": string}.'
  );
}

function buildTitleExcerptUserMessage(article: NewsArticle): string {
  return `Title: ${article.title}\n\nExcerpt: ${article.excerpt || "(none)"}`;
}

function buildChunkSystemPrompt(targetLanguage: string): string {
  return (
    "You are a professional translator for a web news article fragment. Translate the given " +
    `Markdown fragment into ${targetLanguage}. Preserve the Markdown structure exactly ` +
    "(headings, paragraphs, links, emphasis, lists, code fences). " +
    "Do not summarize, add, or omit content. " +
    "Return ONLY the translated Markdown, with no code fences, explanation, or other commentary."
  );
}

// Ported from generate.ts's extractJson: grabs the outermost {...} span so a
// reply wrapped in prose/code-fences still parses.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

// Some models wrap their Markdown reply in a ``` fence even when told not
// to; strip it so the result is plain Markdown. Local copy of
// feedTranslate.ts's stripCodeFences — see throwIfAborted's comment above
// for why this module keeps its own instead of importing.
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

async function translateTitleExcerpt(
  article: NewsArticle,
  opts: TranslateArticleOptions,
): Promise<{ title: string; excerpt: string }> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildTitleExcerptSystemPrompt(opts.targetLanguage) },
    { role: "user", content: buildTitleExcerptUserMessage(article) },
  ];

  throwIfAborted(opts.signal);

  // Only this call is allowed to throw — a network/HTTP/empty-response
  // failure surfaces to the caller. A malformed JSON reply degrades
  // gracefully below instead of failing the whole translation.
  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, { temperature: 0.2 });
  } catch (err) {
    // Rethrow cancellation as-is so the queue (lib/jobQueue) can tell it
    // apart from an actual failure by err.name, instead of burying it in
    // the localized translateFailed message below.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.translateFailed", { detail }));
  }

  try {
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    const title = typeof data.title === "string" && data.title.trim() ? data.title : article.title;
    const excerpt = typeof data.excerpt === "string" ? data.excerpt : "";
    return { title, excerpt };
  } catch {
    return { title: article.title, excerpt: "" };
  }
}

async function translateChunk(
  chunk: string,
  opts: TranslateArticleOptions,
  onDelta: (delta: string, full: string) => void,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildChunkSystemPrompt(opts.targetLanguage) },
    { role: "user", content: chunk },
  ];

  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, { temperature: 0.2, onDelta });
  } catch (err) {
    // Same reasoning as translateTitleExcerpt: don't wrap cancellation.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.translateFailed", { detail }));
  }

  return stripCodeFences(responseText);
}

export async function translateArticle(
  article: NewsArticle,
  opts: TranslateArticleOptions,
): Promise<TranslatedContent> {
  throwIfAborted(opts.signal);

  const chunks = splitMarkdownIntoChunks(article.body, ARTICLE_CHUNK_CHARS);
  const sourceSig = computeTranslationSourceSig([article.title, article.excerpt || "", article.body]);

  // Resume state, filled in below either from a matching saved partial or
  // from fresh LLM calls as the pipeline progresses.
  let currentTitle: string | null = null;
  let currentExcerpt: string | null = null;
  let completedChunks: string[] = [];

  if (opts.lang) {
    const partial = getPartialTranslation(article.id, opts.lang);
    if (partial) {
      if (partial.sourceSig === sourceSig && partial.totalChunks === chunks.length) {
        // Same article content, same chunking — safe to resume from where
        // the last run left off.
        currentTitle = partial.title;
        currentExcerpt = partial.excerpt;
        completedChunks = [...partial.chunks];
      } else {
        // The article changed (or was re-chunked differently) since this
        // partial was saved; it no longer describes a prefix of the
        // current translation, so it can't be resumed from.
        clearPartialTranslation(article.id, opts.lang);
      }
    }
  }

  // Shared by every emit point below (title/excerpt done, mid-chunk
  // streaming delta, chunk done) so onProgress always reflects the same
  // {title, excerpt, body, doneChunks, totalChunks} shape regardless of
  // which phase triggered it. `partial` is the in-flight chunk's streamed
  // text so far, or null when there's no chunk currently streaming (i.e.
  // body should just be the completed chunks joined).
  function notifyProgress(partial: string | null): void {
    if (!opts.onProgress) return;
    const completedJoined = completedChunks.join("\n\n");
    const body =
      partial === null ? completedJoined : completedJoined ? `${completedJoined}\n\n${partial}` : partial;
    opts.onProgress({
      title: currentTitle,
      excerpt: currentExcerpt,
      body,
      doneChunks: completedChunks.length,
      totalChunks: chunks.length,
    });
  }

  function persistPartial(): void {
    if (!opts.lang) return;
    savePartialTranslation({
      articleId: article.id,
      lang: opts.lang,
      title: currentTitle,
      excerpt: currentExcerpt,
      chunks: completedChunks,
      totalChunks: chunks.length,
      sourceSig,
      updatedAt: Date.now(),
    });
  }

  if (currentTitle === null) {
    const { title, excerpt } = await translateTitleExcerpt(article, opts);
    currentTitle = title;
    currentExcerpt = excerpt;
  }
  notifyProgress(null);
  persistPartial();

  // Sequential, not Promise.all: mirrors feedTranslate.ts's chunk loop — the
  // target is frequently a local model / rate-limited endpoint where
  // concurrent requests would just queue or fail. Starts at
  // completedChunks.length so a resumed run skips chunks already translated
  // in a prior call.
  let lastDeltaEmitAt = 0;
  for (let i = completedChunks.length; i < chunks.length; i++) {
    // Cancellation takes effect only between chunk calls, not mid-call — see
    // throwIfAborted's comment above.
    throwIfAborted(opts.signal);

    const translated = await translateChunk(chunks[i], opts, (_delta, full) => {
      // Throttle streaming emits to ~120ms so a fast-streaming model doesn't
      // flood onProgress/re-renders; the very last delta of a chunk that
      // gets dropped by the throttle is harmless, since the chunk-complete
      // emit right after the loop body below always fires unconditionally.
      const now = Date.now();
      if (now - lastDeltaEmitAt < PROGRESS_THROTTLE_MS) return;
      lastDeltaEmitAt = now;
      notifyProgress(full);
    });

    completedChunks.push(translated);
    persistPartial();
    notifyProgress(null);
  }

  // Whole article translated successfully — the partial's job (letting a
  // future call resume) is done, so drop it rather than let it accumulate
  // as dead state in the store.
  if (opts.lang) clearPartialTranslation(article.id, opts.lang);

  return {
    title: currentTitle ?? article.title,
    excerpt: currentExcerpt ?? "",
    body: completedChunks.join("\n\n"),
  };
}

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
//
// Streaming + resume (ported from tc-pdf-viewer's ai.js translateMarkdown's
// onPartial/notifyProgress idea, adapted to this module's sequential-chunk
// shape): a feed-item translation can involve several chunk-sized LLM calls
// in a row, which for a slow/local model can take a while with nothing
// visible happening. onProgress lets callers render text as it streams in
// (title/summary as soon as they resolve, then each HTML chunk's own
// in-flight partial text, throttled — see emitProgress below — plus a full
// emit whenever a chunk finishes). When itemId+lang are both supplied, every
// completed step (title/summary, then each finished chunk) is snapshotted to
// partialFeedTranslationStore so that if the job is abandoned (nav away,
// reload, an error) a subsequent call with the same input+itemId+lang can
// pick up where it left off instead of re-running LLM calls that already
// succeeded — sourceSig + totalChunks guard against resuming into stale
// state when the underlying page content or chunking has changed.

import type { ChatMessage } from "@tik-choco/mistai";
import DOMPurify from "dompurify";
import { requestChatCompletion } from "./llm";
import { tGlobal } from "./i18n";
import {
  clearPartialFeedTranslation,
  computeFeedTranslationSourceSig,
  getPartialFeedTranslation,
  savePartialFeedTranslation,
  type PartialFeedTranslation,
} from "./partialFeedTranslationStore";

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

/** Emitted via TranslateFeedOptions.onProgress as the translation streams
 * in. Fired once after the title/summary call resolves (or is skipped via
 * resume), then again on every chunk-translation delta (throttled) and every
 * chunk completion — see emitProgress's comment for exactly what `html`
 * contains at each stage. */
export interface FeedTranslationProgressUpdate {
  title: string | null; // null until the title/summary call resolves
  summary: string | null;
  html: string; // DOMPurify-sanitized: completed chunks joined + current chunk's streamed partial; "" when input.html is null
  doneChunks: number;
  totalChunks: number;
}

export interface TranslateFeedOptions {
  profileId: string; // LLM preset id, "" = shared-config default (same convention as translate.ts)
  targetLanguage: string; // endonym of target language, e.g. "English" (LOCALE_LABELS value)
  itemId?: string; // FeedItem.id for partial-store keying
  // Locale code for partial-store keying. itemId and lang must BOTH be set
  // for partial save/resume to be active — either alone is treated as "not
  // resumable", so existing callers that pass neither keep working unchanged.
  lang?: string;
  signal?: AbortSignal; // optional cooperative-cancellation signal (translation jobs run through lib/jobQueue)
  onProgress?: (p: FeedTranslationProgressUpdate) => void; // optional streaming progress callback
}

// Total amount of extracted-page HTML we're willing to translate at all.
// Anything beyond this prefix is left untranslated and `truncated` is set.
const MAX_TRANSLATE_HTML_CHARS = 40_000;

// Per-LLM-call chunk size, well under typical context limits even after
// accounting for the prompt overhead and the translated reply itself.
const TRANSLATE_HTML_CHUNK_CHARS = 12_000;

// Minimum spacing between onProgress emits driven by in-flight streaming
// deltas (as opposed to the unconditional emits on step completion, below).
// DOMPurify.sanitize() isn't free, and a chat completion can emit deltas far
// faster than that's worth running per-token; anything throttled away is
// still caught by the next chunk-completion emit, so no progress is lost,
// only coalesced.
const PROGRESS_THROTTLE_MS = 150;

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

// Caps + splits input.html the same way translateHtml always has, but as a
// standalone step so translateFeedContent can know `totalChunks` up front —
// needed to validate a resume candidate (its totalChunks must match this
// call's, or the source page's structure changed and the chunk boundaries
// from the earlier attempt no longer line up with this one's).
function prepareHtmlChunks(html: string): { chunks: string[]; truncated: boolean } {
  const truncated = html.length > MAX_TRANSLATE_HTML_CHARS;
  const capped = truncated ? html.slice(0, MAX_TRANSLATE_HTML_CHARS) : html;
  return { chunks: splitHtmlIntoChunks(capped, TRANSLATE_HTML_CHUNK_CHARS), truncated };
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

// `onDelta`, when given, receives the accumulated (not incremental) text of
// this chunk's in-flight reply after every streamed fragment — mirrors
// requestChatCompletion/streamChatCompletion's own (delta, full) shape but
// this module's callers only ever want `full`, so we narrow it here rather
// than forwarding both through another layer.
async function translateHtmlChunk(
  chunk: string,
  opts: TranslateFeedOptions,
  onDelta?: (fullSoFar: string) => void,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildHtmlChunkSystemPrompt(opts.targetLanguage) },
    { role: "user", content: chunk },
  ];

  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, {
      temperature: 0.2,
      onDelta: onDelta ? (_delta, full) => onDelta(full) : undefined,
    });
  } catch (err) {
    // Same reasoning as translateTitleSummary: don't wrap cancellation.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.translateFailed", { detail }));
  }

  return stripCodeFences(responseText);
}

// Defense-in-depth: translation output flows into dangerouslySetInnerHTML
// (same reasoning as pageExtract.ts's fetchReadablePage), even though the
// input was already sanitized before we ever saw it. Applied identically to
// the final result and to every streamed onProgress emit, since a partial
// chunk mid-stream is exactly as untrusted as a finished one.
function sanitizeJoinedHtml(pieces: string[]): string {
  return DOMPurify.sanitize(pieces.join("\n")).trim();
}

export async function translateFeedContent(
  input: FeedTranslationInput,
  opts: TranslateFeedOptions,
): Promise<TranslatedFeedContent> {
  throwIfAborted(opts.signal);

  // Partial save/resume only activates when both keying fields are present —
  // see TranslateFeedOptions' comment. Kept as one boolean so every call site
  // below reads the same "is this job resumable at all" fact.
  const resumable = !!(opts.itemId && opts.lang);
  const sourceSig = computeFeedTranslationSourceSig([input.title, input.summary, input.html ?? ""]);
  const { chunks, truncated } = input.html !== null ? prepareHtmlChunks(input.html) : { chunks: [], truncated: false };
  const totalChunks = chunks.length;

  // Resume candidate must match both the source content (sourceSig) and this
  // call's chunk count (totalChunks) — either mismatching means the earlier
  // attempt's chunk boundaries don't correspond to this one's, so resuming
  // into it would silently skip or duplicate content. A non-matching partial
  // is stale by definition; discard it now rather than let it linger for a
  // never-arriving matching call.
  let resumed: PartialFeedTranslation | null = null;
  if (resumable) {
    const candidate = getPartialFeedTranslation(opts.itemId!, opts.lang!);
    if (candidate && candidate.sourceSig === sourceSig && candidate.totalChunks === totalChunks) {
      resumed = candidate;
    } else if (candidate) {
      clearPartialFeedTranslation(opts.itemId!, opts.lang!);
    }
  }

  const savePartial = (title: string | null, summary: string | null, doneChunks: string[]): void => {
    if (!resumable) return;
    savePartialFeedTranslation({
      itemId: opts.itemId!,
      lang: opts.lang!,
      title,
      summary,
      chunks: doneChunks,
      totalChunks,
      truncated,
      sourceSig,
      updatedAt: Date.now(),
    });
  };

  // `currentPartial` is this chunk's in-flight streamed text (null when no
  // chunk is mid-stream, e.g. right after the title/summary step or right
  // after a chunk just finished); folded into the sanitized preview but never
  // pushed into `completedChunks` itself until the chunk actually resolves.
  const emitProgress = (title: string | null, summary: string | null, completedChunks: string[], currentPartial: string | null): void => {
    if (!opts.onProgress) return;
    const html =
      input.html === null
        ? ""
        : currentPartial !== null
          ? sanitizeJoinedHtml([...completedChunks, currentPartial])
          : sanitizeJoinedHtml(completedChunks);
    opts.onProgress({ title, summary, html, doneChunks: completedChunks.length, totalChunks });
  };

  let title: string;
  let summary: string;
  if (resumed && resumed.title !== null) {
    // Title/summary already succeeded in the earlier attempt — skip the LLM
    // call entirely, it's part of what resuming is meant to save.
    title = resumed.title;
    summary = resumed.summary ?? "";
  } else {
    const result = await translateTitleSummary(input, opts);
    title = result.title;
    summary = result.summary;
  }

  const completedChunks: string[] = resumed ? resumed.chunks.slice() : [];
  emitProgress(title, summary, completedChunks, null);
  savePartial(title, summary, completedChunks);

  if (input.html === null) {
    // Nothing left to translate — this "job" is already done; don't leave a
    // partial behind for a chunk phase that will never run.
    if (resumable) clearPartialFeedTranslation(opts.itemId!, opts.lang!);
    return { title, summary, html: null, truncated: false };
  }

  // Sequential, not Promise.all: the target is frequently a local model /
  // rate-limited endpoint where concurrent requests would just queue or
  // fail. Starts at completedChunks.length, not 0, so a resumed job picks up
  // exactly where the earlier attempt left off.
  let lastThrottledEmit = 0;
  for (let i = completedChunks.length; i < chunks.length; i++) {
    // Cancellation takes effect only between chunk calls, not mid-call — see
    // throwIfAborted's comment above.
    throwIfAborted(opts.signal);

    const translated = await translateHtmlChunk(chunks[i], opts, (fullSoFar) => {
      const now = Date.now();
      if (now - lastThrottledEmit < PROGRESS_THROTTLE_MS) return;
      lastThrottledEmit = now;
      emitProgress(title, summary, completedChunks, fullSoFar);
    });

    completedChunks.push(translated);
    savePartial(title, summary, completedChunks);
    // Unconditional, un-throttled emit on chunk completion: recovers any
    // in-flight delta the throttle above coalesced away, and is the only
    // signal a caller gets for chunks small enough to finish inside one
    // throttle window.
    emitProgress(title, summary, completedChunks, null);
  }

  const joined = sanitizeJoinedHtml(completedChunks);
  // If sanitize somehow collapses everything to an empty string (unexpected
  // — the input passed sanitization once already), prefer showing the
  // untranslated original over silently rendering nothing.
  const html = joined.length > 0 ? joined : input.html;

  if (resumable) clearPartialFeedTranslation(opts.itemId!, opts.lang!);
  return { title, summary, html, truncated };
}

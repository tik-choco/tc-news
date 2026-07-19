// Translates a RadioProgram's script (title + each segment's plain text)
// into another language for on-demand display in ProgramView's script pane.
// LOCAL-ONLY, same reasoning as feedTranslate.ts: unlike translate.ts's
// article translation — whose whole point is to be shared over P2P
// (hooks/useNewsRoom.ts's shareTranslation) so the LLM call only has to run
// once per article×language across a room — a program translation is purely
// a convenience for the viewer of one program. It is never persisted to or
// read from the room, so every peer pays for their own call. Audio
// (audioCids / live TTS) always plays the original-language segment.text;
// translated text is display-only.
//
// segment.ruby (the {漢字|かんじ} furigana marker string, lib/ruby.ts) is
// intentionally NOT translated — ruby is a reading aid for the original
// Japanese script only. A translated segment is shown as plain text with no
// ruby annotations, same as an un-rubied original segment.
//
// Pipeline: (1) a small JSON call for the title (mirrors translate.ts's
// title/excerpt call and extractJson leniency/graceful-degrade pattern —
// article and feed translations bundle title with excerpt/summary in one
// call, but a program has no excerpt-equivalent, so this is title-only), (2)
// each segment's text translated one at a time as a plain-text call ("Return
// ONLY the translated text", code-fence stripped the same way as
// translate.ts's Markdown chunks / feedTranslate.ts's HTML chunks).
//
// Segments are translated sequentially, not Promise.all — same reasoning as
// translate.ts/feedTranslate.ts's chunk loops: the target is frequently a
// local model / rate-limited endpoint where concurrent requests would just
// queue up behind each other or fail outright.
//
// No partial-save/resume here (contrast translate.ts's
// partialTranslationStore / feedTranslate.ts's partialFeedTranslationStore):
// a generated program's script is short (typically single-digit to low
// double-digit segments, each a sentence or two — nothing like an article
// body's chunked-Markdown scale), so re-running a cancelled/failed
// translation from scratch costs at most a handful of small LLM calls. The
// added complexity of a resumable partial store isn't worth it for that
// size of job; this can be revisited if programs grow much longer scripts.

import type { ChatMessage } from "@tik-choco/mistai";
import type { RadioProgram } from "../types";
import { requestChatCompletion } from "./llm";
import { tGlobal } from "./i18n";

export interface TranslatedProgramContent {
  title: string;
  // Same length and order as program.segments — segmentTexts[i] is the
  // translation of program.segments[i].text.
  segmentTexts: string[];
}

/** Emitted as translation progresses so callers (the AI job queue wiring /
 * ProgramView) can render a live preview instead of waiting for the whole
 * script. title is null until the title call resolves; segmentTexts holds
 * every segment translated so far (in order, length === doneSegments). */
export interface ProgramTranslationProgressUpdate {
  title: string | null;
  segmentTexts: string[];
  doneSegments: number;
  totalSegments: number;
}

export interface TranslateProgramOptions {
  profileId: string;
  /** Endonym of the target language, e.g. "English" — same convention as translate.ts/generate.ts. */
  targetLanguage: string;
  signal?: AbortSignal;
  onProgress?: (p: ProgramTranslationProgressUpdate) => void;
}

// Cooperative cancellation: checked between LLM calls, never while one is in
// flight — requestChatCompletion doesn't accept an AbortSignal, so an
// in-flight call can't itself be interrupted; cancellation only takes effect
// once it resolves/rejects and control returns to us. Deliberately a local
// copy rather than importing translate.ts's/feedTranslate.ts's throwIfAborted
// — same reasoning those modules give for keeping their own (happy-dom
// test-environment compatibility, consistent error shape, no cross-module
// coupling), kept file-local so each translation module can evolve
// independently.
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("Request cancelled.");
  err.name = "AbortError";
  throw err;
}

// English-based prompt for consistent behavior regardless of the target
// language, which is injected via {targetLanguage} — mirrors
// translate.ts/generate.ts.
function buildTitleSystemPrompt(targetLanguage: string): string {
  return (
    "You are a professional translator for a radio-style news program script. Translate the given " +
    `title into ${targetLanguage}, preserving the original meaning exactly. ` +
    "Do not summarize, add, or omit content. " +
    'Return only the following JSON: {"title": string}.'
  );
}

function buildSegmentSystemPrompt(targetLanguage: string): string {
  return (
    "You are a professional translator for a radio-style news program script fragment. Translate the given " +
    `line into ${targetLanguage}, preserving the original meaning exactly. ` +
    "Do not summarize, add, or omit content. " +
    "Return ONLY the translated text, with no code fences, explanation, or other commentary."
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

// Some models wrap their reply in a ``` fence even when told not to; strip
// it so the result is plain text. Local copy of translate.ts's/
// feedTranslate.ts's stripCodeFences — see throwIfAborted's comment above for
// why this module keeps its own instead of importing.
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

async function translateTitle(
  program: RadioProgram,
  opts: TranslateProgramOptions,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildTitleSystemPrompt(opts.targetLanguage) },
    { role: "user", content: `Title: ${program.title}` },
  ];

  throwIfAborted(opts.signal);

  // Only this call is allowed to throw — a network/HTTP/empty-response
  // failure surfaces to the caller. A malformed JSON reply degrades
  // gracefully below instead of failing the whole translation (mirrors
  // translate.ts's translateTitleExcerpt).
  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, { temperature: 0.2 });
  } catch (err) {
    // Rethrow cancellation as-is so the queue (lib/jobQueue) can tell it
    // apart from an actual failure by err.name, instead of burying it in the
    // localized translateFailed message below.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.translateFailed", { detail }));
  }

  try {
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    return typeof data.title === "string" && data.title.trim() ? data.title : program.title;
  } catch {
    return program.title;
  }
}

async function translateSegmentText(text: string, opts: TranslateProgramOptions): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSegmentSystemPrompt(opts.targetLanguage) },
    { role: "user", content: text },
  ];

  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, { temperature: 0.2 });
  } catch (err) {
    // Same reasoning as translateTitle: don't wrap cancellation.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.translateFailed", { detail }));
  }

  return stripCodeFences(responseText);
}

export async function translateProgram(
  program: RadioProgram,
  opts: TranslateProgramOptions,
): Promise<TranslatedProgramContent> {
  throwIfAborted(opts.signal);

  const totalSegments = program.segments.length;
  let currentTitle: string | null = null;
  const segmentTexts: string[] = [];

  function notifyProgress(): void {
    if (!opts.onProgress) return;
    opts.onProgress({
      title: currentTitle,
      segmentTexts: segmentTexts.slice(),
      doneSegments: segmentTexts.length,
      totalSegments,
    });
  }

  currentTitle = await translateTitle(program, opts);
  notifyProgress();

  // Sequential, not Promise.all — see module header. Cancellation is checked
  // between segment calls, not mid-call — see throwIfAborted's comment above.
  for (let i = 0; i < totalSegments; i++) {
    throwIfAborted(opts.signal);
    const translated = await translateSegmentText(program.segments[i].text, opts);
    segmentTexts.push(translated);
    notifyProgress();
  }

  return { title: currentTitle, segmentTexts };
}

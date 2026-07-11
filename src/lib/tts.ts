// TTS entry point for reading RadioProgram segments aloud. Dispatches to one
// of two engines, chosen by activeTtsEngine() and hidden behind the single
// speakSegments()/isTtsSupported() API so callers (views/ProgramView.tsx)
// never need to know which is active:
//   - "openai": an OpenAI-compatible POST {baseUrl}/audio/speech endpoint,
//     resolved from the shared tc-shared-llm-config-v1 config's `tts` entry
//     (lib/llmConfig.ts's resolveVoice) plus the tc-news-local `ttsEnabled`
//     toggle (lib/llmSettings.ts). Actual fetch + playback lives in
//     lib/openaiTts.ts.
//   - "browser": the Web Speech API (speechSynthesis), implemented directly
//     below. This is the fallback whenever TTS settings are absent/disabled
//     or incomplete. Encodes a handful of well-known Web Speech quirks:
//   - Chrome silently truncates long utterances (~200+ chars), so each
//     segment's text is split into sentence-ish chunks (<= ~180 chars, split
//     on 。!?.!? and greedily rejoined) and queued as one utterance per
//     chunk; onSegment only fires on the first chunk's onstart so callers
//     still see per-segment progress.
//   - Chrome also carries over stale utterance queues between calls, so
//     speakSegments() always calls speechSynthesis.cancel() first.
//   - cancel() itself fires onerror with error "canceled"/"interrupted" on
//     the utterance(s) it aborts; those are expected and swallowed rather
//     than reported as failures.
//   - getVoices() can return an empty list until the async "voiceschanged"
//     event fires (most notably on first load in Chrome); listVoices()
//     waits for it, bounded by a timeout so callers never hang forever.

import { emptyLlmConfig, loadLlmConfig, resolveVoice } from "./llmConfig";
import { loadProviderSettings } from "./llmSettings";
import { speakSegmentsOpenAi } from "./openaiTts";

const MAX_CHUNK_LEN = 180;
const VOICES_TIMEOUT_MS = 2000;

export type TtsEngine = "openai" | "browser";

/** "openai" when the local ttsEnabled toggle is on and the shared config's tts
 * entry resolves to a provider + non-empty model; otherwise "browser". */
export function activeTtsEngine(): TtsEngine {
  if (!loadProviderSettings().ttsEnabled) return "browser";
  const voice = resolveVoice(loadLlmConfig() ?? emptyLlmConfig(), "tts");
  return voice && voice.model.trim() !== "" ? "openai" : "browser";
}

export function isTtsSupported(): boolean {
  if (activeTtsEngine() === "openai") return true;
  return typeof speechSynthesis !== "undefined";
}

/** Resolves once voices are available: immediately if already loaded, else after "voiceschanged" (bounded by a ~2s fallback timeout). */
export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!isTtsSupported()) {
      resolve([]);
      return;
    }
    const synth = speechSynthesis;
    const existing = synth.getVoices();
    if (existing.length > 0) {
      resolve(existing);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener("voiceschanged", onVoicesChanged);
      clearTimeout(timer);
      resolve(synth.getVoices());
    };
    const onVoicesChanged = () => finish();
    synth.addEventListener("voiceschanged", onVoicesChanged);
    const timer = setTimeout(finish, VOICES_TIMEOUT_MS);
  });
}

/** Exact lang-prefix match (e.g. "ja" matches "ja-JP"); prefers a localService voice among matches. */
export function pickDefaultVoice(voices: SpeechSynthesisVoice[], locale: string): SpeechSynthesisVoice | null {
  const base = locale.toLowerCase().split("-")[0];
  if (!base) return null;
  const matches = voices.filter((v) => v.lang.toLowerCase().split("-")[0] === base);
  if (matches.length === 0) return null;
  return matches.find((v) => v.localService) ?? matches[0];
}

export interface TtsPlayback {
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface SpeakSegmentsOptions {
  /** Browser engine only — the Web Speech voice to speak with. */
  voice?: SpeechSynthesisVoice | null;
  /** OpenAI engine only — overrides the shared config's tts.voice for this
   * playback (e.g. the program player's own voice picker). Empty/absent =
   * use the voice from the shared config. */
  openaiVoice?: string;
  /** 0.5..2, default 1 */
  rate?: number;
  /** Fires when segment `index` starts speaking (i.e. its first chunk starts). */
  onSegment?: (index: number) => void;
  /** Fires once all segments have finished. Not fired after stop(). */
  onEnd?: () => void;
  onError?: (err: unknown) => void;
}

// Splits text on sentence-ending punctuation (Japanese and Western), keeping
// each sentence intact, then greedily rejoins sentences into chunks no
// longer than maxLen. A single sentence that itself exceeds maxLen is
// hard-split so no chunk ever blows past the Chrome truncation threshold.
function chunkText(text: string, maxLen: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = trimmed
    .split(/(?<=[。!?！？.!?])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences.length > 0 ? sentences : [trimmed]) {
    if (sentence.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < sentence.length; i += maxLen) {
        chunks.push(sentence.slice(i, i + maxLen));
      }
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Cancels any in-flight speech, then queues `texts` (one RadioProgram segment each) for sequential playback. */
export function speakSegments(texts: string[], opts: SpeakSegmentsOptions): TtsPlayback {
  const inert: TtsPlayback = { pause() {}, resume() {}, stop() {} };

  if (activeTtsEngine() === "openai") {
    const voice = resolveVoice(loadLlmConfig() ?? emptyLlmConfig(), "tts");
    if (voice) return speakSegmentsOpenAi(texts, voice, opts);
  }

  if (!isTtsSupported()) {
    opts.onError?.(new Error("speechSynthesis is not supported in this browser"));
    return inert;
  }

  const synth = speechSynthesis;
  // Stale queues from a previous playback break Chrome if not cleared first.
  synth.cancel();

  interface QueueItem {
    text: string;
    segmentIndex: number;
    isFirstChunk: boolean;
  }
  const queue: QueueItem[] = [];
  texts.forEach((text, segmentIndex) => {
    const chunks = chunkText(text, MAX_CHUNK_LEN);
    chunks.forEach((chunk, i) => {
      queue.push({ text: chunk, segmentIndex, isFirstChunk: i === 0 });
    });
  });

  const rate = opts.rate ?? 1;
  let stopped = false;
  let errorReported = false;
  let queueIndex = 0;

  function reportError(err: unknown): void {
    if (stopped || errorReported) return;
    errorReported = true;
    stopped = true;
    opts.onError?.(err);
  }

  function speakNext(): void {
    if (stopped) return;
    if (queueIndex >= queue.length) {
      opts.onEnd?.();
      return;
    }
    const item = queue[queueIndex];
    queueIndex++;

    const utterance = new SpeechSynthesisUtterance(item.text);
    if (opts.voice) {
      utterance.voice = opts.voice;
      utterance.lang = opts.voice.lang;
    }
    utterance.rate = rate;

    if (item.isFirstChunk) {
      utterance.onstart = () => {
        opts.onSegment?.(item.segmentIndex);
      };
    }
    utterance.onend = () => {
      speakNext();
    };
    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      // cancel() itself triggers "canceled"/"interrupted" errors on
      // whatever utterance was in flight — expected, not a real failure.
      if (event.error === "canceled" || event.error === "interrupted") return;
      reportError(event);
    };

    synth.speak(utterance);
  }

  speakNext();

  return {
    pause() {
      synth.pause();
    },
    resume() {
      synth.resume();
    },
    stop() {
      stopped = true;
      synth.cancel();
    },
  };
}

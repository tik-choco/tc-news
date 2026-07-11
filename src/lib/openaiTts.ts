// OpenAI-compatible TTS engine (POST {baseUrl}/audio/speech). This is the
// "openai" half of lib/tts.ts's engine dispatch (see activeTtsEngine there);
// the "browser" half is speechSynthesis, implemented directly in tts.ts.
//   - synthesizeSpeech() fetches one segment's audio as an mp3 Blob.
//   - speakSegmentsOpenAi() plays a list of segments back-to-back through a
//     single reused HTMLAudioElement (object URLs are created per segment
//     and revoked once consumed), prefetching the next segment's audio while
//     the current one plays so there's no gap waiting on the network.
//   - opts.voice (a Web Speech SpeechSynthesisVoice) has no meaning here and
//     is ignored — the voice comes from the resolved voice config's voice
//     field, unless the caller overrides it per playback via opts.openaiVoice.

import type { SpeakSegmentsOptions, TtsPlayback } from "./tts";

/** Connection + voice info for one TTS call — the shape resolveVoice(cfg, "tts")
 * (lib/llmConfig.ts) returns once the shared config's tts entry is resolved
 * against its provider. */
export interface OpenAiVoiceConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice?: string;
  speed?: number;
}

/** POSTs `text` to {baseUrl}/audio/speech and resolves with the returned audio Blob. Throws on HTTP/network errors. */
export async function synthesizeSpeech(text: string, tts: OpenAiVoiceConfig): Promise<Blob> {
  const url = `${tts.baseUrl.replace(/\/+$/, "")}/audio/speech`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(tts.apiKey ? { Authorization: `Bearer ${tts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: tts.model,
      voice: tts.voice || "alloy",
      input: text,
      response_format: "mp3",
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // best-effort only
    }
    throw new Error(`OpenAI TTS request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return res.blob();
}

/** Sequential segment playback via one reused HTMLAudioElement, prefetching the next segment while the current one plays. */
export function speakSegmentsOpenAi(texts: string[], tts: OpenAiVoiceConfig, opts: SpeakSegmentsOptions): TtsPlayback {
  const inert: TtsPlayback = { pause() {}, resume() {}, stop() {} };
  if (texts.length === 0) {
    opts.onEnd?.();
    return inert;
  }

  // Per-playback voice override (the program player's picker) wins over the
  // voice stored in settings.
  const overrideVoice = opts.openaiVoice?.trim();
  if (overrideVoice) {
    tts = { ...tts, voice: overrideVoice };
  }

  const rate = opts.rate ?? 1;
  const audio = new Audio();
  let stopped = false;
  let errorReported = false;
  let currentUrl: string | null = null;
  // Holds at most one segment's worth of prefetch, keyed by its index.
  let prefetch: { index: number; promise: Promise<Blob> } | null = null;

  function reportError(err: unknown): void {
    if (stopped || errorReported) return;
    errorReported = true;
    stopped = true;
    revokeCurrentUrl();
    opts.onError?.(err);
  }

  function revokeCurrentUrl(): void {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
  }

  function fetchSegment(index: number): Promise<Blob> {
    return synthesizeSpeech(texts[index], tts);
  }

  function ensurePrefetch(index: number): void {
    if (index >= texts.length) return;
    if (prefetch && prefetch.index === index) return;
    prefetch = { index, promise: fetchSegment(index) };
    // Prevent an unhandled-rejection warning; the real error surfaces when
    // this segment is actually awaited in playSegment().
    prefetch.promise.catch(() => {});
  }

  async function playSegment(index: number): Promise<void> {
    if (stopped) return;
    if (index >= texts.length) {
      opts.onEnd?.();
      return;
    }

    let blob: Blob;
    try {
      blob = prefetch && prefetch.index === index ? await prefetch.promise : await fetchSegment(index);
    } catch (err) {
      reportError(err);
      return;
    }
    if (stopped) return;
    prefetch = null;

    revokeCurrentUrl();
    const url = URL.createObjectURL(blob);
    currentUrl = url;
    audio.src = url;
    audio.playbackRate = rate;

    audio.onended = null;
    audio.onerror = null;
    audio.onended = () => {
      if (stopped) return;
      // Kick off next segment's playback (which awaits its own prefetch if
      // already in flight).
      void playSegment(index + 1);
    };
    audio.onerror = () => {
      reportError(audio.error ?? new Error("audio playback failed"));
    };

    opts.onSegment?.(index);
    // Start prefetching the following segment now that this one is playing.
    ensurePrefetch(index + 1);

    try {
      await audio.play();
      // Some browsers reset playbackRate when src changes; reassert it.
      audio.playbackRate = rate;
    } catch (err) {
      reportError(err);
    }
  }

  void playSegment(0);

  return {
    pause() {
      if (stopped) return;
      audio.pause();
    },
    resume() {
      if (stopped) return;
      audio.play().catch((err) => reportError(err));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      revokeCurrentUrl();
    },
  };
}

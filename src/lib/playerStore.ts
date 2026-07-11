// App-global playback singleton for RadioProgram audio. Mirrors lib/jobQueue's
// module-singleton idiom (module-level state, subscribe() returning an
// unsubscribe fn, notify() on every change) so consumers (hooks/usePlayer)
// can use the same useSyncExternalStore-style pattern as useJobQueue.
//
// This replaces the per-view playback state that used to live in
// views/ProgramView.tsx: playback now survives switching tabs (the mini
// player, components/MiniPlayer.tsx, renders app-wide) instead of stopping
// whenever the studio view unmounts.
//
// The actual "which backend plays this program" decision — creator-rendered
// audio (lib/programAudio.ts's playProgramAudio) when the program has
// audioCids, else live TTS (lib/tts.ts's speakSegments) — is the same branch
// ProgramView.tsx's old handlePlay used, extracted here as `playbackFactory`
// so a unit test can substitute a fake and never touch real
// speechSynthesis/network/mistlib storage.

import type { RadioProgram } from "../types";
import { getLocale } from "./i18n";
import { emptyLlmConfig, loadLlmConfig, resolveVoice } from "./llmConfig";
import { activeTtsEngine, listVoices, pickDefaultVoice, speakSegments, type TtsPlayback } from "./tts";
import { playProgramAudio } from "./programAudio";

export type PlayState = "idle" | "playing" | "paused";

export interface PlayerState {
  program: RadioProgram | null;
  playState: PlayState;
  currentIndex: number;
  error: string | null;
}

export interface PlayProgramOptions {
  /** Browser engine only. Absent (key omitted / undefined) resolves a
   * default via listVoices()+pickDefaultVoice(); explicit null means "no
   * voice" (browser default), matching SpeakSegmentsOptions.voice. */
  voice?: SpeechSynthesisVoice | null;
  /** OpenAI engine only. Absent falls back to the shared config's tts.voice
   * (or "alloy"), same as ProgramView's resolvedVoice default. */
  openaiVoice?: string;
  /** 0.5..2, default 1. Applies to this call only — mirrors ProgramView's
   * "rate select applies to next play" behavior. */
  rate?: number;
}

interface ResolvedPlayOptions {
  voice: SpeechSynthesisVoice | null;
  openaiVoice: string;
  rate: number;
}

interface PlaybackCallbacks {
  onSegment: (index: number) => void;
  onEnd: () => void;
  onError: (err: unknown) => void;
}

/** Chooses and starts the playback backend for `program`. Swappable via
 * {@link __setPlaybackFactory} so tests never touch real playback. */
export type PlaybackFactory = (
  program: RadioProgram,
  opts: ResolvedPlayOptions,
  callbacks: PlaybackCallbacks,
) => TtsPlayback;

// Default factory: same branch as ProgramView.tsx's former handlePlay —
// prefer creator-rendered audio (no TTS settings needed to hear it) over
// live speech synthesis whenever the program has one.
function defaultPlaybackFactory(
  program: RadioProgram,
  opts: ResolvedPlayOptions,
  callbacks: PlaybackCallbacks,
): TtsPlayback {
  const hasAudio = (program.audioCids?.length ?? 0) > 0;
  if (hasAudio) {
    return playProgramAudio(
      { cids: program.audioCids ?? [], mime: program.audioMime ?? "audio/mpeg" },
      { rate: opts.rate, ...callbacks },
    );
  }
  return speakSegments(program.segments.map((s) => s.text), {
    voice: opts.voice,
    rate: opts.rate,
    openaiVoice: opts.openaiVoice,
    ...callbacks,
  });
}

let playbackFactory: PlaybackFactory = defaultPlaybackFactory;

/** Test-only seam: swap the playback backend. Pass null to restore the
 * default. See playerStore.test.ts. */
export function __setPlaybackFactory(factory: PlaybackFactory | null): void {
  playbackFactory = factory ?? defaultPlaybackFactory;
}

let state: PlayerState = { program: null, playState: "idle", currentIndex: 0, error: null };
let handle: TtsPlayback | null = null;
// Bumped on every playProgram() call; lets a stale async voice-resolution or
// a stale handle callback (from a program that was superseded before it
// resolved/fired) recognize it's no longer current and no-op instead of
// clobbering the state of whatever plays now.
let generation = 0;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch };
  notify();
}

function stopCurrentHandle(): void {
  if (handle) {
    handle.stop();
    handle = null;
  }
}

export function getPlayerState(): PlayerState {
  return state;
}

export function subscribePlayer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Stops whatever is currently playing (if anything) and starts `program`.
 * Resolves voice/openaiVoice defaults the same way ProgramView.tsx used to
 * when the caller doesn't supply them (e.g. a feed ProgramCard's play
 * button, which has no voice picker of its own).
 */
export async function playProgram(program: RadioProgram, opts: PlayProgramOptions = {}): Promise<void> {
  stopCurrentHandle();
  const myGeneration = ++generation;

  // stateは voice 解決(browser TTSの listVoices は最大~2s かかりうる)を
  // 待つ前に新しい番組へ切り替える — 待っている間、停止済みの古い番組が
  // 「再生中」のまま表示されて操作不能に見える隙間を作らない。解決中に
  // stop/別番組の play が走った場合は generation 不一致で以降が降りる。
  setState({ program, playState: "playing", currentIndex: 0, error: null });

  try {
    let voice = opts.voice;
    if (voice === undefined && activeTtsEngine() === "browser") {
      const voices = await listVoices();
      if (myGeneration !== generation) return; // superseded while awaiting voices
      voice = pickDefaultVoice(voices, program.lang ?? getLocale());
    }

    const openaiVoice =
      opts.openaiVoice ?? resolveVoice(loadLlmConfig() ?? emptyLlmConfig(), "tts")?.voice ?? "alloy";
    const rate = opts.rate ?? 1;
    const resolved: ResolvedPlayOptions = { voice: voice ?? null, openaiVoice, rate };

    const onSegment = (index: number) => {
      if (myGeneration !== generation) return;
      setState({ currentIndex: index });
    };
    const onEnd = () => {
      if (myGeneration !== generation) return;
      handle = null;
      setState({ playState: "idle", currentIndex: 0 });
    };
    const onError = (err: unknown) => {
      if (myGeneration !== generation) return;
      handle = null;
      setState({ playState: "idle", currentIndex: 0, error: err instanceof Error ? err.message : String(err) });
    };

    handle = playbackFactory(program, resolved, { onSegment, onEnd, onError });
  } catch (err) {
    // listVoices の reject や factory の同期 throw でも「再生中のまま固まる」
    // 状態を残さない。呼び出し側は void playProgram(...) なのでここが最後の砦。
    if (myGeneration !== generation) return;
    handle = null;
    setState({ playState: "idle", currentIndex: 0, error: err instanceof Error ? err.message : String(err) });
  }
}

export function pausePlayer(): void {
  if (!handle || state.playState !== "playing") return;
  handle.pause();
  setState({ playState: "paused" });
}

export function resumePlayer(): void {
  if (!handle || state.playState !== "paused") return;
  handle.resume();
  setState({ playState: "playing" });
}

export function stopPlayer(): void {
  generation++; // invalidate any in-flight voice resolution / stale callbacks
  stopCurrentHandle();
  setState({ program: null, playState: "idle", currentIndex: 0, error: null });
}

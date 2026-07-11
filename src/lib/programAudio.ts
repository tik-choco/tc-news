// Podcast-style audio for RadioProgram: the program creator renders each
// segment's script to speech via the OpenAI-compatible TTS endpoint
// (lib/openaiTts.ts) and stores the resulting mp3 bytes in mistlib's
// content-addressed storage (lib/mistClient.ts's storage_add/storage_get).
// The ordered CID array (ProgramAudioSource.cids) is carried on the
// RadioProgram and rides along on the existing tc-news:program wire
// (newsWire.ts's ProgramWire — its `cid` field points at the whole program
// JSON, which itself embeds these audio CIDs), so recipients receive
// audioCids for free when the program is shared.
//
// This lets a recipient play the rendered podcast audio and download a
// combined file — without ever needing their own TTS settings, since the
// audio was already rendered once by the creator and merely needs fetching.

import { storage_add, storage_get } from "./mistClient";
import { synthesizeSpeech, type OpenAiVoiceConfig } from "./openaiTts";
import type { SpeakSegmentsOptions, TtsPlayback } from "./tts";

/** Ordered mistlib storage CIDs for a program's rendered segment audio, plus the shared MIME type of every blob. */
export interface ProgramAudioSource {
  cids: string[];
  mime: string;
}

/**
 * セグメント台本を順にTTSレンダリングして mistlib storage へ格納し、CID配列を返す。
 * エンドポイントへの同時多発リクエストを避けるため逐次実行する。各セグメントの
 * 格納が完了するたびに opts.onProgress(done, total) を呼ぶ。
 *
 * opts.signal はジョブキュー(lib/jobQueue)からのキャンセルを伝える。各セグメント
 * のループ先頭でのみチェックし、TTS呼び出し自体は中断できない(cooperative)—
 * feedTranslate.ts の throwIfAborted と同じ考え方。キャンセル時点まで既に
 * mistlib storage へ格納済みのセグメントは取り消されず残るが、参照されなければ
 * ただの孤立データなので無害。
 */
export async function renderProgramAudio(
  programId: string,
  segmentTexts: string[],
  tts: OpenAiVoiceConfig,
  opts?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal },
): Promise<{ audioCids: string[]; audioMime: string }> {
  const total = segmentTexts.length;
  const audioCids: string[] = [];
  for (let i = 0; i < total; i++) {
    if (opts?.signal?.aborted) {
      const err = new Error("Request cancelled.");
      err.name = "AbortError";
      throw err;
    }
    const blob = await synthesizeSpeech(segmentTexts[i], tts);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const cid = await storage_add(`${programId}.seg${i}.mp3`, bytes);
    audioCids.push(cid);
    opts?.onProgress?.(i + 1, total);
  }
  // openaiTts always requests response_format: "mp3", so every rendered
  // segment is mp3 regardless of the TTS provider/voice used.
  return { audioCids, audioMime: "audio/mpeg" };
}

/** CID列を storage_get で取得し、mime を付けた Blob 配列にする。取得完了ごとに opts.onProgress を呼ぶ。 */
export async function fetchProgramAudioBlobs(
  source: ProgramAudioSource,
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<Blob[]> {
  const total = source.cids.length;
  const blobs: Blob[] = [];
  for (let i = 0; i < total; i++) {
    const bytes = await storage_get(source.cids[i]);
    // storage_get's Uint8Array may be backed by a generic ArrayBufferLike
    // (SharedArrayBuffer included) per its declared type, which BlobPart
    // doesn't accept — re-wrap so the Blob always sees a plain ArrayBuffer.
    blobs.push(new Blob([new Uint8Array(bytes)], { type: source.mime }));
    opts?.onProgress?.(i + 1, total);
  }
  return blobs;
}

/**
 * レンダリング済み音声セグメントの逐次再生。speakSegmentsOpenAi
 * (lib/openaiTts.ts) と同じ構造 — 単一のHTMLAudioElementを使い回し、次
 * セグメントをプリフェッチしながら再生し、消費済みのobjectURLを都度revoke
 * する — だが、ネットワークTTSの代わりに mistlib storage_get でCIDから
 * 取得する点だけが異なる。opts.voice/opts.openaiVoice は音声がレンダリング
 * 時に既に確定しているため意味を持たず、無視される。
 */
export function playProgramAudio(source: ProgramAudioSource, opts: SpeakSegmentsOptions): TtsPlayback {
  const inert: TtsPlayback = { pause() {}, resume() {}, stop() {} };
  const { cids, mime } = source;
  if (cids.length === 0) {
    opts.onEnd?.();
    return inert;
  }

  const rate = opts.rate ?? 1;
  const audio = new Audio();
  let stopped = false;
  let errorReported = false;
  let currentUrl: string | null = null;
  // Holds at most one segment's worth of prefetch, keyed by its index.
  let prefetch: { index: number; promise: Promise<Uint8Array> } | null = null;

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

  function fetchSegment(index: number): Promise<Uint8Array> {
    return storage_get(cids[index]);
  }

  function ensurePrefetch(index: number): void {
    if (index >= cids.length) return;
    if (prefetch && prefetch.index === index) return;
    prefetch = { index, promise: fetchSegment(index) };
    // Prevent an unhandled-rejection warning; the real error surfaces when
    // this segment is actually awaited in playSegment().
    prefetch.promise.catch(() => {});
  }

  async function playSegment(index: number): Promise<void> {
    if (stopped) return;
    if (index >= cids.length) {
      opts.onEnd?.();
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = prefetch && prefetch.index === index ? await prefetch.promise : await fetchSegment(index);
    } catch (err) {
      reportError(err);
      return;
    }
    if (stopped) return;
    prefetch = null;

    revokeCurrentUrl();
    // See fetchProgramAudioBlobs's comment: re-wrap for BlobPart's stricter
    // (plain-ArrayBuffer-backed) Uint8Array requirement.
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
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

// Windows/Unix双方でファイル名に使えない文字(\/:*?"<>|)と制御文字。
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;
const MAX_FILENAME_BASE_LEN = 60;

/**
 * タイトルをファイル名に安全な形へ正規化して ".mp3" を付ける。不正文字を除去し、
 * 前後の空白をtrimし、60文字で切り詰める。結果が空になった場合は fallback を使う。
 */
export function programAudioFileName(title: string, fallback: string): string {
  const sanitize = (s: string): string => s.replace(UNSAFE_FILENAME_CHARS, "").trim().slice(0, MAX_FILENAME_BASE_LEN);

  let base = sanitize(title);
  if (!base) base = sanitize(fallback);
  return `${base}.mp3`;
}

/**
 * 全セグメントBlobを取得して1つのBlobに結合し、アンカー要素経由でダウンロード
 * させる。MP3はフレームごとに自己同期するフォーマットで、各フレームがヘッダー
 * から自身の長さを再取得できるため、複数のmp3 Blobを単純連結しただけでも
 * ほぼ全てのプレイヤーが問題なく先頭から末尾まで再生できる(コンテナに
 * インデックスを持つ形式と違い、再エンコードや特別なマージ処理は不要)。
 */
export async function downloadProgramAudio(
  source: ProgramAudioSource,
  title: string,
  fallbackName: string,
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<void> {
  const blobs = await fetchProgramAudioBlobs(source, opts);
  const combined = new Blob(blobs, { type: source.mime });
  const url = URL.createObjectURL(combined);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = programAudioFileName(title, fallbackName);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

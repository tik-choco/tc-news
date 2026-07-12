// Podcast-style audio for RadioProgram: the program creator renders each
// segment's script to speech via the OpenAI-compatible TTS endpoint
// (lib/openaiTts.ts) and stores the resulting bytes (usually mp3, but some
// OpenAI-compatible servers return wav despite the mp3 request — see
// audioMerge.ts) in mistlib's content-addressed storage
// (lib/mistClient.ts's storage_add/storage_get).
// The ordered CID array (ProgramAudioSource.cids) is carried on the
// RadioProgram and rides along on the existing tc-news:program wire
// (newsWire.ts's ProgramWire — its `cid` field points at the whole program
// JSON, which itself embeds these audio CIDs), so recipients receive
// audioCids for free when the program is shared.
//
// This lets a recipient play the rendered podcast audio and download a
// combined file — without ever needing their own TTS settings, since the
// audio was already rendered once by the creator and merely needs fetching.

import {
  extensionForContainer,
  mergeMp3Segments,
  mergeWavSegments,
  mimeForContainer,
  sniffAudioContainer,
  type AudioContainer,
} from "./audioMerge";
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
  // openaiTts always *requests* response_format: "mp3", but that's just a
  // request parameter — OpenAI-compatible TTS servers aren't guaranteed to
  // honor it and some return WAV regardless. Sniff the first segment's
  // actual bytes (assumed representative of every segment, since they all
  // come from the same server/config) instead of trusting the request, and
  // use that container consistently for every segment's storage filename.
  let ext = ".mp3";
  let audioMime = "audio/mpeg";
  for (let i = 0; i < total; i++) {
    if (opts?.signal?.aborted) {
      const err = new Error("Request cancelled.");
      err.name = "AbortError";
      throw err;
    }
    const blob = await synthesizeSpeech(segmentTexts[i], tts);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (i === 0) {
      const container = sniffAudioContainer(bytes);
      audioMime = mimeForContainer(container, "audio/mpeg");
      ext = extensionForContainer(container);
    }
    const cid = await storage_add(`${programId}.seg${i}${ext}`, bytes);
    audioCids.push(cid);
    opts?.onProgress?.(i + 1, total);
  }
  return { audioCids, audioMime };
}

/** CID列を storage_get で順に取得する。取得完了ごとに opts.onProgress を呼ぶ。 */
async function fetchProgramAudioBytes(
  source: ProgramAudioSource,
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<Uint8Array[]> {
  const total = source.cids.length;
  const bytesList: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const bytes = await storage_get(source.cids[i]);
    bytesList.push(bytes);
    opts?.onProgress?.(i + 1, total);
  }
  return bytesList;
}

/** CID列を storage_get で取得し、mime を付けた Blob 配列にする。取得完了ごとに opts.onProgress を呼ぶ。 */
export async function fetchProgramAudioBlobs(
  source: ProgramAudioSource,
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<Blob[]> {
  const bytesList = await fetchProgramAudioBytes(source, opts);
  // storage_get's Uint8Array may be backed by a generic ArrayBufferLike
  // (SharedArrayBuffer included) per its declared type, which BlobPart
  // doesn't accept — re-wrap so the Blob always sees a plain ArrayBuffer.
  return bytesList.map((bytes) => new Blob([new Uint8Array(bytes)], { type: source.mime }));
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
 * タイトルをファイル名に安全な形へ正規化して拡張子(既定 ".mp3")を付ける。不正
 * 文字を除去し、前後の空白をtrimし、60文字で切り詰める。結果が空になった場合は
 * fallback を使う。
 */
export function programAudioFileName(title: string, fallback: string, ext = ".mp3"): string {
  const sanitize = (s: string): string => s.replace(UNSAFE_FILENAME_CHARS, "").trim().slice(0, MAX_FILENAME_BASE_LEN);

  let base = sanitize(title);
  if (!base) base = sanitize(fallback);
  return `${base}${ext}`;
}

/** 単純バイト連結。判定できないコンテナ、およびマージ失敗時のフォールバック。 */
function naiveConcatBytes(segments: Uint8Array[]): Uint8Array {
  const total = segments.reduce((sum, s) => sum + s.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const s of segments) {
    out.set(s, offset);
    offset += s.length;
  }
  return out;
}

/**
 * 全セグメントの実バイトを取得し、コンテナごとに正しくマージして1ファイルに
 * まとめる。単純バイト連結は先頭セグメントのメタデータ(MP3のXing/Infoヘッダの
 * フレーム数、WAVのRIFFヘッダのdataサイズ)がファイル全体を代表してしまい、
 * 「5分の番組が5秒に聞こえる」再生時間の誤認識を引き起こすため、audioMerge.ts
 * のコンテナ別マージ(mergeMp3Segments/mergeWavSegments)を使う。
 *
 * source.mime は共有元・レガシー番組では実体と食い違うことがあるため信用せず、
 * 保存対象の実バイトを sniffAudioContainer で判定してから分岐する:
 *   - mp3: mergeMp3Segments でヘッダー/メタデータフレームを除去して連結
 *   - wav: mergeWavSegments で単一RIFFに統合。パース不能/fmt不一致でthrowした
 *     場合は console.warn の上、従来の単純連結にフォールバック(今までと同じ
 *     壊れ方で、悪化はしない)
 *   - unknown: 従来通り単純連結
 * 判定結果の container から Blob の type とダウンロードファイル名の拡張子も
 * 導く。
 */
export async function downloadProgramAudio(
  source: ProgramAudioSource,
  title: string,
  fallbackName: string,
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<void> {
  const bytesList = await fetchProgramAudioBytes(source, opts);

  let container: AudioContainer = "unknown";
  let merged: Uint8Array;
  if (bytesList.length === 0) {
    merged = new Uint8Array(0);
  } else {
    container = sniffAudioContainer(bytesList[0]);
    if (container === "mp3") {
      merged = mergeMp3Segments(bytesList);
    } else if (container === "wav") {
      try {
        merged = mergeWavSegments(bytesList);
      } catch (err) {
        console.warn("[programAudio] mergeWavSegments failed; falling back to naive concatenation", err);
        merged = naiveConcatBytes(bytesList);
      }
    } else {
      merged = naiveConcatBytes(bytesList);
    }
  }

  const mime = mimeForContainer(container, source.mime);
  const ext = extensionForContainer(container);
  // See fetchProgramAudioBlobs's comment: re-wrap for BlobPart's stricter
  // (plain-ArrayBuffer-backed) Uint8Array requirement.
  const combined = new Blob([new Uint8Array(merged)], { type: mime });
  const url = URL.createObjectURL(combined);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = programAudioFileName(title, fallbackName, ext);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

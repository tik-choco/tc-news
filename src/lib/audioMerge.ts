// Container-aware merging for per-segment TTS audio (see programAudio.ts).
// Naive byte-concatenation of audio files makes the FIRST segment's metadata
// speak for the whole file: an MP3 Xing/Info (VBR) header declares only its
// own segment's frame count, and a WAV RIFF header declares only its own
// data-chunk size — either way players report/stop at the first segment's
// duration (the "5-minute program saves as a 5-second file" bug). This
// module sniffs the actual container from the bytes (the TTS endpoint is
// only *asked* for mp3 — OpenAI-compatible servers may return WAV anyway)
// and merges accordingly.

export type AudioContainer = "mp3" | "wav" | "unknown";

/** Detects the container from magic bytes: "RIFF....WAVE" → wav, an ID3v2
 * tag or an MPEG frame sync (0xFF 0xEx/0xFx) → mp3, anything else →
 * unknown. */
export function sniffAudioContainer(bytes: Uint8Array): AudioContainer {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // "R"
    bytes[1] === 0x49 && // "I"
    bytes[2] === 0x46 && // "F"
    bytes[3] === 0x46 && // "F"
    bytes[8] === 0x57 && // "W"
    bytes[9] === 0x41 && // "A"
    bytes[10] === 0x56 && // "V"
    bytes[11] === 0x45 // "E"
  ) {
    return "wav";
  }

  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // ID3v2 tag ("ID3") — near-certain mp3, tag is always followed by frames.
    return "mp3";
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // MPEG frame sync: 11 set bits (0xFF plus the top 3 bits of the next byte).
    return "mp3";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// MP3 merging
// ---------------------------------------------------------------------------

/** MPEG1 Layer III bitrates (kbps) indexed by the 4-bit bitrate index. */
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** MPEG2/2.5 Layer III bitrates (kbps) indexed by the 4-bit bitrate index. */
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000];
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000];

interface LeadingFrameInfo {
  /** Total byte length of this frame (header + side info + payload). */
  frameLength: number;
  /** Whether this frame is a Xing/Info/VBRI metadata frame, not real audio. */
  isMetadata: boolean;
}

/**
 * Parses the MPEG frame at `offset` far enough to compute its length and to
 * check whether it is a Xing/Info/VBRI metadata frame. Only Layer III is
 * understood (the layer TTS backends emit); anything else, or a header that
 * doesn't parse as a plausible frame, returns null so the caller leaves the
 * bytes untouched.
 */
function parseLeadingFrame(bytes: Uint8Array, offset: number): LeadingFrameInfo | null {
  if (offset + 4 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;

  const b1 = bytes[offset + 1];
  const versionBits = (b1 >> 3) & 0x03; // 00=MPEG2.5, 01=reserved, 10=MPEG2, 11=MPEG1
  const layerBits = (b1 >> 1) & 0x03; // 01=Layer III
  if (versionBits === 0x01 || layerBits !== 0x01) return null;

  const b2 = bytes[offset + 2];
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null;

  const isMpeg1 = versionBits === 0x03;
  const bitrateTable = isMpeg1 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES;
  const sampleRateTable = isMpeg1
    ? MPEG1_SAMPLE_RATES
    : versionBits === 0x02
      ? MPEG2_SAMPLE_RATES
      : MPEG25_SAMPLE_RATES;

  const bitrateKbps = bitrateTable[bitrateIndex];
  const sampleRate = sampleRateTable[sampleRateIndex];
  const samplesPerFrame = isMpeg1 ? 1152 : 576;
  const frameLength = Math.floor(((samplesPerFrame / 8) * (bitrateKbps * 1000)) / sampleRate) + padding;
  if (frameLength <= 4 || offset + frameLength > bytes.length) return null;

  const b3 = bytes[offset + 3];
  const channelMode = (b3 >> 6) & 0x03; // 11 = mono, else stereo/joint/dual
  const isMono = channelMode === 0x03;

  // Xing/Info tags sit right after the side info, whose size depends on
  // MPEG version and channel mode. VBRI tags are always at a fixed offset
  // (Fraunhofer encoders don't bother with the side-info-relative position).
  const sideInfoTagOffset = isMpeg1 ? (isMono ? 21 : 36) : isMono ? 13 : 21;

  const tagAt = (pos: number, tag: string): boolean => {
    if (offset + pos + tag.length > bytes.length) return false;
    for (let i = 0; i < tag.length; i++) {
      if (bytes[offset + pos + i] !== tag.charCodeAt(i)) return false;
    }
    return true;
  };

  const isMetadata = tagAt(sideInfoTagOffset, "Xing") || tagAt(sideInfoTagOffset, "Info") || tagAt(36, "VBRI");

  return { frameLength, isMetadata };
}

/**
 * Strips a leading ID3v2 tag, a trailing ID3v1 tag, and a leading
 * Xing/Info/VBRI metadata frame from one mp3 segment. Any assumption
 * violation (malformed tag size, truncated frame, etc.) is caught and the
 * segment is returned unmodified — passing a segment through untouched is
 * safer than guessing wrong and corrupting the stream.
 */
function stripMp3Segment(segment: Uint8Array): Uint8Array {
  try {
    let start = 0;
    let end = segment.length;

    // Leading ID3v2 tag: "ID3" + 2-byte version + 1-byte flags + 4-byte
    // syncsafe size (7 bits per byte). Bit 0x10 of flags means a 10-byte
    // footer duplicates the header, adding 10 more bytes to skip.
    if (segment.length >= 10 && segment[0] === 0x49 && segment[1] === 0x44 && segment[2] === 0x33) {
      const flags = segment[5];
      const sizeByte = (i: number) => segment[6 + i] & 0x7f;
      const tagBodySize = (sizeByte(0) << 21) | (sizeByte(1) << 14) | (sizeByte(2) << 7) | sizeByte(3);
      const hasFooter = (flags & 0x10) !== 0;
      const tagTotal = 10 + tagBodySize + (hasFooter ? 10 : 0);
      if (tagTotal > 0 && tagTotal <= segment.length) {
        start = tagTotal;
      }
    }

    // Trailing ID3v1 tag: fixed 128 bytes starting with "TAG".
    if (
      end - start >= 128 &&
      segment[end - 128] === 0x54 &&
      segment[end - 127] === 0x41 &&
      segment[end - 126] === 0x47
    ) {
      end -= 128;
    }

    // Leading Xing/Info/VBRI metadata frame — its declared frame count
    // reflects only this segment, which is exactly what makes naive
    // concatenation under-report the whole file's duration.
    const frame = parseLeadingFrame(segment, start);
    if (frame && frame.isMetadata) {
      start += frame.frameLength;
    }

    if (start >= end) return segment; // stripping would empty the segment — bail out
    if (start === 0 && end === segment.length) return segment;
    return segment.subarray(start, end);
  } catch {
    // Fallback: any parsing surprise leaves the segment untouched.
    return segment;
  }
}

/**
 * Merges MP3 segments into one playable CBR-friendly frame stream: for each
 * segment, strips any ID3v2 tag (header-declared length), a trailing ID3v1
 * "TAG" block, and a leading Xing/Info/VBRI metadata frame (whose
 * per-segment frame counts are what break whole-file duration), then
 * concatenates the remaining frames. No re-encoding.
 */
export function mergeMp3Segments(segments: Uint8Array[]): Uint8Array {
  const stripped = segments.map(stripMp3Segment);
  const totalLength = stripped.reduce((sum, s) => sum + s.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const s of stripped) {
    out.set(s, offset);
    offset += s.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WAV merging
// ---------------------------------------------------------------------------

interface ParsedWavSegment {
  /** The "fmt " chunk verbatim, including its 8-byte id+size header. */
  fmtChunk: Uint8Array;
  /** The "data" chunk's payload only (no header, no pad byte). */
  dataPayload: Uint8Array;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function chunkIdAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Parses a RIFF/WAVE buffer far enough to locate its "fmt " and "data"
 * chunks. Throws on anything that doesn't look like a well-formed RIFF/WAVE
 * file — callers are expected to fall back to naive concatenation.
 */
function parseWavSegment(segment: Uint8Array): ParsedWavSegment {
  if (
    segment.length < 12 ||
    segment[0] !== 0x52 || // "R"
    segment[1] !== 0x49 || // "I"
    segment[2] !== 0x46 || // "F"
    segment[3] !== 0x46 || // "F"
    segment[8] !== 0x57 || // "W"
    segment[9] !== 0x41 || // "A"
    segment[10] !== 0x56 || // "V"
    segment[11] !== 0x45 // "E"
  ) {
    throw new Error("mergeWavSegments: not a RIFF/WAVE buffer");
  }

  let offset = 12;
  let fmtChunk: Uint8Array | null = null;
  let dataPayload: Uint8Array | null = null;

  while (offset + 8 <= segment.length) {
    const id = chunkIdAt(segment, offset);
    const size = readUint32LE(segment, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > segment.length) {
      throw new Error(`mergeWavSegments: truncated "${id}" chunk`);
    }

    if (id === "fmt " && !fmtChunk) {
      fmtChunk = segment.subarray(offset, dataEnd);
    } else if (id === "data" && !dataPayload) {
      dataPayload = segment.subarray(dataStart, dataEnd);
    }

    // Chunks are word-aligned: an odd-sized chunk has one pad byte after it
    // that isn't counted in the chunk's own size field.
    offset = dataEnd + (size % 2);
  }

  if (!fmtChunk) throw new Error('mergeWavSegments: missing "fmt " chunk');
  if (!dataPayload) throw new Error('mergeWavSegments: missing "data" chunk');

  return { fmtChunk, dataPayload };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Merges PCM WAV segments into a single RIFF file: validates every segment
 * parses as RIFF/WAVE with an identical "fmt " chunk, concatenates the
 * "data" chunk payloads, and emits one correct header. Throws Error on
 * unparseable input or fmt mismatch — callers fall back to naive
 * concatenation (no worse than today's behavior).
 */
export function mergeWavSegments(segments: Uint8Array[]): Uint8Array {
  if (segments.length === 0) {
    throw new Error("mergeWavSegments: no segments provided");
  }

  const parsed = segments.map(parseWavSegment);
  const fmtChunk = parsed[0].fmtChunk;
  for (let i = 1; i < parsed.length; i++) {
    if (!bytesEqual(parsed[i].fmtChunk, fmtChunk)) {
      throw new Error('mergeWavSegments: "fmt " chunks differ between segments');
    }
  }

  const totalDataSize = parsed.reduce((sum, p) => sum + p.dataPayload.length, 0);
  const fmtPadding = fmtChunk.length % 2; // fmt payload size parity == chunk length parity (8-byte header is even)
  const dataPadding = totalDataSize % 2;
  const totalLength = 12 + fmtChunk.length + fmtPadding + 8 + totalDataSize + dataPadding;

  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);

  out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, totalLength - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  let offset = 12;
  out.set(fmtChunk, offset);
  offset += fmtChunk.length + fmtPadding; // pad byte (if any) stays zero-initialized

  out.set([0x64, 0x61, 0x74, 0x61], offset); // "data"
  view.setUint32(offset + 4, totalDataSize, true);
  offset += 8;
  for (const p of parsed) {
    out.set(p.dataPayload, offset);
    offset += p.dataPayload.length;
  }

  return out;
}

export function mimeForContainer(container: AudioContainer, fallback: string): string {
  if (container === "mp3") return "audio/mpeg";
  if (container === "wav") return "audio/wav";
  return fallback;
}

/** File extension (with dot) for a sniffed container; unknown falls back to ".mp3" (today's behavior). */
export function extensionForContainer(container: AudioContainer): string {
  return container === "wav" ? ".wav" : ".mp3";
}

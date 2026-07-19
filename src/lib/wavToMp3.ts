// Browser-side WAV → MP3 encoding for saved TTS audio (see audioMerge.ts /
// programAudio.ts). openaiTts.ts always *requests* response_format: "mp3",
// but some OpenAI-compatible TTS servers return WAV anyway regardless of the
// request — programAudio.ts already sniffs the actual container to merge
// segments correctly. Since we now default saved program audio to mp3, a WAV
// response has to be transcoded before it hits disk. This module does that
// entirely in the browser with the pure-JS lamejs encoder (no native/WASM
// dependency, no server round-trip).

import { Mp3Encoder } from "@breezystack/lamejs";

export interface WavToMp3Options {
  /** MP3 bitrate in kbps. Default 128. */
  bitrateKbps?: number;
}

const DEFAULT_BITRATE_KBPS = 128;

/** lamejs encodes in blocks of this many samples per channel (MPEG1 Layer III frame size). */
const SAMPLES_PER_BLOCK = 1152;

/** WAVE_FORMAT_PCM */
const FORMAT_TAG_PCM = 1;
/** WAVE_FORMAT_IEEE_FLOAT */
const FORMAT_TAG_IEEE_FLOAT = 3;
/** WAVE_FORMAT_EXTENSIBLE — actual format lives in the SubFormat GUID. */
const FORMAT_TAG_EXTENSIBLE = 0xfffe;

interface ParsedFmt {
  /** Effective format tag: PCM (1) or IEEE float (3) after resolving WAVE_FORMAT_EXTENSIBLE. */
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function chunkIdAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Parses a "fmt " chunk payload (the bytes after the 8-byte id+size header).
 * Resolves WAVE_FORMAT_EXTENSIBLE (formatTag 0xFFFE) down to the real PCM/
 * float tag by reading the first two bytes of the 16-byte SubFormat GUID
 * that follows cbSize/validBitsPerSample/channelMask — those two bytes carry
 * the same format-tag values (1 = PCM, 3 = IEEE float) as the plain header,
 * since the well-known audio SubFormat GUIDs are of the form
 * "0000000X-0000-0010-8000-00AA00389B71".
 */
function parseFmtChunk(payload: Uint8Array): ParsedFmt {
  if (payload.length < 16) {
    throw new Error("wavToMp3: \"fmt \" chunk is too short");
  }

  const rawFormatTag = readUint16LE(payload, 0);
  const channels = readUint16LE(payload, 2);
  const sampleRate = readUint32LE(payload, 4);
  const bitsPerSample = readUint16LE(payload, 14);

  let formatTag = rawFormatTag;
  if (rawFormatTag === FORMAT_TAG_EXTENSIBLE) {
    // Base PCMWAVEFORMAT fields (16) + cbSize (2) + validBitsPerSample (2) +
    // channelMask (4) + SubFormat GUID (16) = 40 bytes of payload needed.
    if (payload.length < 40) {
      throw new Error("wavToMp3: WAVE_FORMAT_EXTENSIBLE \"fmt \" chunk is too short");
    }
    formatTag = readUint16LE(payload, 24); // first 2 bytes of the SubFormat GUID
  }

  if (formatTag !== FORMAT_TAG_PCM && formatTag !== FORMAT_TAG_IEEE_FLOAT) {
    throw new Error(`wavToMp3: unsupported WAV format tag 0x${formatTag.toString(16)}`);
  }
  if (channels !== 1 && channels !== 2) {
    throw new Error(`wavToMp3: unsupported channel count ${channels} (only mono/stereo supported)`);
  }
  if (bitsPerSample % 8 !== 0 || bitsPerSample <= 0) {
    throw new Error(`wavToMp3: unsupported bits-per-sample ${bitsPerSample}`);
  }

  return { formatTag, channels, sampleRate, bitsPerSample };
}

interface ParsedWav {
  fmt: ParsedFmt;
  /** The "data" chunk's payload only (no header, no pad byte). */
  dataPayload: Uint8Array;
}

/**
 * Parses a RIFF/WAVE buffer far enough to locate its "fmt " and "data"
 * chunks, same chunk-walking logic as audioMerge.ts's parseWavSegment.
 * Chunks are word-aligned: an odd-sized chunk is followed by one pad byte
 * not counted in its own size field. Throws on anything that doesn't look
 * like a well-formed RIFF/WAVE file, or where a chunk's declared size runs
 * past the end of the buffer (a truncated response).
 */
function parseWav(bytes: Uint8Array): ParsedWav {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0x52 || // "R"
    bytes[1] !== 0x49 || // "I"
    bytes[2] !== 0x46 || // "F"
    bytes[3] !== 0x46 || // "F"
    bytes[8] !== 0x57 || // "W"
    bytes[9] !== 0x41 || // "A"
    bytes[10] !== 0x56 || // "V"
    bytes[11] !== 0x45 // "E"
  ) {
    throw new Error("wavToMp3: not a RIFF/WAVE buffer");
  }

  let offset = 12;
  let fmt: ParsedFmt | null = null;
  let dataPayload: Uint8Array | null = null;

  while (offset + 8 <= bytes.length) {
    const id = chunkIdAt(bytes, offset);
    const size = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) {
      throw new Error(`wavToMp3: truncated "${id}" chunk`);
    }

    if (id === "fmt " && !fmt) {
      fmt = parseFmtChunk(bytes.subarray(dataStart, dataEnd));
    } else if (id === "data" && !dataPayload) {
      dataPayload = bytes.subarray(dataStart, dataEnd);
    }

    offset = dataEnd + (size % 2);
  }

  if (!fmt) throw new Error('wavToMp3: missing "fmt " chunk');
  if (!dataPayload) throw new Error('wavToMp3: missing "data" chunk');

  return { fmt, dataPayload };
}

/** Clamps a float sample to [-1, 1] and scales to the Int16 range. */
function floatSampleToInt16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/**
 * Reads a single PCM/float sample at `byteOffset` and converts it to Int16.
 * Only 8/16/24/32-bit PCM and 32-bit float are supported (bit depth is
 * validated up front by parseFmtChunk).
 */
function readSampleAsInt16(view: DataView, byteOffset: number, bitsPerSample: number, isFloat: boolean): number {
  if (isFloat) {
    // Only 32-bit IEEE float is a realistic WAV encoding.
    return floatSampleToInt16(view.getFloat32(byteOffset, true));
  }
  switch (bitsPerSample) {
    case 8: {
      // 8-bit PCM is unsigned with a midpoint of 128.
      const unsigned = view.getUint8(byteOffset);
      return (unsigned - 128) << 8;
    }
    case 16:
      return view.getInt16(byteOffset, true);
    case 24: {
      // No native 24-bit read: assemble a signed value from 3 LE bytes, then
      // keep only the top 16 bits (matches how 16-bit PCM would round the
      // same amplitude).
      const b0 = view.getUint8(byteOffset);
      const b1 = view.getUint8(byteOffset + 1);
      const b2 = view.getUint8(byteOffset + 2);
      let value = b0 | (b1 << 8) | (b2 << 16);
      if (value & 0x800000) value |= ~0xffffff; // sign-extend 24 -> 32 bits
      return value >> 8;
    }
    case 32:
      // 32-bit signed PCM: keep the top 16 bits.
      return view.getInt32(byteOffset, true) >> 16;
    default:
      throw new Error(`wavToMp3: unsupported bits-per-sample ${bitsPerSample}`);
  }
}

/**
 * Encodes PCM WAV bytes to MP3 bytes, synchronously, entirely in the
 * browser. Parses the RIFF/WAVE container (fmt + data chunks, including
 * WAVE_FORMAT_EXTENSIBLE), converts every sample to Int16 regardless of the
 * source bit depth/format, and feeds lamejs's Mp3Encoder in
 * 1152-sample blocks (its native MPEG1 Layer III frame size). Throws Error
 * on unparseable input or an unsupported format/channel count.
 */
export function wavToMp3(wavBytes: Uint8Array, opts: WavToMp3Options = {}): Uint8Array {
  const bitrateKbps = opts.bitrateKbps ?? DEFAULT_BITRATE_KBPS;
  const { fmt, dataPayload } = parseWav(wavBytes);
  const { channels, sampleRate, bitsPerSample, formatTag } = fmt;
  const isFloat = formatTag === FORMAT_TAG_IEEE_FLOAT;

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const numFrames = Math.floor(dataPayload.length / blockAlign);

  const view = new DataView(dataPayload.buffer, dataPayload.byteOffset, dataPayload.byteLength);
  const encoder = new Mp3Encoder(channels, sampleRate, bitrateKbps);
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  const pushChunk = (chunk: Uint8Array) => {
    if (chunk.length === 0) return;
    chunks.push(chunk);
    totalLength += chunk.length;
  };

  const left = new Int16Array(SAMPLES_PER_BLOCK);
  const right = channels === 2 ? new Int16Array(SAMPLES_PER_BLOCK) : undefined;

  for (let blockStart = 0; blockStart < numFrames; blockStart += SAMPLES_PER_BLOCK) {
    const blockLength = Math.min(SAMPLES_PER_BLOCK, numFrames - blockStart);
    for (let i = 0; i < blockLength; i++) {
      const frameOffset = (blockStart + i) * blockAlign;
      left[i] = readSampleAsInt16(view, frameOffset, bitsPerSample, isFloat);
      if (right) {
        right[i] = readSampleAsInt16(view, frameOffset + bytesPerSample, bitsPerSample, isFloat);
      }
    }
    const leftBlock = blockLength === SAMPLES_PER_BLOCK ? left : left.subarray(0, blockLength);
    const rightBlock = right ? (blockLength === SAMPLES_PER_BLOCK ? right : right.subarray(0, blockLength)) : undefined;
    pushChunk(encoder.encodeBuffer(leftBlock, rightBlock));
  }
  pushChunk(encoder.flush());

  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

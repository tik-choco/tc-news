import { describe, expect, it } from "vitest";
import { sniffAudioContainer } from "./audioMerge";
import { wavToMp3 } from "./wavToMp3";

// ---------------------------------------------------------------------------
// Synthetic-WAV test helpers (no real audio files needed)
// ---------------------------------------------------------------------------

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function asciiBytes(s: string): Uint8Array {
  return bytes(s.split("").map((c) => c.charCodeAt(0)));
}

function uint32LE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Builds one RIFF chunk (id + size header + body), appending the mandatory
 * word-alignment pad byte when the body length is odd — exactly what a real
 * WAV writer would emit, and what wavToMp3's chunk walker is expected to
 * skip over via `offset = dataEnd + (size % 2)`. */
function buildChunk(id: string, body: Uint8Array): Uint8Array {
  const padded = body.length % 2 === 1 ? concatBytes(body, bytes([0])) : body;
  return concatBytes(asciiBytes(id), uint32LE(body.length), padded);
}

function buildWav(chunks: Uint8Array[]): Uint8Array {
  const body = concatBytes(asciiBytes("WAVE"), ...chunks);
  return concatBytes(asciiBytes("RIFF"), uint32LE(body.length), body);
}

interface FmtOpts {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Wrap as WAVE_FORMAT_EXTENSIBLE (0xFFFE) with `formatTag` as the SubFormat. */
  extensible?: boolean;
}

function buildFmtChunk(opts: FmtOpts): Uint8Array {
  const { formatTag, channels, sampleRate, bitsPerSample, extensible } = opts;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const baseLength = extensible ? 40 : 16;
  const body = new Uint8Array(baseLength);
  const view = new DataView(body.buffer);
  view.setUint16(0, extensible ? 0xfffe : formatTag, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, byteRate, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bitsPerSample, true);

  if (extensible) {
    view.setUint16(16, 22, true); // cbSize
    view.setUint16(18, bitsPerSample, true); // validBitsPerSample
    view.setUint32(20, 0, true); // channelMask
    // SubFormat GUID: only the first 2 bytes (the format tag) matter to the parser.
    view.setUint16(24, formatTag, true);
  }

  return buildChunk("fmt ", body);
}

/** A short sine wave, one sample array per channel, values in [-1, 1]. Silence
 * (all zeros) would also encode fine, but a sine wave exercises the full
 * amplitude range of each bit-depth conversion path. */
function sineFrames(numFrames: number, channels: number): number[][] {
  const frames: number[][] = [];
  for (let i = 0; i < numFrames; i++) {
    const frame: number[] = [];
    for (let ch = 0; ch < channels; ch++) {
      // Slightly different frequency per channel so stereo channels differ.
      const freq = 440 + ch * 110;
      frame.push(Math.sin((2 * Math.PI * freq * i) / 44100) * 0.5);
    }
    frames.push(frame);
  }
  return frames;
}

function encodePcm8(frames: number[][]): Uint8Array {
  const channels = frames[0].length;
  const out = new Uint8Array(frames.length * channels);
  let offset = 0;
  for (const frame of frames) {
    for (const s of frame) {
      out[offset++] = Math.round((s * 0.5 + 0.5) * 255);
    }
  }
  return out;
}

function encodePcm16(frames: number[][]): Uint8Array {
  const channels = frames[0].length;
  const out = new Uint8Array(frames.length * channels * 2);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const frame of frames) {
    for (const s of frame) {
      view.setInt16(offset, Math.round(s * 32767), true);
      offset += 2;
    }
  }
  return out;
}

function encodePcm24(frames: number[][]): Uint8Array {
  const channels = frames[0].length;
  const out = new Uint8Array(frames.length * channels * 3);
  let offset = 0;
  for (const frame of frames) {
    for (const s of frame) {
      let value = Math.round(s * 0x7fffff);
      if (value < 0) value += 0x1000000; // two's complement within 24 bits
      out[offset] = value & 0xff;
      out[offset + 1] = (value >> 8) & 0xff;
      out[offset + 2] = (value >> 16) & 0xff;
      offset += 3;
    }
  }
  return out;
}

function encodeFloat32(frames: number[][]): Uint8Array {
  const channels = frames[0].length;
  const out = new Uint8Array(frames.length * channels * 4);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const frame of frames) {
    for (const s of frame) {
      view.setFloat32(offset, s, true);
      offset += 4;
    }
  }
  return out;
}

function buildSimpleWav(opts: {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  numFrames: number;
  extensible?: boolean;
}): Uint8Array {
  const { formatTag, channels, sampleRate, bitsPerSample, numFrames, extensible } = opts;
  const frames = sineFrames(numFrames, channels);
  const dataBytes =
    bitsPerSample === 8
      ? encodePcm8(frames)
      : bitsPerSample === 16
        ? encodePcm16(frames)
        : bitsPerSample === 24
          ? encodePcm24(frames)
          : formatTag === 3
            ? encodeFloat32(frames)
            : encodePcm16(frames);

  const fmtChunk = buildFmtChunk({ formatTag, channels, sampleRate, bitsPerSample, extensible });
  const dataChunk = buildChunk("data", dataBytes);
  return buildWav([fmtChunk, dataChunk]);
}

// ---------------------------------------------------------------------------
// wavToMp3
// ---------------------------------------------------------------------------

describe("wavToMp3", () => {
  it("encodes 16-bit PCM mono to a non-empty mp3", () => {
    const wav = buildSimpleWav({ formatTag: 1, channels: 1, sampleRate: 44100, bitsPerSample: 16, numFrames: 3000 });
    const mp3 = wavToMp3(wav);
    expect(mp3.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(mp3)).toBe("mp3");
  });

  it("encodes 16-bit PCM stereo to a non-empty mp3", () => {
    const wav = buildSimpleWav({ formatTag: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16, numFrames: 3000 });
    const mp3 = wavToMp3(wav);
    expect(mp3.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(mp3)).toBe("mp3");
  });

  it("encodes 32-bit IEEE float mono to a non-empty mp3", () => {
    const wav = buildSimpleWav({ formatTag: 3, channels: 1, sampleRate: 44100, bitsPerSample: 32, numFrames: 2000 });
    const mp3 = wavToMp3(wav);
    expect(mp3.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(mp3)).toBe("mp3");
  });

  it("encodes 8-bit unsigned PCM mono to a non-empty mp3", () => {
    const wav = buildSimpleWav({ formatTag: 1, channels: 1, sampleRate: 44100, bitsPerSample: 8, numFrames: 2000 });
    const mp3 = wavToMp3(wav);
    expect(mp3.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(mp3)).toBe("mp3");
  });

  it("encodes 24-bit PCM mono to a non-empty mp3", () => {
    const wav = buildSimpleWav({ formatTag: 1, channels: 1, sampleRate: 44100, bitsPerSample: 24, numFrames: 2000 });
    const mp3 = wavToMp3(wav);
    expect(mp3.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(mp3)).toBe("mp3");
  });

  it("resolves WAVE_FORMAT_EXTENSIBLE (PCM subtype) and encodes to mp3", () => {
    const wav = buildSimpleWav({
      formatTag: 1,
      channels: 1,
      sampleRate: 44100,
      bitsPerSample: 16,
      numFrames: 2000,
      extensible: true,
    });
    const mp3 = wavToMp3(wav);
    expect(mp3.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(mp3)).toBe("mp3");
  });

  it("resolves WAVE_FORMAT_EXTENSIBLE (IEEE float subtype) and encodes to mp3", () => {
    const wav = buildSimpleWav({
      formatTag: 3,
      channels: 2,
      sampleRate: 44100,
      bitsPerSample: 32,
      numFrames: 2000,
      extensible: true,
    });
    const mp3 = wavToMp3(wav);
    expect(mp3.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(mp3)).toBe("mp3");
  });

  it("reaches the data chunk past an odd-sized intervening chunk (word-align padding)", () => {
    const frames = sineFrames(1500, 1);
    const fmtChunk = buildFmtChunk({ formatTag: 1, channels: 1, sampleRate: 44100, bitsPerSample: 16 });
    // Odd-length body forces a pad byte before the next chunk starts.
    const junkChunk = buildChunk("JUNK", bytes([1, 2, 3, 4, 5]));
    const dataChunk = buildChunk("data", encodePcm16(frames));
    const wav = buildWav([fmtChunk, junkChunk, dataChunk]);

    const mp3 = wavToMp3(wav);
    expect(mp3.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(mp3)).toBe("mp3");
  });

  it("respects the bitrateKbps option", () => {
    const wav = buildSimpleWav({ formatTag: 1, channels: 1, sampleRate: 44100, bitsPerSample: 16, numFrames: 3000 });
    const low = wavToMp3(wav, { bitrateKbps: 32 });
    const high = wavToMp3(wav, { bitrateKbps: 256 });
    expect(low.length).toBeGreaterThan(0);
    expect(high.length).toBeGreaterThan(0);
    expect(sniffAudioContainer(low)).toBe("mp3");
    expect(sniffAudioContainer(high)).toBe("mp3");
  });

  it("throws for a non-RIFF buffer", () => {
    expect(() => wavToMp3(bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow();
  });

  it("throws when the data chunk is truncated (declared size runs past the buffer)", () => {
    const fmtChunk = buildFmtChunk({ formatTag: 1, channels: 1, sampleRate: 44100, bitsPerSample: 16 });
    // Hand-build a "data" chunk whose declared size exceeds the bytes actually present.
    const declaredSize = 1000;
    const truncatedBody = new Uint8Array(10); // far less than declaredSize
    const dataChunk = concatBytes(asciiBytes("data"), uint32LE(declaredSize), truncatedBody);
    const wav = buildWav([fmtChunk, dataChunk]);
    expect(() => wavToMp3(wav)).toThrow();
  });

  it("throws for an unsupported format tag (e.g. A-law)", () => {
    const wav = buildSimpleWav({ formatTag: 6, channels: 1, sampleRate: 44100, bitsPerSample: 8, numFrames: 100 });
    expect(() => wavToMp3(wav)).toThrow();
  });

  it("throws for unsupported channel counts (e.g. 3 channels)", () => {
    const frames = sineFrames(200, 3);
    const fmtChunk = buildFmtChunk({ formatTag: 1, channels: 3, sampleRate: 44100, bitsPerSample: 16 });
    const dataChunk = buildChunk("data", encodePcm16(frames));
    const wav = buildWav([fmtChunk, dataChunk]);
    expect(() => wavToMp3(wav)).toThrow();
  });

  it("throws when the fmt chunk is missing", () => {
    const dataChunk = buildChunk("data", bytes([1, 2, 3, 4]));
    const wav = buildWav([dataChunk]);
    expect(() => wavToMp3(wav)).toThrow();
  });

  it("throws when the data chunk is missing", () => {
    const fmtChunk = buildFmtChunk({ formatTag: 1, channels: 1, sampleRate: 44100, bitsPerSample: 16 });
    const wav = buildWav([fmtChunk]);
    expect(() => wavToMp3(wav)).toThrow();
  });
});

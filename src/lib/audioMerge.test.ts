import { describe, expect, it } from "vitest";
import { mergeMp3Segments, mergeWavSegments, sniffAudioContainer } from "./audioMerge";

// ---------------------------------------------------------------------------
// Synthetic-bytes test helpers (no real audio files needed)
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

/** 4-byte ID3v2 syncsafe size encoding (7 usable bits per byte). */
function encodeSyncsafe(size: number): Uint8Array {
  return bytes([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

/** Builds a minimal ID3v2 tag: "ID3" + version(2) + flags(1) + syncsafe size(4) + body. */
function buildId3v2Tag(bodySize: number, opts: { footer?: boolean } = {}): Uint8Array {
  const flags = opts.footer ? 0x10 : 0x00;
  const header = concatBytes(
    asciiBytes("ID3"),
    bytes([0x03, 0x00]), // version 2.3.0
    bytes([flags]),
    encodeSyncsafe(bodySize),
  );
  const body = new Uint8Array(bodySize); // content is irrelevant to stripping
  const footer = opts.footer ? concatBytes(asciiBytes("3DI"), bytes([0x03, 0x00, 0x10]), encodeSyncsafe(bodySize)) : bytes([]);
  return concatBytes(header, body, footer);
}

/** Builds a 128-byte ID3v1 tag ("TAG" + 125 filler bytes). */
function buildId3v1Tag(): Uint8Array {
  return concatBytes(asciiBytes("TAG"), new Uint8Array(125));
}

/**
 * Builds one synthetic MPEG1 Layer III, 128kbps, 44100Hz, stereo frame.
 * With those parameters the frame length is fixed at 417 bytes
 * (floor(144 * 128000 / 44100) = floor(417.96...) = 417). If `xing` is set,
 * a "Xing" tag is planted at byte offset 36 — the side-info-relative
 * position for MPEG1 stereo — turning this into a metadata frame that
 * mergeMp3Segments should strip.
 */
function buildMpeg1Layer3StereoFrame(opts: { xing?: boolean } = {}): Uint8Array {
  const frameLength = 417;
  const frame = new Uint8Array(frameLength);
  frame[0] = 0xff;
  // sync(3) + version=MPEG1(11) + layer=III(01) + protection=1(no CRC)
  frame[1] = 0xfb;
  // bitrateIndex=9 (128kbps) + sampleRateIndex=0 (44100Hz) + padding=0 + private=0
  frame[2] = (9 << 4) | (0 << 2) | (0 << 1) | 0;
  // channelMode=00 (stereo) + modeExtension=0 + copyright=0 + original=0 + emphasis=00
  frame[3] = 0x00;
  if (opts.xing) {
    frame.set(asciiBytes("Xing"), 36);
  }
  return frame;
}

function buildWavFmtChunk(opts: { sampleRate: number; channels: number; bitsPerSample: number }): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = opts;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  view.setUint16(0, 1, true); // PCM
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, byteRate, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bitsPerSample, true);
  return concatBytes(asciiBytes("fmt "), (() => {
    const sizeField = new Uint8Array(4);
    new DataView(sizeField.buffer).setUint32(0, 16, true);
    return sizeField;
  })(), body);
}

function buildWav(fmtChunk: Uint8Array, dataBytes: Uint8Array): Uint8Array {
  const dataSizeField = new Uint8Array(4);
  new DataView(dataSizeField.buffer).setUint32(0, dataBytes.length, true);
  const dataChunk = concatBytes(asciiBytes("data"), dataSizeField, dataBytes);
  const body = concatBytes(asciiBytes("WAVE"), fmtChunk, dataChunk);
  const riffSizeField = new Uint8Array(4);
  new DataView(riffSizeField.buffer).setUint32(0, body.length, true);
  return concatBytes(asciiBytes("RIFF"), riffSizeField, body);
}

// ---------------------------------------------------------------------------
// sniffAudioContainer
// ---------------------------------------------------------------------------

describe("sniffAudioContainer", () => {
  it("detects RIFF/WAVE as wav", () => {
    const fmt = buildWavFmtChunk({ sampleRate: 44100, channels: 1, bitsPerSample: 16 });
    const wav = buildWav(fmt, new Uint8Array([1, 2, 3, 4]));
    expect(sniffAudioContainer(wav)).toBe("wav");
  });

  it("detects an ID3v2 tag as mp3", () => {
    const withId3 = concatBytes(buildId3v2Tag(10), buildMpeg1Layer3StereoFrame());
    expect(sniffAudioContainer(withId3)).toBe("mp3");
  });

  it("detects a bare MPEG frame sync (0xFF 0xFB) as mp3", () => {
    expect(sniffAudioContainer(bytes([0xff, 0xfb, 0x90, 0x00, 0, 0]))).toBe("mp3");
  });

  it("returns unknown for empty input", () => {
    expect(sniffAudioContainer(new Uint8Array(0))).toBe("unknown");
  });

  it("returns unknown for unrecognized bytes", () => {
    expect(sniffAudioContainer(bytes([1, 2, 3, 4, 5, 6, 7, 8]))).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// mergeMp3Segments
// ---------------------------------------------------------------------------

describe("mergeMp3Segments", () => {
  it("strips a leading ID3v2 tag using its syncsafe-encoded size", () => {
    const payload = bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 300 exercises multiple non-zero syncsafe bytes (300 = 0b1_0010_1100).
    const segment = concatBytes(buildId3v2Tag(300), payload);
    expect(mergeMp3Segments([segment])).toEqual(payload);
  });

  it("strips an ID3v2 tag with a footer (10 extra bytes)", () => {
    const payload = bytes([9, 9, 9, 9]);
    const segment = concatBytes(buildId3v2Tag(50, { footer: true }), payload);
    expect(mergeMp3Segments([segment])).toEqual(payload);
  });

  it("strips a trailing ID3v1 tag", () => {
    const payload = bytes([1, 2, 3, 4, 5]);
    const segment = concatBytes(payload, buildId3v1Tag());
    expect(mergeMp3Segments([segment])).toEqual(payload);
  });

  it("strips a leading Xing metadata frame", () => {
    const xingFrame = buildMpeg1Layer3StereoFrame({ xing: true });
    const trailer = bytes([9, 9, 9, 9]);
    const segment = concatBytes(xingFrame, trailer);
    expect(mergeMp3Segments([segment])).toEqual(trailer);
  });

  it("does not strip a leading frame without a Xing/Info/VBRI tag", () => {
    const realFrame = buildMpeg1Layer3StereoFrame({ xing: false });
    const trailer = bytes([9, 9, 9, 9]);
    const segment = concatBytes(realFrame, trailer);
    expect(mergeMp3Segments([segment])).toEqual(segment);
  });

  it("strips ID3v2 tag, Xing frame, and trailing ID3v1 tag together", () => {
    const payload = bytes([7, 7, 7]);
    const segment = concatBytes(
      buildId3v2Tag(20),
      buildMpeg1Layer3StereoFrame({ xing: true }),
      payload,
      buildId3v1Tag(),
    );
    expect(mergeMp3Segments([segment])).toEqual(payload);
  });

  it("passes an unparseable segment through unchanged", () => {
    const garbage = bytes([1, 2, 3, 4, 5]);
    expect(mergeMp3Segments([garbage])).toEqual(garbage);
  });

  it("concatenates multiple stripped segments in order", () => {
    const seg1 = concatBytes(buildId3v2Tag(10), bytes([1, 1]));
    const seg2 = concatBytes(buildMpeg1Layer3StereoFrame({ xing: true }), bytes([2, 2]));
    const seg3 = bytes([3, 3]);
    expect(mergeMp3Segments([seg1, seg2, seg3])).toEqual(bytes([1, 1, 2, 2, 3, 3]));
  });
});

// ---------------------------------------------------------------------------
// mergeWavSegments
// ---------------------------------------------------------------------------

describe("mergeWavSegments", () => {
  const fmt = buildWavFmtChunk({ sampleRate: 44100, channels: 1, bitsPerSample: 16 });

  it("concatenates data payloads and sums sizes correctly", () => {
    const data1 = bytes([1, 2, 3, 4]);
    const data2 = bytes([5, 6, 7, 8, 9, 10]);
    const wav1 = buildWav(fmt, data1);
    const wav2 = buildWav(fmt, data2);

    const merged = mergeWavSegments([wav1, wav2]);
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);

    // RIFF size = total length - 8
    expect(view.getUint32(4, true)).toBe(merged.length - 8);

    // data chunk starts right after the 12-byte RIFF header and the fmt chunk (24 bytes).
    const dataChunkOffset = 12 + fmt.length;
    expect(String.fromCharCode(merged[dataChunkOffset], merged[dataChunkOffset + 1], merged[dataChunkOffset + 2], merged[dataChunkOffset + 3])).toBe("data");
    expect(view.getUint32(dataChunkOffset + 4, true)).toBe(data1.length + data2.length);

    const payload = merged.subarray(dataChunkOffset + 8, dataChunkOffset + 8 + data1.length + data2.length);
    expect(payload).toEqual(concatBytes(data1, data2));
  });

  it("throws when fmt chunks differ between segments", () => {
    const otherFmt = buildWavFmtChunk({ sampleRate: 22050, channels: 2, bitsPerSample: 16 });
    const wav1 = buildWav(fmt, bytes([1, 2]));
    const wav2 = buildWav(otherFmt, bytes([3, 4]));
    expect(() => mergeWavSegments([wav1, wav2])).toThrow();
  });

  it("throws for non-RIFF input", () => {
    expect(() => mergeWavSegments([bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])])).toThrow();
  });

  it("throws when a segment is missing a data chunk", () => {
    const riffBody = concatBytes(asciiBytes("WAVE"), fmt);
    const sizeField = new Uint8Array(4);
    new DataView(sizeField.buffer).setUint32(0, riffBody.length, true);
    const noDataChunk = concatBytes(asciiBytes("RIFF"), sizeField, riffBody);
    expect(() => mergeWavSegments([noDataChunk])).toThrow();
  });
});

// downloadProgramAudio's container-aware merge dispatch is the regression
// coverage for the "5-minute program saves as a 5-second file" bug: naive
// byte-concatenation lets the first segment's container metadata (an MP3
// Xing/Info header's frame count, or a WAV RIFF header's data-chunk size)
// speak for the whole file. audioMerge.ts (a sibling module, implemented
// separately) owns the actual container parsing/merging logic, so it's
// mocked here — this file only asserts that downloadProgramAudio sniffs the
// real bytes being saved and dispatches to the right merge function per
// container, with the documented wav-merge-failure fallback.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioContainer } from "./audioMerge";

const audioMerge = vi.hoisted(() => ({
  sniffAudioContainer: vi.fn<(bytes: Uint8Array) => AudioContainer>(),
  mergeMp3Segments: vi.fn<(segments: Uint8Array[]) => Uint8Array>(),
  mergeWavSegments: vi.fn<(segments: Uint8Array[]) => Uint8Array>(),
  mimeForContainer: vi.fn((container: AudioContainer, fallback: string) =>
    container === "mp3" ? "audio/mpeg" : container === "wav" ? "audio/wav" : fallback,
  ),
  extensionForContainer: vi.fn((container: AudioContainer) => (container === "wav" ? ".wav" : ".mp3")),
}));
vi.mock("./audioMerge", () => audioMerge);

const mist = vi.hoisted(() => ({
  storage_add: vi.fn(),
  storage_get: vi.fn(),
}));
vi.mock("./mistClient", () => mist);

const wavToMp3Mock = vi.hoisted(() => vi.fn<(bytes: Uint8Array) => Uint8Array>());
vi.mock("./wavToMp3", () => ({ wavToMp3: wavToMp3Mock }));

const openaiTts = vi.hoisted(() => ({
  synthesizeSpeech: vi.fn<(text: string, tts: unknown) => Promise<Blob>>(),
}));
vi.mock("./openaiTts", () => openaiTts);

import { downloadProgramAudio, programAudioFileName, renderProgramAudio, type ProgramAudioSource } from "./programAudio";

/** Leaves a real <a> element in place (document.body.appendChild needs an
 * actual Node under happy-dom) but stubs its click() so downloadProgramAudio
 * never triggers a real navigation. The returned box's `.anchor` is only
 * populated once downloadProgramAudio actually creates the element — read it
 * after awaiting the call, not by destructuring up front. */
function stubAnchor(): { anchor: HTMLAnchorElement | undefined } {
  const box: { anchor: HTMLAnchorElement | undefined } = { anchor: undefined };
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = realCreateElement(tag);
    if (tag === "a") {
      box.anchor = el as HTMLAnchorElement;
      vi.spyOn(box.anchor, "click").mockImplementation(() => {});
    }
    return el;
  }) as typeof document.createElement);
  return box;
}

function source(cids: string[], mime = "audio/mpeg"): ProgramAudioSource {
  return { cids, mime };
}

beforeEach(() => {
  vi.restoreAllMocks();
  audioMerge.sniffAudioContainer.mockReset();
  audioMerge.mergeMp3Segments.mockReset();
  audioMerge.mergeWavSegments.mockReset();
  mist.storage_get.mockReset();
  mist.storage_add.mockReset();
  wavToMp3Mock.mockReset();
  openaiTts.synthesizeSpeech.mockReset();
});

describe("programAudioFileName", () => {
  it("appends .mp3 to a plain title", () => {
    expect(programAudioFileName("Morning News", "fallback")).toBe("Morning News.mp3");
  });

  it("removes characters unsafe on Windows/Unix filesystems", () => {
    expect(programAudioFileName('a/b\\c:d*e?f"g<h>i|j', "fallback")).toBe("abcdefghij.mp3");
  });

  it("removes control characters", () => {
    expect(programAudioFileName("title\x00\x1fend", "fallback")).toBe("titleend.mp3");
  });

  it("trims leading/trailing whitespace", () => {
    expect(programAudioFileName("  spaced title  ", "fallback")).toBe("spaced title.mp3");
  });

  it("truncates to 60 characters before appending .mp3", () => {
    const long = "a".repeat(100);
    const result = programAudioFileName(long, "fallback");
    expect(result).toBe(`${"a".repeat(60)}.mp3`);
  });

  it("falls back when the sanitized title is empty", () => {
    expect(programAudioFileName("***///", "fallback-name")).toBe("fallback-name.mp3");
  });

  it("falls back when the title is only whitespace", () => {
    expect(programAudioFileName("   ", "fallback-name")).toBe("fallback-name.mp3");
  });

  it("sanitizes the fallback too when it also needs cleanup", () => {
    expect(programAudioFileName("", "fall:back")).toBe("fallback.mp3");
  });

  it("uses a custom extension when given one", () => {
    expect(programAudioFileName("Morning News", "fallback", ".wav")).toBe("Morning News.wav");
  });
});

describe("downloadProgramAudio", () => {
  it("sniffs the first segment's real bytes, merges mp3 via mergeMp3Segments, and downloads with a .mp3 name", async () => {
    const seg0 = new Uint8Array([1, 2, 3]);
    const seg1 = new Uint8Array([4, 5, 6]);
    mist.storage_get.mockImplementation(async (cid: string) => (cid === "a" ? seg0 : seg1));
    audioMerge.sniffAudioContainer.mockReturnValue("mp3");
    const merged = new Uint8Array([9, 9]);
    audioMerge.mergeMp3Segments.mockReturnValue(merged);
    const box = stubAnchor();

    await downloadProgramAudio(source(["a", "b"]), "My Program", "fallback");

    // Sniffed the actual bytes fetched for the download, not source.mime.
    expect(audioMerge.sniffAudioContainer).toHaveBeenCalledWith(seg0);
    expect(audioMerge.mergeMp3Segments).toHaveBeenCalledWith([seg0, seg1]);
    expect(audioMerge.mergeWavSegments).not.toHaveBeenCalled();
    expect(box.anchor?.download).toBe("My Program.mp3");
    expect(box.anchor?.click).toHaveBeenCalledTimes(1);
  });

  it("merges wav via mergeWavSegments, converts to mp3, and downloads with a .mp3 name", async () => {
    const seg0 = new Uint8Array([1, 2, 3]);
    mist.storage_get.mockResolvedValue(seg0);
    audioMerge.sniffAudioContainer.mockReturnValue("wav");
    const merged = new Uint8Array([9]);
    audioMerge.mergeWavSegments.mockReturnValue(merged);
    const mp3Bytes = new Uint8Array([7, 7]);
    wavToMp3Mock.mockReturnValue(mp3Bytes);
    const box = stubAnchor();

    // Legacy program: stored mime says mp3, but the real bytes are wav —
    // the sniffed container must win, not source.mime.
    await downloadProgramAudio(source(["a"], "audio/mpeg"), "My Program", "fallback");

    expect(audioMerge.mergeWavSegments).toHaveBeenCalledWith([seg0]);
    expect(audioMerge.mergeMp3Segments).not.toHaveBeenCalled();
    expect(wavToMp3Mock).toHaveBeenCalledWith(merged);
    expect(box.anchor?.download).toBe("My Program.mp3");
  });

  it("keeps the .wav name and audio/wav mime when wavToMp3 throws after a successful wav merge", async () => {
    const seg0 = new Uint8Array([1, 2, 3]);
    mist.storage_get.mockResolvedValue(seg0);
    audioMerge.sniffAudioContainer.mockReturnValue("wav");
    audioMerge.mergeWavSegments.mockReturnValue(new Uint8Array([9]));
    wavToMp3Mock.mockImplementation(() => {
      throw new Error("unsupported wav format");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const box = stubAnchor();

    await downloadProgramAudio(source(["a"], "audio/mpeg"), "My Program", "fallback");

    expect(wavToMp3Mock).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(box.anchor?.download).toBe("My Program.wav");
  });

  it("does not call wavToMp3 for mp3 segments", async () => {
    const seg0 = new Uint8Array([1, 2, 3]);
    mist.storage_get.mockResolvedValue(seg0);
    audioMerge.sniffAudioContainer.mockReturnValue("mp3");
    audioMerge.mergeMp3Segments.mockReturnValue(new Uint8Array([9]));
    stubAnchor();

    await downloadProgramAudio(source(["a"]), "My Program", "fallback");

    expect(wavToMp3Mock).not.toHaveBeenCalled();
  });

  it("falls back to naive concatenation, warns, and skips wavToMp3 when mergeWavSegments throws", async () => {
    const seg0 = new Uint8Array([1, 2]);
    const seg1 = new Uint8Array([3, 4]);
    mist.storage_get.mockImplementation(async (cid: string) => (cid === "a" ? seg0 : seg1));
    audioMerge.sniffAudioContainer.mockReturnValue("wav");
    audioMerge.mergeWavSegments.mockImplementation(() => {
      throw new Error("fmt mismatch");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const box = stubAnchor();

    await downloadProgramAudio(source(["a", "b"]), "My Program", "fallback");

    expect(warn).toHaveBeenCalled();
    // A broken/partial wav should never be handed to wavToMp3 — that would
    // silently produce a plausible-looking but wrong mp3.
    expect(wavToMp3Mock).not.toHaveBeenCalled();
    expect(box.anchor?.download).toBe("My Program.wav");
  });

  it("uses naive concatenation directly for an unknown container, with a .mp3 fallback name", async () => {
    const seg0 = new Uint8Array([1, 2]);
    mist.storage_get.mockResolvedValue(seg0);
    audioMerge.sniffAudioContainer.mockReturnValue("unknown");
    const box = stubAnchor();

    await downloadProgramAudio(source(["a"]), "My Program", "fallback");

    expect(audioMerge.mergeMp3Segments).not.toHaveBeenCalled();
    expect(audioMerge.mergeWavSegments).not.toHaveBeenCalled();
    expect(box.anchor?.download).toBe("My Program.mp3");
  });

  it("does not sniff or merge when there are no segments", async () => {
    stubAnchor();

    await downloadProgramAudio(source([]), "My Program", "fallback");

    expect(audioMerge.sniffAudioContainer).not.toHaveBeenCalled();
    expect(audioMerge.mergeMp3Segments).not.toHaveBeenCalled();
    expect(audioMerge.mergeWavSegments).not.toHaveBeenCalled();
  });
});

describe("renderProgramAudio", () => {
  // synthesizeSpeech's returned Blob round-trips through blob.arrayBuffer()
  // inside renderProgramAudio, which yields a brand-new Uint8Array with the
  // same *content* but a different identity — so mocks below must branch by
  // value, not by reference.
  function blobFrom(bytes: Uint8Array): Blob {
    // Re-wrap for BlobPart's stricter (plain-ArrayBuffer-backed) Uint8Array
    // requirement — same idiom as fetchProgramAudioBlobs.
    return new Blob([new Uint8Array(bytes)]);
  }
  function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  it("converts wav segments to mp3 before storing, and reports audio/mpeg", async () => {
    const seg0Wav = new Uint8Array([1, 2, 3]);
    const seg1Wav = new Uint8Array([4, 5, 6]);
    openaiTts.synthesizeSpeech.mockImplementation(async (text: string) =>
      blobFrom(text === "seg0" ? seg0Wav : seg1Wav),
    );
    audioMerge.sniffAudioContainer.mockReturnValue("wav");
    const seg0Mp3 = new Uint8Array([9, 9]);
    const seg1Mp3 = new Uint8Array([8, 8]);
    wavToMp3Mock.mockImplementation((bytes: Uint8Array) => (sameBytes(bytes, seg0Wav) ? seg0Mp3 : seg1Mp3));
    mist.storage_add.mockResolvedValue("cid");

    const result = await renderProgramAudio("prog1", ["seg0", "seg1"], {} as never);

    expect(wavToMp3Mock).toHaveBeenCalledTimes(2);
    expect(mist.storage_add).toHaveBeenNthCalledWith(1, "prog1.seg0.mp3", seg0Mp3);
    expect(mist.storage_add).toHaveBeenNthCalledWith(2, "prog1.seg1.mp3", seg1Mp3);
    expect(result.audioMime).toBe("audio/mpeg");
  });

  it("falls back to wav for all segments, without retrying wavToMp3, when segment 0's conversion throws", async () => {
    const seg0Wav = new Uint8Array([1, 2, 3]);
    const seg1Wav = new Uint8Array([4, 5, 6]);
    openaiTts.synthesizeSpeech.mockImplementation(async (text: string) =>
      blobFrom(text === "seg0" ? seg0Wav : seg1Wav),
    );
    audioMerge.sniffAudioContainer.mockReturnValue("wav");
    wavToMp3Mock.mockImplementation(() => {
      throw new Error("unsupported wav format");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mist.storage_add.mockResolvedValue("cid");

    const result = await renderProgramAudio("prog1", ["seg0", "seg1"], {} as never);

    expect(warn).toHaveBeenCalled();
    // Only segment 0 pays for the (doomed) conversion attempt; later
    // segments go straight to wav storage.
    expect(wavToMp3Mock).toHaveBeenCalledTimes(1);
    expect(mist.storage_add).toHaveBeenNthCalledWith(1, "prog1.seg0.wav", seg0Wav);
    expect(mist.storage_add).toHaveBeenNthCalledWith(2, "prog1.seg1.wav", seg1Wav);
    expect(result.audioMime).toBe("audio/wav");
  });

  it("does not call wavToMp3 for mp3 segments", async () => {
    const seg0Mp3 = new Uint8Array([1, 2, 3]);
    openaiTts.synthesizeSpeech.mockResolvedValue(blobFrom(seg0Mp3));
    audioMerge.sniffAudioContainer.mockReturnValue("mp3");
    mist.storage_add.mockResolvedValue("cid");

    const result = await renderProgramAudio("prog1", ["seg0"], {} as never);

    expect(wavToMp3Mock).not.toHaveBeenCalled();
    expect(mist.storage_add).toHaveBeenCalledWith("prog1.seg0.mp3", seg0Mp3);
    expect(result.audioMime).toBe("audio/mpeg");
  });
});

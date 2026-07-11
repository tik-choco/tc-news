import { describe, expect, it } from "vitest";
import { programAudioFileName } from "./programAudio";

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
});

import { beforeEach, describe, expect, it } from "vitest";
import { addProgram, loadPrograms } from "./programStore";
import { resetKvStoreForTests } from "./kvStore";
import type { RadioProgram } from "../types";

const PROGRAMS_KEY = "tc-news:programs";

function baseProgram(overrides: Partial<RadioProgram> = {}): RadioProgram {
  return {
    id: "program-1",
    title: "Morning News",
    segments: [{ text: "Hello there." }],
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetKvStoreForTests();
});

describe("programStore imageUrl sanitize", () => {
  it("preserves a valid imageUrl", () => {
    addProgram(baseProgram({ imageUrl: "https://example.com/thumb.jpg" }));
    expect(loadPrograms()[0].imageUrl).toBe("https://example.com/thumb.jpg");
  });

  it("drops a non-string imageUrl", () => {
    localStorage.setItem(PROGRAMS_KEY, JSON.stringify([{ ...baseProgram(), imageUrl: 123 }]));
    expect(loadPrograms()[0].imageUrl).toBeUndefined();
  });

  it("drops an empty-string imageUrl", () => {
    localStorage.setItem(PROGRAMS_KEY, JSON.stringify([{ ...baseProgram(), imageUrl: "" }]));
    expect(loadPrograms()[0].imageUrl).toBeUndefined();
  });
});

describe("programStore segment ruby sanitize", () => {
  it("round-trips a segment's ruby text", () => {
    addProgram(baseProgram({ segments: [{ text: "Hello there.", ruby: "{漢字|かんじ}のテスト" }] }));
    expect(loadPrograms()[0].segments[0].ruby).toBe("{漢字|かんじ}のテスト");
  });

  it("drops a non-string ruby but keeps the segment", () => {
    localStorage.setItem(
      PROGRAMS_KEY,
      JSON.stringify([{ ...baseProgram(), segments: [{ text: "Hello there.", ruby: 123 }] }]),
    );
    const segments = loadPrograms()[0].segments;
    expect(segments).toHaveLength(1);
    expect(segments[0].ruby).toBeUndefined();
  });

  it("drops an empty-string ruby but keeps the segment", () => {
    localStorage.setItem(
      PROGRAMS_KEY,
      JSON.stringify([{ ...baseProgram(), segments: [{ text: "Hello there.", ruby: "" }] }]),
    );
    const segments = loadPrograms()[0].segments;
    expect(segments).toHaveLength(1);
    expect(segments[0].ruby).toBeUndefined();
  });
});

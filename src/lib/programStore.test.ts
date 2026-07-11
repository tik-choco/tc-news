import { beforeEach, describe, expect, it } from "vitest";
import { addProgram, loadPrograms } from "./programStore";
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

import { describe, expect, it } from "vitest";
import { sanitizeSharedProgram } from "./newsWire";

function baseWireProgram(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "program-1",
    title: "Morning Briefing",
    createdAt: Date.now(),
    segments: [{ text: "seg one" }, { text: "seg two" }],
    ...overrides,
  };
}

describe("sanitizeSharedProgram", () => {
  it("passes a legacy program (no audio fields) through unchanged", () => {
    const program = sanitizeSharedProgram(baseWireProgram());
    expect(program).not.toBeNull();
    expect(program?.segments).toHaveLength(2);
    expect(program?.audioCids).toBeUndefined();
    expect(program?.audioMime).toBeUndefined();
    expect(program?.audioVoice).toBeUndefined();
  });

  it("adopts audioCids/audioMime/audioVoice when audioCids fully matches segments", () => {
    const program = sanitizeSharedProgram(
      baseWireProgram({
        audioCids: ["cid-1", "cid-2"],
        audioVoice: "alloy",
      }),
    );
    expect(program).not.toBeNull();
    expect(program?.audioCids).toEqual(["cid-1", "cid-2"]);
    expect(program?.audioMime).toBe("audio/mpeg"); // 既定値
    expect(program?.audioVoice).toBe("alloy");
  });

  it("uses the given audioMime when present and non-empty", () => {
    const program = sanitizeSharedProgram(
      baseWireProgram({
        audioCids: ["cid-1", "cid-2"],
        audioMime: "audio/wav",
      }),
    );
    expect(program?.audioMime).toBe("audio/wav");
  });

  it("keeps the program but drops audio fields when audioCids length mismatches segments", () => {
    const program = sanitizeSharedProgram(
      baseWireProgram({
        audioCids: ["cid-1"], // segmentsは2件
        audioVoice: "alloy",
      }),
    );
    expect(program).not.toBeNull();
    expect(program?.segments).toHaveLength(2);
    expect(program?.audioCids).toBeUndefined();
    expect(program?.audioMime).toBeUndefined();
    expect(program?.audioVoice).toBeUndefined();
  });

  it("keeps the program but drops audio fields when segments were thinned out by sanitization", () => {
    const program = sanitizeSharedProgram(
      baseWireProgram({
        segments: [{ text: "seg one" }, { text: "" }, { text: "seg two" }], // 2件目は不正(空text)で間引かれる
        audioCids: ["cid-1", "cid-2", "cid-3"], // 間引き前のsegments数と一致させても、間引き後とはずれる
      }),
    );
    expect(program).not.toBeNull();
    expect(program?.segments).toHaveLength(2);
    expect(program?.audioCids).toBeUndefined();
    expect(program?.audioMime).toBeUndefined();
    expect(program?.audioVoice).toBeUndefined();
  });

  it("drops audio fields when audioCids contains a non-string or empty-string entry", () => {
    const program = sanitizeSharedProgram(
      baseWireProgram({
        audioCids: ["cid-1", ""],
      }),
    );
    expect(program).not.toBeNull();
    expect(program?.audioCids).toBeUndefined();

    const program2 = sanitizeSharedProgram(
      baseWireProgram({
        audioCids: ["cid-1", 42],
      }),
    );
    expect(program2).not.toBeNull();
    expect(program2?.audioCids).toBeUndefined();
  });

  it("returns null when required fields are missing (no id)", () => {
    expect(sanitizeSharedProgram(baseWireProgram({ id: undefined }))).toBeNull();
  });

  it("returns null when segments are empty", () => {
    expect(sanitizeSharedProgram(baseWireProgram({ segments: [] }))).toBeNull();
  });
});

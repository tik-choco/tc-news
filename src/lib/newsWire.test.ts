import { beforeEach, describe, expect, it } from "vitest";
import { appendProgramLog, loadProgramLog, sanitizeSharedProgram } from "./newsWire";
import type { ProgramWire } from "./newsWire";

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

  it("round-trips a segment's ruby text", () => {
    const program = sanitizeSharedProgram(
      baseWireProgram({ segments: [{ text: "seg one", ruby: "{漢字|かんじ}のテスト" }] }),
    );
    expect(program).not.toBeNull();
    expect(program?.segments[0].ruby).toBe("{漢字|かんじ}のテスト");
  });

  it("drops a non-string ruby but keeps the segment", () => {
    const program = sanitizeSharedProgram(baseWireProgram({ segments: [{ text: "seg one", ruby: 123 }] }));
    expect(program).not.toBeNull();
    expect(program?.segments).toHaveLength(1);
    expect(program?.segments[0].ruby).toBeUndefined();
  });

  it("drops an empty-string ruby but keeps the segment", () => {
    const program = sanitizeSharedProgram(baseWireProgram({ segments: [{ text: "seg one", ruby: "" }] }));
    expect(program).not.toBeNull();
    expect(program?.segments).toHaveLength(1);
    expect(program?.segments[0].ruby).toBeUndefined();
  });
});

function makeProgramWire(overrides: Partial<ProgramWire> = {}): ProgramWire {
  return {
    type: "tc-news:program",
    id: "program-1",
    fromId: "did:key:alice",
    fromName: "Alice",
    timestamp: Date.now(),
    cid: "cid-1",
    signature: "sig-1",
    ...overrides,
  };
}

describe("loadProgramLog / appendProgramLog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty array when the key is unset", () => {
    expect(loadProgramLog("room-1")).toEqual([]);
  });

  it("round-trips a wire through append then load, preserving all fields", () => {
    const wire = makeProgramWire({ fromApp: "tc-news" });
    appendProgramLog("room-1", wire);
    expect(loadProgramLog("room-1")).toEqual([wire]);
  });

  it("round-trips a wire without fromApp", () => {
    const wire = makeProgramWire();
    delete wire.fromApp;
    appendProgramLog("room-1", wire);
    const loaded = loadProgramLog("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(wire);
    expect(loaded[0].fromApp).toBeUndefined();
  });

  it("dedupes by wire.id: a later append with the same id is dropped, first wins", () => {
    const first = makeProgramWire({ id: "dup-1", fromName: "Alice" });
    const second = makeProgramWire({ id: "dup-1", fromName: "Bob" });
    appendProgramLog("room-1", first);
    appendProgramLog("room-1", second);
    const loaded = loadProgramLog("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].fromName).toBe("Alice");
  });

  it("keeps at most 100 entries, dropping the oldest when a 101st is appended", () => {
    for (let i = 0; i < 101; i++) {
      appendProgramLog("room-1", makeProgramWire({ id: `program-${i}` }));
    }
    const loaded = loadProgramLog("room-1");
    expect(loaded).toHaveLength(100);
    expect(loaded.some((w) => w.id === "program-0")).toBe(false);
    expect(loaded.some((w) => w.id === "program-1")).toBe(true);
    expect(loaded.some((w) => w.id === "program-100")).toBe(true);
  });

  it("returns an empty array when localStorage holds malformed JSON", () => {
    localStorage.setItem("tc-news:programlog:room-1", "{not valid json");
    expect(loadProgramLog("room-1")).toEqual([]);
  });

  it("returns an empty array when the stored JSON is not an array", () => {
    localStorage.setItem("tc-news:programlog:room-1", JSON.stringify({ not: "an array" }));
    expect(loadProgramLog("room-1")).toEqual([]);
  });

  it("filters out non-wire garbage elements while keeping valid wires", () => {
    const valid = makeProgramWire({ id: "valid-1" });
    const garbage: unknown[] = [
      null,
      { type: "tc-news:article", id: "wrong-type" }, // wrong type
      { type: "tc-news:program", id: "missing-fields" }, // missing required fields
      valid,
    ];
    localStorage.setItem("tc-news:programlog:room-1", JSON.stringify(garbage));
    const loaded = loadProgramLog("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(valid);
  });

  it("keeps logs independent across different roomIds", () => {
    appendProgramLog("room-a", makeProgramWire({ id: "a-1" }));
    appendProgramLog("room-b", makeProgramWire({ id: "b-1" }));
    expect(loadProgramLog("room-a").map((w) => w.id)).toEqual(["a-1"]);
    expect(loadProgramLog("room-b").map((w) => w.id)).toEqual(["b-1"]);
  });
});

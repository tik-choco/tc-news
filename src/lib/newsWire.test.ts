import { beforeEach, describe, expect, it } from "vitest";
import {
  appendFeedShareLog,
  appendProgramLog,
  appendProgramTranslationLog,
  cleanupOrphanedRoomKeys,
  isFeedShareWire,
  isProgramTranslationWire,
  loadFeedShareLog,
  loadProgramLog,
  loadProgramTranslationLog,
  loadSharedArticles,
  loadSharedPrograms,
  sanitizeProgramTranslationContent,
  sanitizeSharedProgram,
  saveSharedArticles,
  saveSharedPrograms,
} from "./newsWire";
import type { FeedShareWire, ProgramTranslationWire, ProgramWire } from "./newsWire";
import type { NewsArticle, RadioProgram } from "../types";
import { resetKvStoreForTests } from "./kvStore";

function article(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: "article-1",
    title: "Title",
    excerpt: "",
    body: "Body",
    tags: [],
    sourceLinks: [],
    authorDid: "did:key:alice",
    authorName: "Alice",
    createdAt: Date.now(),
    ...overrides,
  };
}

function program(overrides: Partial<RadioProgram> = {}): RadioProgram {
  return {
    id: "program-1",
    title: "Morning Briefing",
    segments: [{ text: "seg one" }],
    createdAt: Date.now(),
    ...overrides,
  };
}

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

describe("loadSharedArticles / saveSharedArticles (per-room mist KV cache)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetKvStoreForTests();
  });

  it("round-trips articles through save then load", async () => {
    saveSharedArticles("room-1", [article()]);
    const loaded = await loadSharedArticles("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("article-1");
  });

  it("returns an empty array when nothing is stored", async () => {
    expect(await loadSharedArticles("room-none")).toEqual([]);
  });

  it("reads a legacy localStorage copy (pre-migration dual-read) when the backend isn't up yet", async () => {
    localStorage.setItem("tc-news:shared:room-legacy", JSON.stringify([article({ id: "legacy-1" })]));
    const loaded = await loadSharedArticles("room-legacy");
    expect(loaded.map((a) => a.id)).toEqual(["legacy-1"]);
  });

  it("keeps caches independent across different roomIds", async () => {
    saveSharedArticles("room-a", [article({ id: "a-1" })]);
    saveSharedArticles("room-b", [article({ id: "b-1" })]);
    expect((await loadSharedArticles("room-a")).map((a) => a.id)).toEqual(["a-1"]);
    expect((await loadSharedArticles("room-b")).map((a) => a.id)).toEqual(["b-1"]);
  });

  it("caps at 200 (MAX_SHARED_ARTICLES), newest createdAt first", async () => {
    const many = Array.from({ length: 210 }, (_, i) => article({ id: `a-${i}`, createdAt: i }));
    saveSharedArticles("room-cap", many);
    const loaded = await loadSharedArticles("room-cap");
    expect(loaded).toHaveLength(200);
    expect(loaded[0].id).toBe("a-209");
    expect(loaded.some((a) => a.id === "a-0")).toBe(false);
  });
});

describe("loadSharedPrograms / saveSharedPrograms (per-room mist KV cache)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetKvStoreForTests();
  });

  it("round-trips programs through save then load", async () => {
    saveSharedPrograms("room-1", [program()]);
    const loaded = await loadSharedPrograms("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("program-1");
  });

  it("returns an empty array when nothing is stored", async () => {
    expect(await loadSharedPrograms("room-none")).toEqual([]);
  });
});

describe("cleanupOrphanedRoomKeys", () => {
  beforeEach(() => {
    localStorage.clear();
    resetKvStoreForTests();
  });

  it("removes shared:/shared-programs: keys for rooms not in the active set", () => {
    localStorage.setItem("tc-news:shared:room-old", "[]");
    localStorage.setItem("tc-news:shared-programs:room-old", "[]");
    localStorage.setItem("tc-news:shared:room-active", "[]");
    cleanupOrphanedRoomKeys(["room-active"]);
    expect(localStorage.getItem("tc-news:shared:room-old")).toBeNull();
    expect(localStorage.getItem("tc-news:shared-programs:room-old")).toBeNull();
    expect(localStorage.getItem("tc-news:shared:room-active")).toBe("[]");
  });

  it("leaves unrelated keys (other prefixes, other apps) untouched", () => {
    localStorage.setItem("tc-news:wirelog:room-old", "[]");
    localStorage.setItem("tc-news:app-settings", "{}");
    cleanupOrphanedRoomKeys([]);
    expect(localStorage.getItem("tc-news:wirelog:room-old")).toBe("[]");
    expect(localStorage.getItem("tc-news:app-settings")).toBe("{}");
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

function makeFeedShareWire(overrides: Partial<FeedShareWire> = {}): FeedShareWire {
  return {
    type: "tc-news:feed-share",
    id: "feed-share-1",
    url: "https://example.com/feed.xml",
    label: "Example Feed",
    fromId: "did:key:alice",
    fromName: "Alice",
    timestamp: Date.now(),
    signature: "sig-1",
    ...overrides,
  };
}

describe("isFeedShareWire", () => {
  it("accepts a well-formed wire", () => {
    expect(isFeedShareWire(makeFeedShareWire())).toBe(true);
  });

  it("accepts a wire without fromApp (optional field)", () => {
    const wire = makeFeedShareWire();
    delete (wire as Record<string, unknown>).fromApp;
    expect(isFeedShareWire(wire)).toBe(true);
  });

  it("accepts a wire with a string fromApp", () => {
    expect(isFeedShareWire(makeFeedShareWire({ fromApp: "tc-news" }))).toBe(true);
  });

  it("rejects a wire with the wrong type discriminant", () => {
    expect(isFeedShareWire({ ...makeFeedShareWire(), type: "tc-news:program" })).toBe(false);
  });

  it("rejects a wire missing url", () => {
    const wire = makeFeedShareWire() as Record<string, unknown>;
    delete wire.url;
    expect(isFeedShareWire(wire)).toBe(false);
  });

  it("rejects a wire missing label", () => {
    const wire = makeFeedShareWire() as Record<string, unknown>;
    delete wire.label;
    expect(isFeedShareWire(wire)).toBe(false);
  });

  it("rejects a wire with a non-string fromApp", () => {
    expect(isFeedShareWire({ ...makeFeedShareWire(), fromApp: 42 })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isFeedShareWire(null)).toBe(false);
    expect(isFeedShareWire("not-an-object")).toBe(false);
  });
});

describe("loadFeedShareLog / appendFeedShareLog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty array when the key is unset", () => {
    expect(loadFeedShareLog("room-1")).toEqual([]);
  });

  it("round-trips a wire through append then load, preserving all fields", () => {
    const wire = makeFeedShareWire({ fromApp: "tc-news" });
    appendFeedShareLog("room-1", wire);
    expect(loadFeedShareLog("room-1")).toEqual([wire]);
  });

  it("dedupes by wire.id: a later append with the same id is dropped, first wins", () => {
    const first = makeFeedShareWire({ id: "dup-1", label: "First label" });
    const second = makeFeedShareWire({ id: "dup-1", label: "Second label" });
    appendFeedShareLog("room-1", first);
    appendFeedShareLog("room-1", second);
    const loaded = loadFeedShareLog("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].label).toBe("First label");
  });

  it("keeps at most 200 entries, dropping the oldest when a 201st is appended", () => {
    for (let i = 0; i < 201; i++) {
      appendFeedShareLog("room-1", makeFeedShareWire({ id: `feed-share-${i}` }));
    }
    const loaded = loadFeedShareLog("room-1");
    expect(loaded).toHaveLength(200);
    expect(loaded.some((w) => w.id === "feed-share-0")).toBe(false);
    expect(loaded.some((w) => w.id === "feed-share-1")).toBe(true);
    expect(loaded.some((w) => w.id === "feed-share-200")).toBe(true);
  });

  it("returns an empty array when localStorage holds malformed JSON", () => {
    localStorage.setItem("tc-news:feedlog:room-1", "{not valid json");
    expect(loadFeedShareLog("room-1")).toEqual([]);
  });

  it("returns an empty array when the stored JSON is not an array", () => {
    localStorage.setItem("tc-news:feedlog:room-1", JSON.stringify({ not: "an array" }));
    expect(loadFeedShareLog("room-1")).toEqual([]);
  });

  it("filters out non-wire garbage elements while keeping valid wires", () => {
    const valid = makeFeedShareWire({ id: "valid-1" });
    const garbage: unknown[] = [
      null,
      { type: "tc-news:program", id: "wrong-type" }, // wrong type
      { type: "tc-news:feed-share", id: "missing-fields" }, // missing required fields
      valid,
    ];
    localStorage.setItem("tc-news:feedlog:room-1", JSON.stringify(garbage));
    const loaded = loadFeedShareLog("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(valid);
  });

  it("keeps logs independent across different roomIds", () => {
    appendFeedShareLog("room-a", makeFeedShareWire({ id: "a-1" }));
    appendFeedShareLog("room-b", makeFeedShareWire({ id: "b-1" }));
    expect(loadFeedShareLog("room-a").map((w) => w.id)).toEqual(["a-1"]);
    expect(loadFeedShareLog("room-b").map((w) => w.id)).toEqual(["b-1"]);
  });
});

function makeProgramTranslationWire(overrides: Partial<ProgramTranslationWire> = {}): ProgramTranslationWire {
  return {
    type: "tc-news:program-translation",
    id: "program-translation-1",
    programId: "program-1",
    lang: "en",
    fromId: "did:key:alice",
    fromName: "Alice",
    timestamp: Date.now(),
    cid: "cid-1",
    signature: "sig-1",
    ...overrides,
  };
}

describe("isProgramTranslationWire", () => {
  it("accepts a well-formed wire", () => {
    expect(isProgramTranslationWire(makeProgramTranslationWire())).toBe(true);
  });

  it("accepts a wire without fromApp (optional field)", () => {
    const wire = makeProgramTranslationWire() as Record<string, unknown>;
    delete wire.fromApp;
    expect(isProgramTranslationWire(wire)).toBe(true);
  });

  it("accepts a wire with a string fromApp", () => {
    expect(isProgramTranslationWire(makeProgramTranslationWire({ fromApp: "tc-news" }))).toBe(true);
  });

  it("rejects a wire with the wrong type discriminant", () => {
    expect(isProgramTranslationWire({ ...makeProgramTranslationWire(), type: "tc-news:translation" })).toBe(false);
  });

  it("rejects a wire missing/non-string programId", () => {
    const wire = makeProgramTranslationWire() as Record<string, unknown>;
    delete wire.programId;
    expect(isProgramTranslationWire(wire)).toBe(false);
    expect(isProgramTranslationWire({ ...makeProgramTranslationWire(), programId: 42 })).toBe(false);
  });

  it("rejects a wire missing/non-string lang", () => {
    const wire = makeProgramTranslationWire() as Record<string, unknown>;
    delete wire.lang;
    expect(isProgramTranslationWire(wire)).toBe(false);
    expect(isProgramTranslationWire({ ...makeProgramTranslationWire(), lang: 42 })).toBe(false);
  });

  it("rejects a wire missing/non-string cid", () => {
    const wire = makeProgramTranslationWire() as Record<string, unknown>;
    delete wire.cid;
    expect(isProgramTranslationWire(wire)).toBe(false);
    expect(isProgramTranslationWire({ ...makeProgramTranslationWire(), cid: 42 })).toBe(false);
  });

  it("rejects a wire missing/non-string fromId", () => {
    const wire = makeProgramTranslationWire() as Record<string, unknown>;
    delete wire.fromId;
    expect(isProgramTranslationWire(wire)).toBe(false);
    expect(isProgramTranslationWire({ ...makeProgramTranslationWire(), fromId: 42 })).toBe(false);
  });

  it("rejects a wire missing/non-string signature", () => {
    const wire = makeProgramTranslationWire() as Record<string, unknown>;
    delete wire.signature;
    expect(isProgramTranslationWire(wire)).toBe(false);
    expect(isProgramTranslationWire({ ...makeProgramTranslationWire(), signature: 42 })).toBe(false);
  });

  it("rejects a wire with a non-number timestamp", () => {
    expect(isProgramTranslationWire({ ...makeProgramTranslationWire(), timestamp: "not-a-number" })).toBe(false);
  });

  it("rejects a wire with a non-string fromApp", () => {
    expect(isProgramTranslationWire({ ...makeProgramTranslationWire(), fromApp: 42 })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isProgramTranslationWire(null)).toBe(false);
    expect(isProgramTranslationWire("not-an-object")).toBe(false);
  });
});

function baseWireProgramTranslation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    programId: "program-1",
    lang: "en",
    title: "Morning Briefing (EN)",
    segmentTexts: ["seg one", "seg two"],
    ...overrides,
  };
}

describe("sanitizeProgramTranslationContent", () => {
  it("passes valid text-only content through unchanged (no audio fields)", () => {
    const content = sanitizeProgramTranslationContent(baseWireProgramTranslation());
    expect(content).not.toBeNull();
    expect(content).toEqual({
      programId: "program-1",
      lang: "en",
      title: "Morning Briefing (EN)",
      segmentTexts: ["seg one", "seg two"],
    });
  });

  it("adopts audioCids and defaults audioMime when audioCids fully matches segmentTexts", () => {
    const content = sanitizeProgramTranslationContent(
      baseWireProgramTranslation({ audioCids: ["cid-1", "cid-2"] }),
    );
    expect(content).not.toBeNull();
    expect(content?.audioCids).toEqual(["cid-1", "cid-2"]);
    expect(content?.audioMime).toBe("audio/mpeg"); // 既定値
    expect(content?.audioVoice).toBeUndefined();
  });

  it("keeps an explicit audioMime and audioVoice when present", () => {
    const content = sanitizeProgramTranslationContent(
      baseWireProgramTranslation({
        audioCids: ["cid-1", "cid-2"],
        audioMime: "audio/wav",
        audioVoice: "alloy",
      }),
    );
    expect(content).not.toBeNull();
    expect(content?.audioMime).toBe("audio/wav");
    expect(content?.audioVoice).toBe("alloy");
  });

  it("drops audio fields when audioCids length mismatches segmentTexts", () => {
    const content = sanitizeProgramTranslationContent(
      baseWireProgramTranslation({
        audioCids: ["cid-1"], // segmentTextsは2件
        audioVoice: "alloy",
      }),
    );
    expect(content).not.toBeNull();
    expect(content?.segmentTexts).toEqual(["seg one", "seg two"]);
    expect(content?.audioCids).toBeUndefined();
    expect(content?.audioMime).toBeUndefined();
    expect(content?.audioVoice).toBeUndefined();
  });

  it("drops audio fields when audioCids contains an empty-string entry", () => {
    const content = sanitizeProgramTranslationContent(
      baseWireProgramTranslation({ audioCids: ["cid-1", ""] }),
    );
    expect(content).not.toBeNull();
    expect(content?.audioCids).toBeUndefined();
  });

  it("drops audio fields when audioCids contains a non-string entry", () => {
    const content = sanitizeProgramTranslationContent(
      baseWireProgramTranslation({ audioCids: ["cid-1", 42] }),
    );
    expect(content).not.toBeNull();
    expect(content?.audioCids).toBeUndefined();
  });

  it("drops audio fields when segmentTexts was thinned out by sanitization, even if audioCids matches the thinned length", () => {
    // 生のsegmentTextsは3件だが数値混入で2件に間引かれる。audioCidsを間引き後の
    // 長さ(2)に合わせても、間引き前後の長さが一致しない(segmentTextsIntact=false)
    // ためaudioフィールドごと破棄される(sanitizeSharedProgramと同じ方針)。
    const content = sanitizeProgramTranslationContent(
      baseWireProgramTranslation({
        segmentTexts: ["seg one", 42, "seg two"],
        audioCids: ["cid-1", "cid-2"],
      }),
    );
    expect(content).not.toBeNull();
    expect(content?.segmentTexts).toEqual(["seg one", "seg two"]);
    expect(content?.audioCids).toBeUndefined();
    expect(content?.audioMime).toBeUndefined();
  });

  it("returns null for non-object values", () => {
    expect(sanitizeProgramTranslationContent(null)).toBeNull();
    expect(sanitizeProgramTranslationContent("not-an-object")).toBeNull();
    expect(sanitizeProgramTranslationContent(42)).toBeNull();
  });

  it("returns null when programId is missing or empty", () => {
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ programId: undefined }))).toBeNull();
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ programId: "" }))).toBeNull();
  });

  it("returns null when lang is missing or empty", () => {
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ lang: undefined }))).toBeNull();
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ lang: "" }))).toBeNull();
  });

  it("returns null when title is not a string", () => {
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ title: 42 }))).toBeNull();
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ title: undefined }))).toBeNull();
  });

  it("accepts an empty-string title (only non-string is rejected)", () => {
    const content = sanitizeProgramTranslationContent(baseWireProgramTranslation({ title: "" }));
    expect(content).not.toBeNull();
    expect(content?.title).toBe("");
  });

  it("returns null when segmentTexts is not an array", () => {
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ segmentTexts: "not-an-array" }))).toBeNull();
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ segmentTexts: undefined }))).toBeNull();
  });

  it("returns null when segmentTexts is an empty array", () => {
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ segmentTexts: [] }))).toBeNull();
  });

  it("returns null when segmentTexts contains only non-string entries", () => {
    expect(sanitizeProgramTranslationContent(baseWireProgramTranslation({ segmentTexts: [1, 2, 3] }))).toBeNull();
  });

  it("filters out (rather than rejects) non-string entries mixed with valid strings", () => {
    // 実装はフィルタ後に0件なら初めてnullを返す方針(sanitizeSharedProgramの
    // segments間引きと同じ)。混在の場合は文字列だけが残り、nullにはならない。
    const content = sanitizeProgramTranslationContent(
      baseWireProgramTranslation({ segmentTexts: ["seg one", 42, "seg two"] }),
    );
    expect(content).not.toBeNull();
    expect(content?.segmentTexts).toEqual(["seg one", "seg two"]);
  });

  it("keeps only known fields, dropping unrecognized properties on the input", () => {
    const content = sanitizeProgramTranslationContent(
      baseWireProgramTranslation({ junk: "should not survive", audioCids: ["cid-1", "cid-2"] }),
    );
    expect(content).not.toBeNull();
    expect(Object.keys(content as object).sort()).toEqual(
      ["audioCids", "audioMime", "lang", "programId", "segmentTexts", "title"].sort(),
    );
  });
});

describe("loadProgramTranslationLog / appendProgramTranslationLog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty array when the key is unset", () => {
    expect(loadProgramTranslationLog("room-1")).toEqual([]);
  });

  it("round-trips a wire through append then load, preserving all fields", () => {
    const wire = makeProgramTranslationWire({ fromApp: "tc-news" });
    appendProgramTranslationLog("room-1", wire);
    expect(loadProgramTranslationLog("room-1")).toEqual([wire]);
  });

  it("round-trips a wire without fromApp", () => {
    const wire = makeProgramTranslationWire() as Record<string, unknown>;
    delete wire.fromApp;
    appendProgramTranslationLog("room-1", wire as unknown as ProgramTranslationWire);
    const loaded = loadProgramTranslationLog("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(wire);
    expect(loaded[0].fromApp).toBeUndefined();
  });

  it("dedupes by wire.id: a later append with the same id is dropped, first wins", () => {
    const first = makeProgramTranslationWire({ id: "dup-1", fromName: "Alice" });
    const second = makeProgramTranslationWire({ id: "dup-1", fromName: "Bob" });
    appendProgramTranslationLog("room-1", first);
    appendProgramTranslationLog("room-1", second);
    const loaded = loadProgramTranslationLog("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].fromName).toBe("Alice");
  });

  it("keeps at most 100 entries (MAX_PROGRAM_TRANSLATION_LOG), dropping the oldest when a 101st is appended", () => {
    for (let i = 0; i < 101; i++) {
      appendProgramTranslationLog("room-1", makeProgramTranslationWire({ id: `program-translation-${i}` }));
    }
    const loaded = loadProgramTranslationLog("room-1");
    expect(loaded).toHaveLength(100);
    expect(loaded.some((w) => w.id === "program-translation-0")).toBe(false);
    expect(loaded.some((w) => w.id === "program-translation-1")).toBe(true);
    expect(loaded.some((w) => w.id === "program-translation-100")).toBe(true);
  });

  it("returns an empty array when localStorage holds malformed JSON", () => {
    localStorage.setItem("tc-news:programtranslationlog:room-1", "{not valid json");
    expect(loadProgramTranslationLog("room-1")).toEqual([]);
  });

  it("returns an empty array when the stored JSON is not an array", () => {
    localStorage.setItem("tc-news:programtranslationlog:room-1", JSON.stringify({ not: "an array" }));
    expect(loadProgramTranslationLog("room-1")).toEqual([]);
  });

  it("filters out non-wire garbage elements while keeping valid wires", () => {
    const valid = makeProgramTranslationWire({ id: "valid-1" });
    const garbage: unknown[] = [
      null,
      { type: "tc-news:program", id: "wrong-type" }, // wrong type
      { type: "tc-news:program-translation", id: "missing-fields" }, // missing required fields
      valid,
    ];
    localStorage.setItem("tc-news:programtranslationlog:room-1", JSON.stringify(garbage));
    const loaded = loadProgramTranslationLog("room-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(valid);
  });

  it("keeps logs independent across different roomIds", () => {
    appendProgramTranslationLog("room-a", makeProgramTranslationWire({ id: "a-1" }));
    appendProgramTranslationLog("room-b", makeProgramTranslationWire({ id: "b-1" }));
    expect(loadProgramTranslationLog("room-a").map((w) => w.id)).toEqual(["a-1"]);
    expect(loadProgramTranslationLog("room-b").map((w) => w.id)).toEqual(["b-1"]);
  });
});

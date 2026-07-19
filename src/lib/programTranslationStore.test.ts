import { beforeEach, describe, expect, it } from "vitest";
import { getProgramTranslation, saveProgramTranslation, type ProgramTranslation } from "./programTranslationStore";
import { kvSetSync, resetKvStoreForTests } from "./kvStore";

// Same raw KV key as programTranslationStore.ts's PROGRAM_TRANSLATIONS_KEY —
// not exported, so tests that need to inject corrupted/raw data hardcode it
// here (same idiom as kvStore.test.ts hardcoding "tc-news:articles").
const KV_KEY = "tc-news:program-translations";

beforeEach(() => {
  // programTranslationStore persists through kvStore, which in fallback mode
  // (no initKvStore() call here) behaves like localStorage plus an in-memory
  // mirror — both need clearing between tests, same pattern as
  // translate.test.ts / feedTranslate.test.ts.
  localStorage.clear();
  resetKvStoreForTests();
});

function makeTranslation(overrides: Partial<ProgramTranslation> = {}): ProgramTranslation {
  return {
    programId: "program-1",
    lang: "en",
    title: "Translated Title",
    segmentTexts: ["Segment one.", "Segment two."],
    translatedAt: 1000,
    ...overrides,
  };
}

describe("getProgramTranslation / saveProgramTranslation — basic roundtrip", () => {
  it("returns null for a programId×lang pair that was never saved", () => {
    expect(getProgramTranslation("nope", "en")).toBeNull();
  });

  it("round-trips a record with no audio fields (legacy shape)", () => {
    const record = makeTranslation();
    saveProgramTranslation(record);

    const result = getProgramTranslation("program-1", "en");
    expect(result).toEqual(record);
    expect(result?.audioCids).toBeUndefined();
    expect(result?.audioMime).toBeUndefined();
    expect(result?.audioVoice).toBeUndefined();
  });

  it("round-trips a record with audio fields", () => {
    const record = makeTranslation({
      audioCids: ["cid-1", "cid-2"],
      audioMime: "audio/mpeg",
      audioVoice: "alloy",
    });
    saveProgramTranslation(record);

    const result = getProgramTranslation("program-1", "en");
    expect(result).toEqual(record);
  });

  it("supports the translate-then-render-audio flow: a later save adds audioCids to an existing text-only record", () => {
    const textOnly = makeTranslation();
    saveProgramTranslation(textOnly);
    expect(getProgramTranslation("program-1", "en")?.audioCids).toBeUndefined();

    const withAudio: ProgramTranslation = {
      ...textOnly,
      audioCids: ["cid-a", "cid-b"],
      audioMime: "audio/mpeg",
      audioVoice: "verse",
    };
    saveProgramTranslation(withAudio);

    const result = getProgramTranslation("program-1", "en");
    expect(result?.audioCids).toEqual(["cid-a", "cid-b"]);
    expect(result?.audioMime).toBe("audio/mpeg");
    expect(result?.audioVoice).toBe("verse");
    expect(result?.title).toBe(textOnly.title);
    expect(result?.segmentTexts).toEqual(textOnly.segmentTexts);
  });

  it("keeps translations for the same programId under different langs as separate records", () => {
    const en = makeTranslation({ lang: "en", title: "English Title" });
    const fr = makeTranslation({ lang: "fr", title: "Titre Français" });
    saveProgramTranslation(en);
    saveProgramTranslation(fr);

    expect(getProgramTranslation("program-1", "en")?.title).toBe("English Title");
    expect(getProgramTranslation("program-1", "fr")?.title).toBe("Titre Français");
    // Overwriting one lang must not disturb the other.
    saveProgramTranslation(makeTranslation({ lang: "en", title: "Updated English Title" }));
    expect(getProgramTranslation("program-1", "en")?.title).toBe("Updated English Title");
    expect(getProgramTranslation("program-1", "fr")?.title).toBe("Titre Français");
  });
});

describe("defensive parsing of corrupted KV data", () => {
  it("returns null and doesn't throw when the stored value isn't valid JSON", () => {
    kvSetSync(KV_KEY, "{not valid json");
    expect(() => getProgramTranslation("program-1", "en")).not.toThrow();
    expect(getProgramTranslation("program-1", "en")).toBeNull();
  });

  it("returns null and doesn't throw when the stored value is a JSON array instead of an object", () => {
    kvSetSync(KV_KEY, JSON.stringify(["not", "a", "map"]));
    expect(getProgramTranslation("program-1", "en")).toBeNull();
  });

  it("drops only the malformed entries, keeping valid sibling records intact", () => {
    const good = makeTranslation({ programId: "good", lang: "en" });
    const raw = {
      "good::en": good,
      // audioCids has the wrong type (string instead of string[]).
      "bad-audio::en": {
        programId: "bad-audio",
        lang: "en",
        title: "Bad Audio",
        segmentTexts: ["a"],
        translatedAt: 500,
        audioCids: "cid-not-an-array",
      },
      // segmentTexts has a non-string element mixed in.
      "bad-segments::en": {
        programId: "bad-segments",
        lang: "en",
        title: "Bad Segments",
        segmentTexts: ["a", 42, "c"],
        translatedAt: 500,
      },
      // Missing required fields entirely.
      "bad-shape::en": { foo: "bar" },
    };
    kvSetSync(KV_KEY, JSON.stringify(raw));

    expect(getProgramTranslation("good", "en")).toEqual(good);
    expect(getProgramTranslation("bad-audio", "en")).toBeNull();
    expect(getProgramTranslation("bad-segments", "en")).toBeNull();
    expect(getProgramTranslation("bad-shape", "en")).toBeNull();
  });
});

describe("MAX_PROGRAM_TRANSLATIONS cap (20 entries)", () => {
  it("evicts the oldest (by translatedAt) entry once the 21st distinct record is saved", () => {
    for (let i = 1; i <= 21; i++) {
      saveProgramTranslation(makeTranslation({ programId: `p${i}`, lang: "en", translatedAt: i }));
    }

    // p1 has the smallest translatedAt (oldest) — evicted to stay at 20.
    expect(getProgramTranslation("p1", "en")).toBeNull();
    for (let i = 2; i <= 21; i++) {
      expect(getProgramTranslation(`p${i}`, "en")).not.toBeNull();
    }
  });
});

describe("byte-size soft limit trim (KV_VALUE_SOFT_LIMIT_BYTES)", () => {
  it("trims the oldest (by translatedAt) entry when the serialized blob exceeds the soft limit", () => {
    // Each record's segmentTexts payload is ~700,000 bytes (ASCII, so char
    // count == byte count) — one record alone fits comfortably under the
    // 900,000-byte soft limit, but two together (~1.4MB) don't.
    const older = makeTranslation({
      programId: "big-old",
      lang: "en",
      translatedAt: 1000,
      segmentTexts: ["x".repeat(700_000)],
    });
    const newer = makeTranslation({
      programId: "big-new",
      lang: "en",
      translatedAt: 2000,
      segmentTexts: ["y".repeat(700_000)],
    });

    saveProgramTranslation(older);
    expect(getProgramTranslation("big-old", "en")).not.toBeNull();

    saveProgramTranslation(newer);

    // The combined blob exceeded the soft limit, so persistAll trimmed the
    // older-by-translatedAt entry to bring it back under the limit; the
    // newer one survives.
    expect(getProgramTranslation("big-old", "en")).toBeNull();
    expect(getProgramTranslation("big-new", "en")).not.toBeNull();
  });
});

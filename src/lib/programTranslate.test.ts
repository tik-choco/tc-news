// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { translateProgram, type ProgramTranslationProgressUpdate } from "./programTranslate";
import type { RadioProgram } from "../types";

// requestChatCompletion is the only real network-ish dependency; mock it so
// tests are deterministic and assert call ordering/count (sequential segment
// translation, per programTranslate.ts's module header) — same idiom as
// translate.test.ts / feedTranslate.test.ts.
const requestChatCompletion = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock("./llm", () => ({
  requestChatCompletion: (...args: unknown[]) => requestChatCompletion(...args),
}));

beforeEach(() => {
  requestChatCompletion.mockReset();
});

function makeProgram(overrides: Partial<RadioProgram> = {}): RadioProgram {
  return {
    id: "program-1",
    title: "Original Title",
    segments: [
      { text: "First line." },
      { text: "Second line." },
      { text: "Third line.", ruby: "{漢字|かんじ}のテスト" },
    ],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("translateProgram", () => {
  it("translates the title via a JSON call, then each segment sequentially as plain text", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "Translated Title" }))
      .mockResolvedValueOnce("Translated first.")
      .mockResolvedValueOnce("Translated second.")
      .mockResolvedValueOnce("Translated third.");

    const result = await translateProgram(makeProgram(), { profileId: "", targetLanguage: "English" });

    expect(result).toEqual({
      title: "Translated Title",
      segmentTexts: ["Translated first.", "Translated second.", "Translated third."],
    });
    expect(requestChatCompletion).toHaveBeenCalledTimes(4);
  });

  it("tolerates JSON wrapped in prose/code fences for the title call (extractJson leniency)", async () => {
    requestChatCompletion
      .mockResolvedValueOnce('Here you go:\n```json\n{"title":"T2"}\n```')
      .mockResolvedValueOnce("A.")
      .mockResolvedValueOnce("B.")
      .mockResolvedValueOnce("C.");

    const result = await translateProgram(makeProgram(), { profileId: "p1", targetLanguage: "French" });

    expect(result.title).toBe("T2");
  });

  it("degrades gracefully on malformed title JSON: keeps original title, still translates segments", async () => {
    requestChatCompletion
      .mockResolvedValueOnce("sorry, I cannot help with that")
      .mockResolvedValueOnce("A.")
      .mockResolvedValueOnce("B.")
      .mockResolvedValueOnce("C.");

    const program = makeProgram({ title: "Kept Title" });
    const result = await translateProgram(program, { profileId: "", targetLanguage: "English" });

    expect(result.title).toBe("Kept Title");
    expect(result.segmentTexts).toEqual(["A.", "B.", "C."]);
  });

  it("strips a markdown code fence from a translated segment", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T" }))
      .mockResolvedValueOnce("```\nTranslated first.\n```")
      .mockResolvedValueOnce("Translated second.")
      .mockResolvedValueOnce("Translated third.");

    const result = await translateProgram(makeProgram(), { profileId: "", targetLanguage: "French" });

    expect(result.segmentTexts[0]).toBe("Translated first.");
  });

  it("does not translate ruby: only segment.text is sent to the LLM (ruby markers never appear in a request)", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T" }))
      .mockResolvedValueOnce("A.")
      .mockResolvedValueOnce("B.")
      .mockResolvedValueOnce("C.");

    await translateProgram(makeProgram(), { profileId: "", targetLanguage: "English" });

    // Call 4 (index 3) is the third segment's translation — its user message
    // must be the plain text, never the ruby-marker string.
    const thirdSegmentCall = requestChatCompletion.mock.calls[3];
    const messages = thirdSegmentCall[1] as { role: string; content: string }[];
    expect(messages.find((m) => m.role === "user")?.content).toBe("Third line.");
  });

  it("handles a program with zero segments: only the title call happens", async () => {
    requestChatCompletion.mockResolvedValueOnce(JSON.stringify({ title: "T" }));

    const result = await translateProgram(makeProgram({ segments: [] }), {
      profileId: "",
      targetLanguage: "English",
    });

    expect(result).toEqual({ title: "T", segmentTexts: [] });
    expect(requestChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("wraps a requestChatCompletion failure (title call) as a localized translateFailed error", async () => {
    requestChatCompletion.mockRejectedValueOnce(new Error("boom"));

    await expect(
      translateProgram(makeProgram(), { profileId: "", targetLanguage: "English" }),
    ).rejects.toThrow(/boom/);
  });

  it("wraps a segment-translation failure the same way", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T" }))
      .mockRejectedValueOnce(new Error("segment failed"));

    await expect(
      translateProgram(makeProgram(), { profileId: "", targetLanguage: "English" }),
    ).rejects.toThrow(/segment failed/);
  });

  it("rejects with AbortError and never calls requestChatCompletion when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      translateProgram(makeProgram(), { profileId: "", targetLanguage: "English", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(requestChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects with AbortError and stops issuing further segment calls when aborted mid-translation", async () => {
    const controller = new AbortController();

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T" }))
      .mockImplementationOnce(async () => {
        // Simulate the caller cancelling once the first segment call resolves.
        controller.abort();
        return "Translated first.";
      });

    await expect(
      translateProgram(makeProgram(), {
        profileId: "",
        targetLanguage: "English",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // title call + first segment call only — the remaining two segment calls
    // must never happen once the signal is observed as aborted.
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not wrap the AbortError in the localized translateFailed message", async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await translateProgram(makeProgram(), { profileId: "", targetLanguage: "English", signal: controller.signal });
      expect.unreachable("expected translateProgram to reject");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
      expect((err as Error).message).toBe("Request cancelled.");
      expect((err as Error).message).not.toMatch(/translateFailed|errors\./);
    }
  });
});

describe("translateProgram — streaming progress (onProgress)", () => {
  it("emits onProgress after the title step and after every completed segment, in order", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T" }))
      .mockResolvedValueOnce("A.")
      .mockResolvedValueOnce("B.")
      .mockResolvedValueOnce("C.");

    const updates: ProgramTranslationProgressUpdate[] = [];
    const result = await translateProgram(makeProgram(), {
      profileId: "",
      targetLanguage: "English",
      onProgress: (p) => updates.push(p),
    });

    // Post-title emit (title known, no segments yet), then one emit per
    // completed segment (3) => 4 total.
    expect(updates).toHaveLength(4);
    expect(updates[0]).toEqual({ title: "T", segmentTexts: [], doneSegments: 0, totalSegments: 3 });
    expect(updates[1]).toMatchObject({ doneSegments: 1, totalSegments: 3, segmentTexts: ["A."] });
    expect(updates[2]).toMatchObject({ doneSegments: 2, totalSegments: 3, segmentTexts: ["A.", "B."] });
    expect(updates[3]).toMatchObject({ doneSegments: 3, totalSegments: 3, segmentTexts: ["A.", "B.", "C."] });
    expect(updates[updates.length - 1].segmentTexts).toEqual(result.segmentTexts);
  });

  it("emits a single doneSegments:0 update when there are no segments", async () => {
    requestChatCompletion.mockResolvedValueOnce(JSON.stringify({ title: "T" }));

    const updates: ProgramTranslationProgressUpdate[] = [];
    await translateProgram(makeProgram({ segments: [] }), {
      profileId: "",
      targetLanguage: "English",
      onProgress: (p) => updates.push(p),
    });

    expect(updates).toEqual([{ title: "T", segmentTexts: [], doneSegments: 0, totalSegments: 0 }]);
  });
});

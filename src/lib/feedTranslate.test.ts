// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { splitHtmlIntoChunks, translateFeedContent, type FeedTranslationProgressUpdate } from "./feedTranslate";
import { getPartialFeedTranslation } from "./partialFeedTranslationStore";
import { resetKvStoreForTests } from "./kvStore";

// requestChatCompletion is the only real network-ish dependency; mock it so
// tests are deterministic and assert call ordering/count (sequential chunk
// translation, per the module header).
const requestChatCompletion = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock("./llm", () => ({
  requestChatCompletion: (...args: unknown[]) => requestChatCompletion(...args),
}));

// DOMPurify.sanitize() is unreliable under happy-dom (see pageExtract.ts's
// module header) — mock it to identity so assertions here are about
// feedTranslate's own logic, not sanitizer quirks.
vi.mock("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

beforeEach(() => {
  requestChatCompletion.mockReset();
  // partialFeedTranslationStore persists through kvStore, which in fallback
  // mode (no initKvStore() call here) behaves like localStorage plus an
  // in-memory mirror — both need clearing between tests, same pattern as
  // reactionStore.test.ts.
  localStorage.clear();
  resetKvStoreForTests();
});

describe("splitHtmlIntoChunks", () => {
  it("returns an empty array for empty html", () => {
    expect(splitHtmlIntoChunks("", 100)).toEqual([]);
  });

  it("returns a single chunk for one small element", () => {
    const html = "<p>Hello world</p>";
    expect(splitHtmlIntoChunks(html, 1000)).toEqual([html]);
  });

  it("packs multiple small elements into as few chunks as fit under maxChars", () => {
    const p = "<p>1234567890</p>"; // 17 chars
    const html = p.repeat(3); // 51 chars total
    // Cap large enough for 2 elements (34 chars) but not 3 (51 chars).
    const chunks = splitHtmlIntoChunks(html, 40);
    expect(chunks).toEqual([p + p, p]);
  });

  it("gives an oversized single element its own chunk rather than cutting it", () => {
    const big = `<p>${"x".repeat(200)}</p>`;
    const small = "<p>tiny</p>";
    const html = small + big;
    const chunks = splitHtmlIntoChunks(html, 50);
    expect(chunks).toEqual([small, big]);
    // The oversized chunk is allowed to exceed maxChars, but must still be
    // a single well-formed element, not a mid-tag slice.
    expect(chunks[1].startsWith("<p>")).toBe(true);
    expect(chunks[1].endsWith("</p>")).toBe(true);
  });

  it("never cuts an element mid-tag at a chunk boundary", () => {
    const elements = Array.from({ length: 5 }, (_, i) => `<p>paragraph number ${i} of moderate length here</p>`);
    const html = elements.join("");
    const chunks = splitHtmlIntoChunks(html, 90);
    for (const chunk of chunks) {
      // Every chunk must be composed of whole <p>...</p> elements: parsing
      // it back out should reconstruct exactly the same chunk string with
      // no leftover/mismatched tags.
      const doc = new DOMParser().parseFromString(chunk, "text/html");
      const reconstructed = Array.from(doc.body.children)
        .map((el) => el.outerHTML)
        .join("");
      expect(reconstructed).toBe(chunk);
    }
    // All original elements are preserved across chunks, in order.
    expect(chunks.join("")).toBe(html);
  });

  it("preserves bare text nodes interleaved between elements", () => {
    const html = "<p>A</p>some loose text<p>B</p>";
    const chunks = splitHtmlIntoChunks(html, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("some loose text");
    expect(chunks[0]).toContain("<p>A</p>");
    expect(chunks[0]).toContain("<p>B</p>");
  });
});

describe("translateFeedContent", () => {
  it("translates title/summary via a single JSON call and returns null html when input.html is null", async () => {
    requestChatCompletion.mockResolvedValueOnce(JSON.stringify({ title: "Translated Title", summary: "Translated Summary" }));

    const result = await translateFeedContent(
      { title: "Original Title", summary: "Original Summary", html: null },
      { profileId: "", targetLanguage: "English" },
    );

    expect(result).toEqual({
      title: "Translated Title",
      summary: "Translated Summary",
      html: null,
      truncated: false,
    });
    expect(requestChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("tolerates JSON wrapped in prose/code fences (extractJson leniency)", async () => {
    requestChatCompletion.mockResolvedValueOnce(
      'Here you go:\n```json\n{"title":"T2","summary":"S2"}\n```',
    );

    const result = await translateFeedContent(
      { title: "Original", summary: "Orig summary", html: null },
      { profileId: "p1", targetLanguage: "French" },
    );

    expect(result.title).toBe("T2");
    expect(result.summary).toBe("S2");
  });

  it("degrades gracefully on malformed JSON: keeps original title, uses raw response as summary", async () => {
    requestChatCompletion.mockResolvedValueOnce("sorry, I cannot help with that");

    const result = await translateFeedContent(
      { title: "Original Title", summary: "Original Summary", html: null },
      { profileId: "", targetLanguage: "English" },
    );

    expect(result.title).toBe("Original Title");
    expect(result.summary).toBe("sorry, I cannot help with that");
  });

  it("translates html chunks sequentially and joins them", async () => {
    const bigP = (n: number) => `<p>${"y".repeat(n)}</p>`;
    // Two elements, each big enough that they land in separate 12_000-char chunks.
    const html = bigP(11_000) + bigP(11_000);

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }))
      .mockResolvedValueOnce("<p>translated-chunk-1</p>")
      .mockResolvedValueOnce("<p>translated-chunk-2</p>");

    const result = await translateFeedContent(
      { title: "Original", summary: "Orig", html },
      { profileId: "", targetLanguage: "English" },
    );

    expect(requestChatCompletion).toHaveBeenCalledTimes(3);
    expect(result.html).toBe("<p>translated-chunk-1</p>\n<p>translated-chunk-2</p>");
    expect(result.truncated).toBe(false);
  });

  it("strips a markdown code fence from an html chunk reply", async () => {
    const html = "<p>hello</p>";
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }))
      .mockResolvedValueOnce("```html\n<p>bonjour</p>\n```");

    const result = await translateFeedContent(
      { title: "Original", summary: "Orig", html },
      { profileId: "", targetLanguage: "French" },
    );

    expect(result.html).toBe("<p>bonjour</p>");
  });

  it("caps input at MAX_TRANSLATE_HTML_CHARS and sets truncated: true for oversized html", async () => {
    // 45_000 chars of content, over the 40_000 cap.
    const html = `<p>${"z".repeat(45_000)}</p>`;

    requestChatCompletion.mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }));
    // Whatever chunk calls happen after truncation, just echo something back.
    requestChatCompletion.mockResolvedValue("<p>chunk</p>");

    const result = await translateFeedContent(
      { title: "Original", summary: "Orig", html },
      { profileId: "", targetLanguage: "English" },
    );

    expect(result.truncated).toBe(true);
    // Every chunk sent to the LLM must have come from the capped (<=40_000
    // char) prefix, not the full 45_007-char input — a wide-but-meaningful
    // bound that still fails if capping were skipped entirely.
    const chunkCallArgs = requestChatCompletion.mock.calls.slice(1);
    expect(chunkCallArgs.length).toBeGreaterThan(0);
    for (const call of chunkCallArgs) {
      const messages = call[1] as { role: string; content: string }[];
      const userMessage = messages.find((m) => m.role === "user")!;
      expect(userMessage.content.length).toBeLessThanOrEqual(40_010);
    }
  });

  it("wraps a requestChatCompletion failure as a localized translateFailed error", async () => {
    requestChatCompletion.mockRejectedValueOnce(new Error("boom"));

    await expect(
      translateFeedContent(
        { title: "Original", summary: "Orig", html: null },
        { profileId: "", targetLanguage: "English" },
      ),
    ).rejects.toThrow(/boom/);
  });

  it("wraps an html-chunk translation failure the same way", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }))
      .mockRejectedValueOnce(new Error("chunk failed"));

    await expect(
      translateFeedContent(
        { title: "Original", summary: "Orig", html: "<p>hello</p>" },
        { profileId: "", targetLanguage: "English" },
      ),
    ).rejects.toThrow(/chunk failed/);
  });

  it("rejects with AbortError and never calls requestChatCompletion when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      translateFeedContent(
        { title: "Original", summary: "Orig", html: null },
        { profileId: "", targetLanguage: "English", signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(requestChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects with AbortError and stops issuing further chunk calls when aborted mid-translation", async () => {
    const controller = new AbortController();
    const bigP = (n: number) => `<p>${"y".repeat(n)}</p>`;
    // Two elements, each big enough that they land in separate 12_000-char chunks.
    const html = bigP(11_000) + bigP(11_000);

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }))
      .mockImplementationOnce(async () => {
        // Simulate the caller cancelling once the first chunk call resolves.
        controller.abort();
        return "<p>translated-chunk-1</p>";
      });

    await expect(
      translateFeedContent(
        { title: "Original", summary: "Orig", html },
        { profileId: "", targetLanguage: "English", signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    // title/summary call + first chunk call only — the second chunk call
    // must never happen once the signal is observed as aborted.
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not wrap the AbortError in the localized translateFailed message", async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await translateFeedContent(
        { title: "Original", summary: "Orig", html: null },
        { profileId: "", targetLanguage: "English", signal: controller.signal },
      );
      expect.unreachable("expected translateFeedContent to reject");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
      expect((err as Error).message).toBe("Request cancelled.");
      expect((err as Error).message).not.toMatch(/translateFailed|errors\./);
    }
  });
});

describe("translateFeedContent — streaming progress (onProgress)", () => {
  it("emits onProgress after the title/summary step and after every completed chunk, html growing monotonically", async () => {
    const bigP = (n: number) => `<p>${"y".repeat(n)}</p>`;
    // Two elements, each big enough that they land in separate 12_000-char chunks (same shape as the sequential-chunk test above).
    const html = bigP(11_000) + bigP(11_000);

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }))
      .mockResolvedValueOnce("<p>chunk-1</p>")
      .mockResolvedValueOnce("<p>chunk-2</p>");

    const updates: FeedTranslationProgressUpdate[] = [];
    const result = await translateFeedContent(
      { title: "Original", summary: "Orig", html },
      { profileId: "", targetLanguage: "English", onProgress: (p) => updates.push(p) },
    );

    // Post-title/summary emit, then one emit per completed chunk (2) — no
    // in-flight delta emits are expected here since the requestChatCompletion
    // mock never invokes onDelta itself.
    expect(updates).toHaveLength(3);
    expect(updates[0]).toEqual({ title: "T", summary: "S", html: "", doneChunks: 0, totalChunks: 2 });
    expect(updates[1]).toMatchObject({ doneChunks: 1, totalChunks: 2 });
    expect(updates[2]).toMatchObject({ doneChunks: 2, totalChunks: 2 });
    // html must never shrink across the stream, and the final emit must
    // match the function's own return value.
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i].html.length).toBeGreaterThanOrEqual(updates[i - 1].html.length);
    }
    expect(updates[updates.length - 1].html).toBe(result.html);
  });

  it("emits a single html:\"\" update when input.html is null", async () => {
    requestChatCompletion.mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }));

    const updates: FeedTranslationProgressUpdate[] = [];
    await translateFeedContent(
      { title: "Original", summary: "Orig", html: null },
      { profileId: "", targetLanguage: "English", onProgress: (p) => updates.push(p) },
    );

    expect(updates).toEqual([{ title: "T", summary: "S", html: "", doneChunks: 0, totalChunks: 0 }]);
  });
});

describe("translateFeedContent — partial save & resume (itemId + lang)", () => {
  it("leaves a partial translation in the store when aborted mid-translation", async () => {
    const controller = new AbortController();
    const bigP = (n: number) => `<p>${"y".repeat(n)}</p>`;
    const html = bigP(11_000) + bigP(11_000);

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }))
      .mockImplementationOnce(async () => {
        // Simulate the caller cancelling once the first chunk call resolves
        // (same trick as the existing mid-translation abort test above).
        controller.abort();
        return "<p>chunk-1</p>";
      });

    await expect(
      translateFeedContent(
        { title: "Original", summary: "Orig", html },
        { profileId: "", targetLanguage: "English", itemId: "item-1", lang: "en", signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const partial = getPartialFeedTranslation("item-1", "en");
    expect(partial).not.toBeNull();
    expect(partial?.title).toBe("T");
    expect(partial?.summary).toBe("S");
    expect(partial?.chunks).toEqual(["<p>chunk-1</p>"]);
    expect(partial?.totalChunks).toBe(2);
    expect(partial?.truncated).toBe(false);
  });

  it("resumes from a matching partial: skips the title/summary call and already-completed chunk calls", async () => {
    const bigP = (n: number) => `<p>${"y".repeat(n)}</p>`;
    const html = bigP(11_000) + bigP(11_000);
    const input = { title: "Original", summary: "Orig", html };
    const opts = { profileId: "", targetLanguage: "English", itemId: "item-2", lang: "en" };

    // First attempt: title/summary and chunk 1 succeed, chunk 2 fails —
    // leaves a partial covering exactly the first chunk.
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", summary: "S" }))
      .mockResolvedValueOnce("<p>chunk-1</p>")
      .mockRejectedValueOnce(new Error("boom"));

    await expect(translateFeedContent(input, opts)).rejects.toThrow(/boom/);
    expect(requestChatCompletion).toHaveBeenCalledTimes(3);

    // Second attempt with the identical input/keying: only the still-missing
    // chunk should reach the LLM.
    requestChatCompletion.mockReset();
    requestChatCompletion.mockResolvedValueOnce("<p>chunk-2</p>");

    const result = await translateFeedContent(input, opts);

    expect(requestChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.title).toBe("T");
    expect(result.summary).toBe("S");
    expect(result.html).toBe("<p>chunk-1</p>\n<p>chunk-2</p>");
    expect(result.truncated).toBe(false);
    // A successfully completed job clears its own partial (nothing left to resume into).
    expect(getPartialFeedTranslation("item-2", "en")).toBeNull();
  });

  it("discards a stale partial and fully retranslates when the source content changed (sourceSig mismatch)", async () => {
    const opts = { profileId: "", targetLanguage: "English", itemId: "item-3", lang: "en" };
    const bigP = (n: number) => `<p>${"y".repeat(n)}</p>`;
    const htmlA = bigP(11_000) + bigP(11_000);

    // Leave a partial behind for item-3 via an aborted job on content "A".
    const controller = new AbortController();
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "TA", summary: "SA" }))
      .mockImplementationOnce(async () => {
        controller.abort();
        return "<p>chunk-a1</p>";
      });
    await expect(
      translateFeedContent({ title: "A", summary: "Asum", html: htmlA }, { ...opts, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getPartialFeedTranslation("item-3", "en")?.chunks).toEqual(["<p>chunk-a1</p>"]);

    // Different title/summary/html -> different sourceSig; the stale partial
    // above must be ignored (and discarded) rather than resumed into.
    requestChatCompletion
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify({ title: "TB", summary: "SB" }))
      .mockResolvedValueOnce("<p>chunk-b</p>");

    const result = await translateFeedContent({ title: "B", summary: "Bsum", html: "<p>world</p>" }, opts);

    // Full retranslate: title/summary call plus the one small chunk's call
    // both happen — nothing skipped despite item-3 already having a partial
    // on file, because it doesn't match this content's sourceSig.
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.title).toBe("TB");
    expect(result.summary).toBe("SB");
    expect(result.html).toBe("<p>chunk-b</p>");
    expect(getPartialFeedTranslation("item-3", "en")).toBeNull();
  });
});

// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { splitHtmlIntoChunks, translateFeedContent } from "./feedTranslate";

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

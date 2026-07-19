// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { translateArticle, type ArticleTranslationProgressUpdate } from "./translate";
import { getPartialTranslation } from "./partialTranslationStore";
import { resetKvStoreForTests } from "./kvStore";
import type { NewsArticle } from "../types";

// requestChatCompletion is the only real network-ish dependency; mock it so
// tests are deterministic and assert call ordering/count (sequential chunk
// translation, per translate.ts's module header) — same idiom as
// feedTranslate.test.ts.
const requestChatCompletion = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock("./llm", () => ({
  requestChatCompletion: (...args: unknown[]) => requestChatCompletion(...args),
}));

beforeEach(() => {
  requestChatCompletion.mockReset();
  // partialTranslationStore persists through kvStore, which in fallback mode
  // (no initKvStore() call here) behaves like localStorage plus an
  // in-memory mirror — both need clearing between tests, same pattern as
  // feedTranslate.test.ts / reactionStore.test.ts.
  localStorage.clear();
  resetKvStoreForTests();
});

// Two paragraphs, each larger than translate.ts's ARTICLE_CHUNK_CHARS
// (4_500), separated by a blank line — the "oversized paragraph" fallback
// case verified in markdownChunks.test.ts reliably yields exactly 2 chunks,
// unlike more "natural" heading/paragraph shapes where the boundary-flush
// condition depends on exact byte-accounting (see that file's boundary test
// for the precise trace). Reused across every multi-chunk scenario below so
// none of them are sensitive to that byte-accounting.
function twoChunkBody(): string {
  return ["a".repeat(5_000), "", "b".repeat(5_000)].join("\n");
}

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: "article-1",
    title: "Original Title",
    excerpt: "Original excerpt.",
    body: "Original body.",
    tags: [],
    sourceLinks: [],
    authorDid: "did:example:author",
    authorName: "Author",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("translateArticle", () => {
  it("translates title/excerpt via a single JSON call, then the body in one chunk when it fits under ARTICLE_CHUNK_CHARS", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "Translated Title", excerpt: "Translated excerpt." }))
      .mockResolvedValueOnce("Translated body.");

    const result = await translateArticle(makeArticle(), { profileId: "", targetLanguage: "English" });

    expect(result).toEqual({
      title: "Translated Title",
      excerpt: "Translated excerpt.",
      body: "Translated body.",
    });
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("tolerates JSON wrapped in prose/code fences for the title/excerpt call (extractJson leniency)", async () => {
    requestChatCompletion
      .mockResolvedValueOnce('Here you go:\n```json\n{"title":"T2","excerpt":"E2"}\n```')
      .mockResolvedValueOnce("Body.");

    const result = await translateArticle(makeArticle(), { profileId: "p1", targetLanguage: "French" });

    expect(result.title).toBe("T2");
    expect(result.excerpt).toBe("E2");
  });

  it("degrades gracefully on malformed title/excerpt JSON: keeps original title, empty excerpt", async () => {
    requestChatCompletion
      .mockResolvedValueOnce("sorry, I cannot help with that")
      .mockResolvedValueOnce("Body.");

    const article = makeArticle({ title: "Kept Title" });
    const result = await translateArticle(article, { profileId: "", targetLanguage: "English" });

    expect(result.title).toBe("Kept Title");
    expect(result.excerpt).toBe("");
  });

  it("strips a markdown code fence from a translated chunk", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }))
      .mockResolvedValueOnce("```markdown\nTranslated body.\n```");

    const result = await translateArticle(makeArticle(), { profileId: "", targetLanguage: "French" });

    expect(result.body).toBe("Translated body.");
  });

  it("splits a long body into multiple chunks, translates them sequentially, and joins with \\n\\n", async () => {
    const body = twoChunkBody();

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }))
      .mockResolvedValueOnce("chunk-1-translated")
      .mockResolvedValueOnce("chunk-2-translated");

    const result = await translateArticle(makeArticle({ body }), { profileId: "", targetLanguage: "English" });

    expect(requestChatCompletion).toHaveBeenCalledTimes(3);
    expect(result.body).toBe("chunk-1-translated\n\nchunk-2-translated");
  });

  it("returns body: \"\" and skips the chunk loop entirely for an empty body", async () => {
    requestChatCompletion.mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }));

    const result = await translateArticle(makeArticle({ body: "" }), { profileId: "", targetLanguage: "English" });

    expect(result.body).toBe("");
    // Only the title/excerpt call — no chunk call happens for an empty body.
    expect(requestChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns body: \"\" for a whitespace-only body", async () => {
    requestChatCompletion.mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }));

    const result = await translateArticle(makeArticle({ body: "   \n\n  " }), {
      profileId: "",
      targetLanguage: "English",
    });

    expect(result.body).toBe("");
    expect(requestChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("wraps a requestChatCompletion failure (title/excerpt call) as a localized translateFailed error", async () => {
    requestChatCompletion.mockRejectedValueOnce(new Error("boom"));

    await expect(
      translateArticle(makeArticle(), { profileId: "", targetLanguage: "English" }),
    ).rejects.toThrow(/boom/);
  });

  it("wraps a chunk-translation failure the same way", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }))
      .mockRejectedValueOnce(new Error("chunk failed"));

    await expect(
      translateArticle(makeArticle(), { profileId: "", targetLanguage: "English" }),
    ).rejects.toThrow(/chunk failed/);
  });

  it("rejects with AbortError and never calls requestChatCompletion when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      translateArticle(makeArticle(), { profileId: "", targetLanguage: "English", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(requestChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects with AbortError and stops issuing further chunk calls when aborted mid-translation", async () => {
    const controller = new AbortController();
    const body = twoChunkBody();

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }))
      .mockImplementationOnce(async () => {
        // Simulate the caller cancelling once the first chunk call resolves.
        controller.abort();
        return "chunk-1-translated";
      });

    await expect(
      translateArticle(makeArticle({ body }), {
        profileId: "",
        targetLanguage: "English",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // title/excerpt call + first chunk call only — the second chunk call
    // must never happen once the signal is observed as aborted.
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not wrap the AbortError in the localized translateFailed message", async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await translateArticle(makeArticle(), { profileId: "", targetLanguage: "English", signal: controller.signal });
      expect.unreachable("expected translateArticle to reject");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
      expect((err as Error).message).toBe("Request cancelled.");
      expect((err as Error).message).not.toMatch(/translateFailed|errors\./);
    }
  });
});

describe("translateArticle — streaming progress (onProgress)", () => {
  it("emits onProgress after the title/excerpt step and after every completed chunk, in order", async () => {
    const body = twoChunkBody();

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }))
      .mockResolvedValueOnce("chunk-1-translated")
      .mockResolvedValueOnce("chunk-2-translated");

    const updates: ArticleTranslationProgressUpdate[] = [];
    const result = await translateArticle(makeArticle({ body }), {
      profileId: "",
      targetLanguage: "English",
      onProgress: (p) => updates.push(p),
    });

    // Post-title/excerpt emit (title/excerpt known, no chunks yet), then one
    // emit per completed chunk (2) — no in-flight delta emits are expected
    // here since the requestChatCompletion mock never invokes onDelta itself.
    expect(updates).toHaveLength(3);
    expect(updates[0]).toEqual({ title: "T", excerpt: "E", body: "", doneChunks: 0, totalChunks: 2 });
    expect(updates[1]).toMatchObject({ doneChunks: 1, totalChunks: 2, body: "chunk-1-translated" });
    expect(updates[2]).toMatchObject({
      doneChunks: 2,
      totalChunks: 2,
      body: "chunk-1-translated\n\nchunk-2-translated",
    });
    expect(updates[updates.length - 1].body).toBe(result.body);
  });

  it("emits a single body:\"\" update when the body is empty", async () => {
    requestChatCompletion.mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }));

    const updates: ArticleTranslationProgressUpdate[] = [];
    await translateArticle(makeArticle({ body: "" }), {
      profileId: "",
      targetLanguage: "English",
      onProgress: (p) => updates.push(p),
    });

    expect(updates).toEqual([{ title: "T", excerpt: "E", body: "", doneChunks: 0, totalChunks: 0 }]);
  });
});

describe("translateArticle — partial save & resume (lang)", () => {
  it("leaves a partial translation in the store when aborted mid-translation", async () => {
    const controller = new AbortController();
    const body = twoChunkBody();

    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }))
      .mockImplementationOnce(async () => {
        // Simulate the caller cancelling once the first chunk call resolves
        // (same trick as the mid-translation abort test above).
        controller.abort();
        return "chunk-1-translated";
      });

    await expect(
      translateArticle(makeArticle({ body }), {
        profileId: "",
        targetLanguage: "English",
        lang: "en",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const partial = getPartialTranslation("article-1", "en");
    expect(partial).not.toBeNull();
    expect(partial?.title).toBe("T");
    expect(partial?.excerpt).toBe("E");
    expect(partial?.chunks).toEqual(["chunk-1-translated"]);
    expect(partial?.totalChunks).toBe(2);
  });

  it("resumes from a matching partial: skips the title/excerpt call and already-completed chunk calls", async () => {
    const body = twoChunkBody();
    const article = makeArticle({ body });
    const opts = { profileId: "", targetLanguage: "English", lang: "en" };

    // First attempt: title/excerpt and chunk 1 succeed, chunk 2 fails —
    // leaves a partial covering exactly the first chunk.
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }))
      .mockResolvedValueOnce("chunk-1-translated")
      .mockRejectedValueOnce(new Error("boom"));

    await expect(translateArticle(article, opts)).rejects.toThrow(/boom/);
    expect(requestChatCompletion).toHaveBeenCalledTimes(3);

    // Second attempt with the identical article/keying: only the
    // still-missing chunk should reach the LLM.
    requestChatCompletion.mockReset();
    requestChatCompletion.mockResolvedValueOnce("chunk-2-translated");

    const result = await translateArticle(article, opts);

    expect(requestChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.title).toBe("T");
    expect(result.excerpt).toBe("E");
    expect(result.body).toBe("chunk-1-translated\n\nchunk-2-translated");
    // A successfully completed translation clears its own partial (nothing left to resume into).
    expect(getPartialTranslation("article-1", "en")).toBeNull();
  });

  it("discards a stale partial and fully retranslates when the source content changed (sourceSig mismatch)", async () => {
    const opts = { profileId: "", targetLanguage: "English", lang: "en" };
    const bodyA = twoChunkBody();

    // Leave a partial behind for article-3 via an aborted job on content "A".
    const controller = new AbortController();
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "TA", excerpt: "EA" }))
      .mockImplementationOnce(async () => {
        controller.abort();
        return "chunk-a1-translated";
      });
    await expect(
      translateArticle(makeArticle({ id: "article-3", body: bodyA }), { ...opts, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getPartialTranslation("article-3", "en")?.chunks).toEqual(["chunk-a1-translated"]);

    // Different body -> different sourceSig; the stale partial above must be
    // ignored (and discarded) rather than resumed into.
    requestChatCompletion
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify({ title: "TB", excerpt: "EB" }))
      .mockResolvedValueOnce("chunk-b-translated");

    const result = await translateArticle(makeArticle({ id: "article-3", body: "Short body B." }), opts);

    // Full retranslate: title/excerpt call plus the one small chunk's call
    // both happen — nothing skipped despite article-3 already having a
    // partial on file, because it doesn't match this content's sourceSig.
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.title).toBe("TB");
    expect(result.excerpt).toBe("EB");
    expect(result.body).toBe("chunk-b-translated");
    expect(getPartialTranslation("article-3", "en")).toBeNull();
  });

  it("does not persist or resume anything when lang is omitted (backward compatibility)", async () => {
    requestChatCompletion
      .mockResolvedValueOnce(JSON.stringify({ title: "T", excerpt: "E" }))
      .mockResolvedValueOnce("Body translated.");

    await translateArticle(makeArticle(), { profileId: "", targetLanguage: "English" });

    // No lang => no partial-store key to check under any plausible lang;
    // spot-check a couple of common ones plus the article id alone.
    expect(getPartialTranslation("article-1", "en")).toBeNull();
    expect(getPartialTranslation("article-1", "ja")).toBeNull();
  });
});

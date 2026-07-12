import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NewsArticle } from "../types";
import { generateProgram, generateProgramTitle, deriveFallbackTitle } from "./programGenerate";

const requestChatCompletion = vi.fn<(profileId: string, messages: unknown[]) => Promise<string>>();
vi.mock("./llm", () => ({
  requestChatCompletion: (profileId: string, messages: unknown[]) => requestChatCompletion(profileId, messages),
}));
vi.mock("./i18n", () => ({
  tGlobal: (key: string) => key,
}));

beforeEach(() => {
  requestChatCompletion.mockReset();
});

function article(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: "a1",
    title: "Article Title",
    excerpt: "Excerpt",
    body: "Body text",
    tags: [],
    sourceLinks: [],
    authorDid: "did:example:1",
    authorName: "Author",
    createdAt: Date.now(),
    ...overrides,
  };
}

const options = { profileId: "", language: "日本語", locale: "ja" };

describe("generateProgram title behavior", () => {
  it("uses the main reply's title (stripping ruby markers) when present, with exactly 1 LLM call", async () => {
    requestChatCompletion.mockResolvedValueOnce(
      '{"title":"{東京|とうきょう}の朝","segments":[{"articleId":"a1","text":"こんにちは"}]}',
    );
    const articles = [article({ id: "a1" })];

    const program = await generateProgram(articles, options);

    expect(program.title).toBe("東京の朝");
    expect(program.segments).toHaveLength(1);
    expect(requestChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("falls back to a second title-generation call when the main reply has no title", async () => {
    requestChatCompletion.mockResolvedValueOnce(
      '{"segments":[{"articleId":"a1","text":"こんにちは"}]}',
    );
    requestChatCompletion.mockResolvedValueOnce("「今日のニュースまとめ」\nおまけの説明");
    const articles = [article({ id: "a1" })];

    const program = await generateProgram(articles, options);

    expect(program.title).toBe("今日のニュースまとめ");
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("falls back to the first article's title when the second call rejects", async () => {
    requestChatCompletion.mockResolvedValueOnce(
      '{"segments":[{"articleId":"a1","text":"こんにちは"}]}',
    );
    requestChatCompletion.mockRejectedValueOnce(new Error("network"));
    const articles = [article({ id: "a1", title: "  First Article Title  " })];

    const program = await generateProgram(articles, options);

    expect(program.title).toBe("First Article Title");
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("falls back to the untitled-program i18n key when every article title is blank and the second call rejects", async () => {
    requestChatCompletion.mockResolvedValueOnce(
      '{"segments":[{"articleId":"a1","text":"こんにちは"},{"articleId":"a2","text":"どうも"}]}',
    );
    requestChatCompletion.mockRejectedValueOnce(new Error("network"));
    const articles = [article({ id: "a1", title: "  " }), article({ id: "a2", title: "  " })];

    const program = await generateProgram(articles, options);

    expect(program.title).toBe("program.untitledProgram");
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("truncates a long second-call title to 80 characters", async () => {
    requestChatCompletion.mockResolvedValueOnce(
      '{"segments":[{"articleId":"a1","text":"こんにちは"}]}',
    );
    const longTitle = "あ".repeat(120);
    requestChatCompletion.mockResolvedValueOnce(longTitle);
    const articles = [article({ id: "a1" })];

    const program = await generateProgram(articles, options);

    expect(program.title).toHaveLength(80);
    expect(requestChatCompletion).toHaveBeenCalledTimes(2);
  });
});

describe("generateProgramTitle", () => {
  it("never throws: resolves to '' when the underlying call rejects", async () => {
    requestChatCompletion.mockRejectedValueOnce(new Error("boom"));

    const title = await generateProgramTitle(
      [{ text: "some script text" }],
      { profileId: "", language: "日本語" },
    );

    expect(title).toBe("");
  });

  it("normalizes the first non-empty line: trims, strips heading markers, quotes, and ruby", async () => {
    requestChatCompletion.mockResolvedValueOnce('\n  ## "{今日|きょう}のニュース"  \nignored second line');

    const title = await generateProgramTitle(
      [{ text: "some script text" }],
      { profileId: "", language: "日本語" },
    );

    expect(title).toBe("今日のニュース");
  });
});

describe("deriveFallbackTitle", () => {
  it("picks the first article with a non-empty trimmed title, in order", async () => {
    const articles = [
      article({ id: "a1", title: "   " }),
      article({ id: "a2", title: "  Second Article  " }),
      article({ id: "a3", title: "Third Article" }),
    ];

    expect(deriveFallbackTitle(articles)).toBe("Second Article");
  });

  it("returns the untitled-program i18n key for an empty article list", async () => {
    expect(deriveFallbackTitle([])).toBe("program.untitledProgram");
  });
});

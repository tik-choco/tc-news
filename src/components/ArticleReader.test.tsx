import { cleanup, fireEvent, render, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewsArticle } from "../types";
import { ArticleReader } from "./ArticleReader";

vi.mock("../lib/linkPreview", () => ({ mediaPreviewsEnabled: () => false }));
vi.mock("../hooks/useLinkPreview", () => ({ useLinkPreview: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

function article(id: string, sourceLinks: NewsArticle["sourceLinks"] = []): NewsArticle {
  return {
    id,
    title: id,
    excerpt: "",
    body: "Article text",
    tags: [],
    sourceLinks,
    authorDid: "did:example:author",
    authorName: "Author",
    createdAt: 0,
  };
}

describe("article source navigation", () => {
  it("focuses the matching source list without changing the article hash route", () => {
    history.replaceState(null, "", "/#/shared/article-b");
    const source = { title: "Original report", url: "https://example.com/report" };
    const { getAllByRole } = render(
      <>
        <ArticleReader article={article("article-a", [source])} />
        <ArticleReader article={article("article-b", [source])} />
      </>,
    );
    const reader = within(getAllByRole("article")[1]);
    const heading = reader.getByRole("heading", { name: "出典" });
    const scroll = vi.spyOn(heading, "scrollIntoView");

    fireEvent.click(reader.getByRole("button", { name: "出典を見る（1件）" }));

    expect(document.activeElement).toBe(heading);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(location.hash).toBe("#/shared/article-b");
    expect(reader.getAllByRole("link", { name: /Original report/ })).toHaveLength(1);
  });

  it("does not offer source navigation when no source links are stored", () => {
    const { queryByRole } = render(<ArticleReader article={article("article-a")} />);

    expect(queryByRole("button", { name: /出典を見る/ })).toBeNull();
    expect(queryByRole("heading", { name: "出典" })).toBeNull();
  });
});

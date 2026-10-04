import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewsArticle } from "../types";
import { HomeArticleSections } from "./HomeArticleSections";

const evaluation = vi.hoisted(() => ({ score: 55 }));
vi.mock("../lib/articleEvaluation", () => ({
  getLatestArticleEvaluations: (ids: string[]) => new Map(ids.map((id) => [id, { overallScore: evaluation.score }])),
}));
vi.mock("./ArticleCard", () => ({
  ArticleCard: ({ article, onClick, evaluationScore }: {
    article: NewsArticle; onClick: (id: string) => void; evaluationScore?: number;
  }) => (
    <button onClick={() => onClick(article.id)}>
      {article.title}{evaluationScore === undefined ? "" : ` ${evaluationScore}`}
    </button>
  ),
}));

afterEach(cleanup);

const article: NewsArticle = {
  id: "story", title: "Shared story", excerpt: "", body: "", tags: [], sourceLinks: [],
  authorDid: "did:example:author", authorName: "Editor", createdAt: 0,
};

function props() {
  return {
    articles: [] as NewsArticle[],
    globalArticles: [] as NewsArticle[],
    globalConnected: true,
    hasFeedItems: false,
    briefingDisabled: true,
    onOpenArticle: vi.fn(),
    onBriefingClick: vi.fn(),
    onManageFeeds: vi.fn(),
    onOpenGlobal: vi.fn(),
  };
}

describe("home reading and creation paths", () => {
  it("puts shared news first for a new reader and opens the selected shared article", () => {
    const actions = props();
    const { getAllByRole, getByRole } = render(<HomeArticleSections {...actions} globalArticles={[article]} />);
    expect(getAllByRole("heading")[0].textContent).toContain("みんなのニュース");
    fireEvent.click(getByRole("button", { name: "Shared story" }));
    expect(actions.onOpenGlobal).toHaveBeenCalledWith("story");
    expect(actions.onBriefingClick).not.toHaveBeenCalled();
  });

  it("offers feed setup instead of an unusable generate button when no input news exists", () => {
    const actions = props();
    const { getByRole, queryByRole } = render(<HomeArticleSections {...actions} />);
    expect(queryByRole("button", { name: "今日のブリーフィングを生成" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "フィードを登録・管理" }));
    expect(actions.onManageFeeds).toHaveBeenCalledOnce();
  });

  it("keeps existing personal articles first and enables generation once input news exists", () => {
    const actions = props();
    const { getAllByRole, getByRole } = render(
      <HomeArticleSections {...actions} articles={[article]} hasFeedItems briefingDisabled={false} />,
    );
    expect(getAllByRole("heading")[0].textContent).toBe("あなたの記事");
    fireEvent.click(getByRole("button", { name: "今日のブリーフィングを生成" }));
    expect(actions.onBriefingClick).toHaveBeenCalledOnce();
  });

  it("refreshes evaluation scores in the expanded list without changing the article array", () => {
    const actions = props();
    const articles = Array.from({ length: 7 }, (_, index) => ({
      ...article, id: `story-${index}`, title: `Story ${index}`,
    }));
    evaluation.score = 55;
    const { getByRole, rerender } = render(<HomeArticleSections {...actions} articles={articles} />);
    fireEvent.click(getByRole("button", { name: "すべて表示 (7)" }));
    expect(getByRole("button", { name: "Story 6 55" })).toBeTruthy();

    evaluation.score = 82;
    rerender(<HomeArticleSections {...actions} articles={articles} />);
    expect(getByRole("button", { name: "Story 6 82" })).toBeTruthy();
  });
});

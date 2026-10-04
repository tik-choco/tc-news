import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NewsArticle } from "../types";
import { articleCandidate } from "../lib/recommendationCandidates";
import { loadInterests, resetInterests, setInterestFeedback } from "../lib/interestStore";
import { HomeArticleSections } from "./HomeArticleSections";

vi.mock("../lib/articleEvaluation", () => ({ getLatestArticleEvaluations: () => new Map() }));
vi.mock("./ArticleCard", () => ({
  ArticleCard: ({ article, onClick }: { article: NewsArticle; onClick: (id: string) => void }) =>
    <button data-article-id={article.id} onClick={() => onClick(article.id)}>{article.title}</button>,
}));

const NOW = 1_800_000_000_000;
function article(id: string, title: string, minutes = 0): NewsArticle {
  return { id, title, excerpt: "", body: "", tags: [], sourceLinks: [], authorDid: `did:example:${id}`, authorName: "Editor", createdAt: NOW - minutes * 60_000 };
}
function ids(container: Element, section: string) {
  return [...container.querySelectorAll(`${section} [data-article-id]`)].map((el) => el.getAttribute("data-article-id"));
}
beforeEach(() => {
  localStorage.clear();
  resetInterests();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("personalizes all global candidates before the six-card limit, preserves own order, and opens the correct article", () => {
  const target = { ...article("target", "Quantum physics experiment", 10), excerpt: "Quantum physics experiment research", category: "science" };
  for (let i = 0; i < 4; i++) setInterestFeedback(articleCandidate({ ...target, id: `history-${i}` }), "more");
  const state = loadInterests();
  const articles = [article("own-a", "Own weather"), { ...target, id: "own-target" }, article("own-b", "Own city")];
  const globalArticles = [...Array.from({ length: 7 }, (_, i) => article(`global-${i}`, `G${i}`, i)), target];
  const props = {
    articles, globalArticles, globalConnected: true, hasFeedItems: false, briefingDisabled: true,
    onOpenArticle: vi.fn(), onBriefingClick: vi.fn(), onManageFeeds: vi.fn(), onOpenGlobal: vi.fn(),
  };
  const { container, rerender } = render(<HomeArticleSections {...props} recommendationState={{ ...state, mode: "latest" }} />);
  expect(ids(container, ".feed-global-section")).toEqual(globalArticles.slice(0, 6).map((a) => a.id));
  rerender(<HomeArticleSections {...props} recommendationState={state} />);
  expect(ids(container, ".feed-global-section")).toHaveLength(6);
  expect(ids(container, ".feed-global-section")[0]).toBe("target");
  expect(ids(container, ".feed-home-section")).toEqual(articles.map((a) => a.id));
  fireEvent.click(container.querySelector('.feed-global-section [data-article-id="target"]')!);
  expect(props.onOpenGlobal).toHaveBeenCalledWith("target");
  expect(props.onOpenArticle).not.toHaveBeenCalled();
});

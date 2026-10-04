import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FeedItem } from "../types";
import { feedCandidate } from "../lib/recommendationCandidates";
import { loadInterests, resetInterests, setInterestFeedback } from "../lib/interestStore";
import { FeedInbox } from "./FeedInbox";

vi.mock("../hooks/useLinkPreview", () => ({ useLinkPreview: () => null }));
vi.mock("./ArticleCard", () => ({ formatRelativeTime: () => "now" }));

const NOW = 1_800_000_000_000;
function item(id: string, title: string, minutes = 0): FeedItem {
  return { id, title, feedId: id, feedLabel: id, summary: "", link: `https://${id}.example.com/news`, publishedAt: NOW - minutes * 60_000, fetchedAt: NOW };
}
const target = { ...item("target", "Quantum physics experiment", 40), summary: "Quantum physics experiment research", category: "science" };
function learn() {
  for (let i = 0; i < 4; i++) setInterestFeedback(feedCandidate({ ...target, id: `history-${i}` }), "more");
  return loadInterests();
}
function actions(items: FeedItem[]) {
  return { items, hasFeeds: true, selectedIds: new Set<string>(), onToggleSelect: vi.fn(), onSelectMany: vi.fn(), onOpenItem: vi.fn() };
}
function cards(container: Element) { return [...container.querySelectorAll<HTMLElement>(".feed-item-card")]; }
function titles(container: Element) { return cards(container).map((card) => card.querySelector(".feed-item-title")!.textContent); }

beforeEach(() => {
  localStorage.clear();
  resetInterests();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("ranks all deduplicated candidates before the 30-card limit while retaining the newest representative", () => {
  const regular = Array.from({ length: 31 }, (_, i) => item(`a${i}`, `A${i}`, i));
  const olderDuplicate = { ...target, id: "duplicate", title: "Older duplicate", link: `${target.link}?utm_source=other`, publishedAt: target.publishedAt - 1000 };
  const props = actions([olderDuplicate, ...regular, target]);
  const state = learn();
  const { container, rerender } = render(<FeedInbox {...props} recommendationState={{ ...state, mode: "latest" }} />);
  expect(titles(container)).toHaveLength(30);
  expect(titles(container)[0]).toBe("A0");
  expect(titles(container)).not.toContain(target.title);
  rerender(<FeedInbox {...props} recommendationState={state} />);
  expect(titles(container)).toHaveLength(30);
  expect(titles(container)[0]).toBe(target.title);
  expect(titles(container)).not.toContain(olderDuplicate.title);
  expect(cards(container)[0].querySelector(".feed-item-dup")?.textContent).toBe("+1");
  fireEvent.click(cards(container)[0]);
  expect(props.onOpenItem).toHaveBeenCalledWith(target);
});

it("selects and shift-selects in the displayed recommendation order without recording an open", () => {
  const items = [item("a", "A", 0), item("b", "B", 1), item("c", "C", 2), target];
  const props = actions(items);
  const { container, getByRole } = render(<FeedInbox {...props} recommendationState={learn()} />);
  const displayedIds = titles(container).map((title) => items.find((item) => item.title === title)!.id);
  expect(displayedIds[0]).toBe("target");
  fireEvent.click(getByRole("button", { name: "選択" }));
  const displayedCards = cards(container);
  fireEvent.click(displayedCards[0]);
  fireEvent.click(displayedCards[2], { shiftKey: true });
  expect(props.onToggleSelect).toHaveBeenCalledWith(displayedIds[0]);
  expect(props.onSelectMany).toHaveBeenCalledWith(displayedIds.slice(0, 3), true);
  expect(props.onOpenItem).not.toHaveBeenCalled();
  expect(loadInterests().records.every((record) => record.openedAt === 0)).toBe(true);
});

it("explains how to restore articles when every candidate was dismissed", () => {
  const items = [item("a", "A"), target];
  for (const value of items) setInterestFeedback(feedCandidate(value), "less");
  const { container, getByText } = render(<FeedInbox {...actions(items)} recommendationState={loadInterests()} />);
  expect(cards(container)).toHaveLength(0);
  expect(getByText("表示できる記事がありません。設定の「全般」→「おすすめの設定」から非表示を解除できます。")).toBeTruthy();
});

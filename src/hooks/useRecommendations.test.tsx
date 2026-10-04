import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCandidate } from "../lib/recommendationTypes";


import { beginReading, loadInterests, recordImpression, resetInterests, setInterestEnabled, setInterestFeedback, setRecommendationMode, updateReading } from "../lib/interestStore";
import { useRankedCandidates, useRecommendationSnapshot } from "./useRecommendations";

const NOW = Date.UTC(2026, 8, 22);
const news = (id: string, title: string, publishedAt = NOW, category = "tech"): RecommendationCandidate => ({
  key: `feed:${id}`, id, type: "feed", title, summary: "", tags: [], source: "news.example", publishedAt, category,
});
const history = news("history", "game development studio graphics engine launch");
const related = news("related", "game development studio graphics engine launch", NOW - 60_000);
const latest = news("latest", "bank interest rate monetary policy", NOW, "business");
const candidates = [latest, related];

function Feed({ items = candidates, refreshKey = 0, readerOpen = false }: { items?: RecommendationCandidate[]; refreshKey?: number; readerOpen?: boolean }) {
  const snapshot = useRecommendationSnapshot(refreshKey);
  const ranked = useRankedCandidates(items, snapshot);
  return <>
    {readerOpen && <div role="dialog">Reader</div>}
    <ul>{ranked.map((row) => <li key={row.candidate.key}>{row.candidate.id}</li>)}</ul>
  </>;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  loadInterests();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("recommendation feed stability", () => {
  it("keeps cards stable on open and close, then applies saved history on the next visit", () => {
    const ui = render(<Feed />);
    const order = () => ui.getAllByRole("listitem").map((row) => row.textContent);
    expect(order()).toEqual(["latest", "related"]);
    act(() => {
      const session = beginReading(history)!;
      updateReading(history, session, 30_000, "full");
    });
    expect(order()).toEqual(["latest", "related"]);
    ui.rerender(<Feed readerOpen />);
    expect(order()).toEqual(["latest", "related"]);
    ui.rerender(<Feed />);
    expect(order()).toEqual(["latest", "related"]);
    ui.unmount();
    const nextVisit = render(<Feed />);
    expect(nextVisit.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["related", "latest"]);
  });

  it("defers late reading updates until explicit refresh and ignores impression-only updates", () => {
    const ui = render(<Feed />);
    const order = () => ui.getAllByRole("listitem").map((row) => row.textContent);
    act(() => {
      const session = beginReading(history)!;
      updateReading(history, session, 30_000, "full");
      beginReading(latest);
    });
    expect(order()).toEqual(["latest", "related"]);
    ui.rerender(<Feed refreshKey={1} />);
    expect(order()).toEqual(["related", "latest"]);
    const arriving = news("arriving", history.title, NOW + 10_000);
    ui.rerender(<Feed refreshKey={1} items={[arriving, ...candidates]} />);
    expect(order()).toEqual(["related", "latest", "arriving"]);
    // The store moves this record ahead of the newer open. That storage order
    // change is not new interest and must not promote the arriving card.
    act(() => { recordImpression(history, 0, "local-content-v1", "visit"); });
    expect(order()).toEqual(["related", "latest", "arriving"]);
  });

  it("applies mode, pause, dismissal, restore and reset immediately", () => {
    setInterestFeedback(history, "more");
    const ui = render(<Feed />);
    const order = () => ui.getAllByRole("listitem").map((row) => row.textContent);
    expect(order()).toEqual(["related", "latest"]);
    act(() => { setRecommendationMode("latest"); });
    expect(order()).toEqual(["latest", "related"]);
    act(() => { setRecommendationMode("recommended"); });
    expect(order()).toEqual(["related", "latest"]);
    act(() => { setInterestEnabled(false); });
    expect(order()).toEqual(["latest", "related"]);
    act(() => { setInterestEnabled(true); setInterestFeedback(related, "less"); });
    expect(order()).toEqual(["latest"]);
    act(() => { setInterestFeedback(related, null); });
    expect(order()).toEqual(["related", "latest"]);
    act(() => { resetInterests(); });
    expect(order()).toEqual(["latest", "related"]);
  });

  it("appends arriving news without moving existing cards and drops removed candidates", () => {
    const ui = render(<Feed />);
    const arriving = news("arriving", "breaking news", NOW + 10_000);
    const order = () => ui.getAllByRole("listitem").map((row) => row.textContent);
    ui.rerender(<Feed items={[arriving, ...candidates]} />);
    expect(order()).toEqual(["latest", "related", "arriving"]);
    ui.rerender(<Feed items={[arriving, related]} />);
    expect(order()).toEqual(["related", "arriving"]);
    ui.unmount();
    const nextVisit = render(<Feed items={[arriving, related]} />);
    expect(nextVisit.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["arriving", "related"]);
  });

  it("uses the previous session's saved interests on the initial render", () => {
    localStorage.setItem("tc-news:interests", JSON.stringify({ enabled: true, mode: "recommended", records: [{
      candidate: history, openedAt: NOW - 10_000, updatedAt: NOW - 10_000, activeMs: 30_000,
      feedback: null, impressions: 0, lastImpressionAt: 0,
    }] }));
    const ui = render(<Feed />);
    expect(ui.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["related", "latest"]);
  });
});

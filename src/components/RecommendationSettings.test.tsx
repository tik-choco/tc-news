import { act, cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCandidate } from "../lib/recommendationTypes";

vi.mock("../lib/i18n", () => ({ useT: () => (key: string) => key }));

import { beginReading, loadInterests, recordImpression, setInterestFeedback, updateReading } from "../lib/interestStore";
import { RecommendationSettings } from "./RecommendationSettings";

const candidate: RecommendationCandidate = {
  key: "feed:one", id: "one", type: "feed", title: "Game engine launch", summary: "", tags: [],
  source: "news.example", publishedAt: Date.now(),
};

beforeEach(() => { localStorage.clear(); loadInterests(); });
afterEach(cleanup);

describe("recommendation settings", () => {
  it("pauses recording, selects newest-first, and preserves existing history for resume", () => {
    const token = beginReading(candidate)!;
    const ui = render(<RecommendationSettings />);
    fireEvent.click(ui.getByRole("checkbox"));
    expect(loadInterests().enabled).toBe(false);
    const order = ui.getByRole("combobox", { name: "recommendation.order" }) as HTMLSelectElement;
    expect(order.value).toBe("latest");
    expect(order.disabled).toBe(true);
    const before = loadInterests();
    act(() => {
      beginReading({ ...candidate, key: "feed:other", id: "other" });
      recordImpression(candidate, 0, "v1", "session");
      updateReading(candidate, token, 30_000, "full");
    });
    expect(loadInterests()).toBe(before);
    fireEvent.click(ui.getByRole("checkbox"));
    expect(loadInterests().records).toHaveLength(1);
    expect(order.disabled).toBe(false);
    expect(order.value).toBe("recommended");
  });

  it("restores hidden articles and clears history through settings", () => {
    setInterestFeedback(candidate, "less");
    const ui = render(<RecommendationSettings />);
    fireEvent.click(ui.getByText("recommendation.hidden"));
    expect(ui.getByText(candidate.title)).toBeTruthy();
    fireEvent.click(ui.getByRole("button", { name: "recommendation.restore" }));
    expect(loadInterests().records[0].feedback).toBeNull();
    expect(ui.queryByText("recommendation.hidden")).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "recommendation.reset" }));
    expect(loadInterests().records).toEqual([]);
    expect(ui.getByRole("status").textContent).toBe("recommendation.resetDone");
  });

  it("changes the default article order without a manual recommendation update", () => {
    const ui = render(<RecommendationSettings />);
    expect(ui.queryByRole("button", { name: /recommendation.refresh/ })).toBeNull();
    fireEvent.change(ui.getByRole("combobox", { name: "recommendation.order" }), { target: { value: "latest" } });
    expect(loadInterests().mode).toBe("latest");
    fireEvent.change(ui.getByRole("combobox", { name: "recommendation.order" }), { target: { value: "recommended" } });
    expect(loadInterests().mode).toBe("recommended");
  });

  it("can restore a hidden article while learning stays paused", () => {
    setInterestFeedback(candidate, "less");
    const ui = render(<RecommendationSettings />);
    fireEvent.click(ui.getByRole("checkbox"));
    fireEvent.click(ui.getByText("recommendation.hidden"));
    fireEvent.click(ui.getByRole("button", { name: "recommendation.restore" }));
    expect(loadInterests().enabled).toBe(false);
    expect(loadInterests().records[0].feedback).toBeNull();
    expect(ui.queryByText("recommendation.hidden")).toBeNull();
  });
});

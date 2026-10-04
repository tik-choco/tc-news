import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCandidate } from "../lib/recommendationTypes";

vi.mock("../lib/i18n", () => ({ useT: () => (key: string) => key }));

import { loadInterests } from "../lib/interestStore";
import { RecommendationFeedback } from "./RecommendationFeedback";

const candidate: RecommendationCandidate = {
  key: "feed:one", id: "one", type: "feed", title: "Game engine launch", summary: "", tags: [],
  source: "news.example", publishedAt: Date.now(),
};

beforeEach(() => { localStorage.clear(); loadInterests(); });
afterEach(cleanup);

describe("recommendation feedback", () => {
  it("toggles explicit interest and lets the reader undo a dismissal", () => {
    const ui = render(<RecommendationFeedback candidate={candidate} />);
    fireEvent.click(ui.getByRole("button", { name: "recommendation.more" }));
    expect(loadInterests().records[0].feedback).toBe("more");
    expect(ui.getByRole("button", { name: "recommendation.more" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(ui.getByRole("button", { name: "recommendation.more" }));
    expect(loadInterests().records[0].feedback).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "recommendation.less" }));
    expect(loadInterests().records[0].feedback).toBe("less");
    fireEvent.click(ui.getByRole("button", { name: "recommendation.undo" }));
    expect(loadInterests().records[0].feedback).toBeNull();
  });
});

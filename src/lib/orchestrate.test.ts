import { describe, expect, it } from "vitest";
import { parsePlan, MAX_ASSIGNMENTS } from "./orchestrate";
import type { FeedItem } from "../types";

function item(id: string): FeedItem {
  return {
    id,
    feedId: "feed-1",
    feedLabel: "Feed",
    title: `Title ${id}`,
    link: `https://example.com/${id}`,
    summary: `Summary ${id}`,
    publishedAt: 0,
    fetchedAt: 0,
  };
}

const items = [item("a"), item("b"), item("c")];

describe("parsePlan", () => {
  it("parses a valid plan and keeps only known ids", () => {
    const plan = parsePlan(
      JSON.stringify({
        articles: [
          { itemIds: ["a", "b", "unknown"], instruction: "merge these" },
          { itemIds: ["c"], instruction: "solo" },
        ],
      }),
      items,
    );
    expect(plan).toEqual([
      { itemIds: ["a", "b"], instruction: "merge these" },
      { itemIds: ["c"], instruction: "solo" },
    ]);
  });

  it("parses JSON wrapped in prose/code fences", () => {
    const plan = parsePlan('Here you go:\n```json\n{"articles":[{"itemIds":["a"],"instruction":"x"}]}\n```', items);
    expect(plan).toEqual([{ itemIds: ["a"], instruction: "x" }]);
  });

  it("drops an item already claimed by an earlier assignment", () => {
    const plan = parsePlan(
      JSON.stringify({
        articles: [
          { itemIds: ["a", "b"], instruction: "" },
          { itemIds: ["b", "c"], instruction: "" },
        ],
      }),
      items,
    );
    expect(plan).toEqual([
      { itemIds: ["a", "b"], instruction: "" },
      { itemIds: ["c"], instruction: "" },
    ]);
  });

  it("caps the number of assignments at MAX_ASSIGNMENTS", () => {
    const many = Array.from({ length: 10 }, (_, i) => item(`id-${i}`));
    const plan = parsePlan(
      JSON.stringify({ articles: many.map((m) => ({ itemIds: [m.id], instruction: "" })) }),
      many,
    );
    expect(plan).toHaveLength(MAX_ASSIGNMENTS);
  });

  it("falls back to a single all-items assignment on non-JSON", () => {
    const plan = parsePlan("sorry, I cannot help with that", items, "batch note");
    expect(plan).toEqual([{ itemIds: ["a", "b", "c"], instruction: "batch note" }]);
  });

  it("falls back when every assignment is unusable", () => {
    const plan = parsePlan(JSON.stringify({ articles: [{ itemIds: ["nope"] }, { itemIds: "a" }, 42] }), items);
    expect(plan).toEqual([{ itemIds: ["a", "b", "c"], instruction: "" }]);
  });

  it("falls back when articles is missing", () => {
    const plan = parsePlan(JSON.stringify({ plan: [] }), items);
    expect(plan).toEqual([{ itemIds: ["a", "b", "c"], instruction: "" }]);
  });
});

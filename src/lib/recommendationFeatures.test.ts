import { describe, expect, it } from "vitest";
import { featureSimilarity, recommendationFeatures } from "./recommendationFeatures";
import type { RecommendationCandidate } from "./recommendationTypes";

function candidate(title: string, patch: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return { key: "feed:1", id: "1", type: "feed", title, summary: "", tags: [], source: "", publishedAt: 0, ...patch };
}

describe("recommendationFeatures", () => {
  it("finds Japanese topic overlap without relying on whitespace", () => {
    const source = recommendationFeatures(candidate("原神のゲーム開発ニュース"));
    const same = recommendationFeatures(candidate("原神のゲーム開発企業が発表"));
    const other = recommendationFeatures(candidate("銀行政策と世界経済"));
    expect(featureSimilarity(source.terms, same.terms)).toBeGreaterThan(0.5);
    expect(featureSimilarity(source.terms, other.terms)).toBeLessThan(0.1);
  });

  it("normalizes English case and full-width text and ignores common filler words", () => {
    const a = recommendationFeatures(candidate("ＡＩ game development"));
    const b = recommendationFeatures(candidate("The AI GAME DEVELOPMENT"));
    expect(featureSimilarity(a.terms, b.terms)).toBeCloseTo(1);
    expect(recommendationFeatures(candidate("the and of to")).terms.size).toBe(0);
  });

  it("uses summary/tags and invalidates the cache when article content changes", () => {
    const original = candidate("Updates", { summary: "Game developer studio", tags: ["graphics"], category: "tech" });
    const cached = recommendationFeatures(original);
    expect(recommendationFeatures(original)).toBe(cached);
    expect(cached.terms.has("w:graphics")).toBe(true);
    expect(recommendationFeatures({ ...original, title: "Bank interest rates", summary: "", tags: [] })).not.toBe(cached);
    expect(recommendationFeatures({ ...original, category: "business" }).category).toBe("business");
  });

  it("caps both sparse features and cached articles", () => {
    const old = candidate("First story");
    const features = recommendationFeatures(old);
    expect(recommendationFeatures(candidate("", { summary: Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ") })).terms.size).toBeLessThanOrEqual(384);
    for (let i = 0; i < 1_201; i++) recommendationFeatures(candidate(`distinct${i}`));
    expect(recommendationFeatures(old)).not.toBe(features);
    expect(recommendationFeatures(candidate("")).terms.size).toBe(0);
  });
});

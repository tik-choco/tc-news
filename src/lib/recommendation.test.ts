import { describe, expect, it } from "vitest";
import { rankRecommendations } from "./recommendation";
import type { InterestRecord, InterestState, RecommendationCandidate } from "./recommendationTypes";

const NOW = Date.UTC(2026, 8, 22, 12);
const DAY = 86_400_000;
function candidate(id: string, patch: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return { key: `feed:${id}`, id, type: "feed", title: id, summary: "", tags: [], source: "example.com", publishedAt: NOW, ...patch };
}
function record(item: RecommendationCandidate, patch: Partial<InterestRecord> = {}): InterestRecord {
  return { candidate: item, openedAt: NOW, updatedAt: NOW, activeMs: 0, feedback: null, impressions: 0, lastImpressionAt: 0, ...patch };
}
function state(records: InterestRecord[] = [], patch: Partial<InterestState> = {}): InterestState {
  return { enabled: true, mode: "recommended", records, ...patch };
}
const game = candidate("game", { title: "原神のゲーム開発最新ニュース", category: "culture" });
const related = candidate("related", { title: "原神のゲーム開発企業が新作発表", category: "culture", publishedAt: NOW - 60_000 });
const unrelated = candidate("unrelated", { title: "銀行の金利政策と株式市場", category: "business" });

describe("rankRecommendations", () => {
  it("returns strict newest-first with no history, including deterministic timestamp ties", () => {
    const items = [candidate("z"), candidate("old", { publishedAt: NOW - DAY }), candidate("a")];
    expect(rankRecommendations(items, state(), NOW).map((r) => r.candidate.id)).toEqual(["a", "z", "old"]);
    expect(rankRecommendations(items, state(), NOW).every((r) => r.reason === "recent")).toBe(true);
  });

  it("learns from clicks alone without needing a read or reaction", () => {
    const ranked = rankRecommendations([unrelated, related], state([record(game)]), NOW);
    expect(ranked[0].candidate.id).toBe("related");
    expect(ranked[0].reason).toBe("related");
  });

  it("gives deliberate interest and qualified reading more weight than a click", () => {
    const scored = (patch: Partial<InterestRecord>) => rankRecommendations([related, unrelated], state([record(game, patch)]), NOW);
    const gap = (rows: ReturnType<typeof scored>) => rows.find((r) => r.candidate.id === "related")!.score - rows.find((r) => r.candidate.id === "unrelated")!.score;
    expect(gap(scored({ activeMs: 20_000 }))).toBeGreaterThan(gap(scored({})));
    expect(gap(scored({ feedback: "more" }))).toBeGreaterThan(gap(scored({ activeMs: 20_000 })));
  });

  it("does not make a single accidental click outweigh substantially fresher news", () => {
    const oldGame = { ...related, publishedAt: NOW - 7 * DAY };
    expect(rankRecommendations([oldGame, unrelated], state([record(game)]), NOW)[0].candidate.id).toBe("unrelated");
  });

  it("ignores impression-only records as positive interest or confidence", () => {
    const impression = record(game, { openedAt: 0, updatedAt: 0, impressions: 30, lastImpressionAt: NOW });
    expect(rankRecommendations([related, unrelated], state([impression]), NOW)).toEqual(rankRecommendations([related, unrelated], state(), NOW));
  });

  it("deduplicates records so repeated opens cannot inflate interest", () => {
    const one = record(game, { activeMs: 20_000 });
    expect(rankRecommendations([related, unrelated], state(Array(50).fill(one)), NOW)).toEqual(rankRecommendations([related, unrelated], state([one]), NOW));
  });

  it("adapts as old interests fade and a different topic is read", () => {
    const oldGame = record(game, { openedAt: NOW - 25 * DAY, updatedAt: NOW - 25 * DAY, activeMs: 50_000 });
    const bank = record(candidate("bank", { title: "銀行の金利政策と株式市場", category: "business" }), { activeMs: 50_000 });
    expect(rankRecommendations([{ ...related, publishedAt: NOW }, unrelated], state([oldGame, bank]), NOW)[0].candidate.id).toBe("unrelated");
    expect(rankRecommendations([related, unrelated], state([record(game, { updatedAt: NOW - 31 * DAY, openedAt: NOW - 31 * DAY })]), NOW)).toEqual(rankRecommendations([related, unrelated], state(), NOW));
  });

  it("preserves several interests rather than remembering only the last click", () => {
    const bank = record(candidate("bank", { title: "銀行の金利政策と株式市場", category: "business" }), { activeMs: 50_000 });
    const rows = rankRecommendations([related, unrelated, candidate("weather", { title: "台風と大雨の気象予報", category: "science" })], state([record(game, { activeMs: 50_000 }), bank]), NOW);
    expect(rows.slice(0, 2).map((r) => r.candidate.id).sort()).toEqual(["related", "unrelated"]);
  });

  it("honors explicit dismissal in recommended, latest and paused modes", () => {
    const records = [record(game), record(related, { feedback: "less" })];
    for (const settings of [{}, { mode: "latest" as const }, { enabled: false }]) {
      expect(rankRecommendations([related, unrelated], state(records, settings), NOW).map((r) => r.candidate.id)).toEqual(["unrelated"]);
    }
    expect(rankRecommendations([related, unrelated], state(), NOW)).toHaveLength(2);
  });

  it("uses newest-first when latest or paused even with strong existing interests", () => {
    const records = [record(game, { feedback: "more" })];
    for (const settings of [{ mode: "latest" as const }, { enabled: false }]) {
      expect(rankRecommendations([related, unrelated], state(records, settings), NOW).map((r) => r.candidate.id)).toEqual(["unrelated", "related"]);
    }
  });

  it("penalizes read and repeatedly shown items without treating impressions as dislikes", () => {
    const twin = { ...related, id: "twin", key: "feed:twin" };
    const rows = rankRecommendations([related, twin], state([record(game), record(related, { activeMs: 20_000, impressions: 5, lastImpressionAt: NOW })]), NOW);
    expect(rows[0].candidate.id).toBe("twin");
  });

  it("limits a dominant source to three of the first ten when alternatives exist", () => {
    const items = Array.from({ length: 20 }, (_, i) => candidate(`game${i}`, { title: "原神のゲーム開発最新ニュース", category: "culture", source: i < 10 ? "dominant.com" : `other${i % 4}.com`, publishedAt: NOW - i * 60_000 }));
    const rows = rankRecommendations(items, state([record(game, { feedback: "more" })]), NOW);
    expect(rows.slice(0, 10).filter((r) => r.candidate.source === "dominant.com")).toHaveLength(3);
    expect(rows).toHaveLength(items.length);
    expect(rows[4].reason).toBe("explore");
    expect(rankRecommendations(items, state([record(game, { feedback: "more" })]), NOW)).toEqual(rows);
  });

  it("relaxes source caps for sparse candidates and handles empty text/categories", () => {
    expect(rankRecommendations([], state(), NOW)).toEqual([]);
    const items = Array.from({ length: 12 }, (_, i) => candidate(`empty${i}`, { title: "", source: "single.com" }));
    const rows = rankRecommendations(items, state([record(game)]), NOW);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => Number.isFinite(r.score))).toBe(true);
    expect(new Set(rows.map((r) => r.candidate.key)).size).toBe(12);
  });

  it("does not mutate candidates, records or their nested data", () => {
    const items = [related, unrelated];
    const interests = state([record(game)]);
    const before = JSON.stringify({ items, interests });
    rankRecommendations(items, interests, NOW);
    expect(JSON.stringify({ items, interests })).toBe(before);
  });
});

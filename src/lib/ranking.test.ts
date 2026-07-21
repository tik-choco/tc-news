import { describe, expect, it } from "vitest";
import { computeDailyRanking, isSameLocalDay } from "./ranking";
import type { ReactionRecord } from "./reactionStore";
import type { ViewRecord } from "./viewStore";

function record(overrides: Partial<ReactionRecord> = {}): ReactionRecord {
  return {
    targetId: "article-1",
    targetType: "article",
    kind: "like",
    fromId: "did:key:alice",
    fromName: "Alice",
    timestamp: Date.now(),
    ...overrides,
  };
}

function viewRecord(overrides: Partial<ViewRecord> = {}): ViewRecord {
  return {
    targetId: "article-1",
    targetType: "article",
    fromId: "did:key:alice",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("isSameLocalDay", () => {
  it("is true for two timestamps on the same local calendar date", () => {
    const morning = new Date(2026, 6, 9, 0, 30).getTime();
    const night = new Date(2026, 6, 9, 23, 45).getTime();
    expect(isSameLocalDay(morning, night)).toBe(true);
  });

  it("is false across a midnight boundary", () => {
    const justBeforeMidnight = new Date(2026, 6, 9, 23, 59, 59).getTime();
    const justAfterMidnight = new Date(2026, 6, 10, 0, 0, 0).getTime();
    expect(isSameLocalDay(justBeforeMidnight, justAfterMidnight)).toBe(false);
  });

  it("is false for the same time of day on different dates", () => {
    const a = new Date(2026, 6, 9, 12, 0, 0).getTime();
    const b = new Date(2026, 5, 9, 12, 0, 0).getTime();
    expect(isSameLocalDay(a, b)).toBe(false);
  });
});

describe("computeDailyRanking", () => {
  const now = new Date(2026, 6, 9, 12, 0, 0).getTime();
  const yesterday = new Date(2026, 6, 8, 12, 0, 0).getTime();

  it("filters out reactions from a different local day", () => {
    const reactions: ReactionRecord[] = [
      record({ targetId: "a", timestamp: now }),
      record({ targetId: "b", timestamp: yesterday }),
    ];
    const ranking = computeDailyRanking(reactions, [], now);
    expect(ranking).toHaveLength(1);
    expect(ranking[0].targetId).toBe("a");
  });

  it("defaults `now` to Date.now() when omitted", () => {
    const reactions: ReactionRecord[] = [record({ targetId: "a", timestamp: Date.now() })];
    const ranking = computeDailyRanking(reactions);
    expect(ranking).toHaveLength(1);
  });

  it("groups reactions by targetId and computes count + distinct reactors", () => {
    const reactions: ReactionRecord[] = [
      record({ targetId: "a", kind: "like", fromId: "did:key:alice", timestamp: now }),
      record({ targetId: "a", kind: "fire", fromId: "did:key:alice", timestamp: now }),
      record({ targetId: "a", kind: "like", fromId: "did:key:bob", timestamp: now }),
    ];
    const ranking = computeDailyRanking(reactions, [], now);
    expect(ranking).toHaveLength(1);
    const entry = ranking[0];
    expect(entry.targetId).toBe("a");
    expect(entry.count).toBe(3);
    expect(entry.reactors).toBe(2); // alice + bob, alice reacted twice
    expect(entry.byKind.like).toBe(2);
    expect(entry.byKind.fire).toBe(1);
  });

  it("zero-fills byKind for kinds that received no reactions", () => {
    const reactions: ReactionRecord[] = [record({ targetId: "a", kind: "clap", timestamp: now })];
    const ranking = computeDailyRanking(reactions, [], now);
    expect(ranking[0].byKind).toEqual({ like: 0, fire: 0, clap: 1, laugh: 0 });
  });

  it("carries targetType from the first record seen for a targetId", () => {
    const reactions: ReactionRecord[] = [record({ targetId: "p1", targetType: "program", timestamp: now })];
    const ranking = computeDailyRanking(reactions, [], now);
    expect(ranking[0].targetType).toBe("program");
  });

  it("sorts by count desc, then reactors desc, then targetId asc — deterministically", () => {
    const reactions: ReactionRecord[] = [
      // "b": 2 reactions, 1 reactor (same person twice, different kinds)
      record({ targetId: "b", kind: "like", fromId: "did:key:alice", timestamp: now }),
      record({ targetId: "b", kind: "fire", fromId: "did:key:alice", timestamp: now }),
      // "a": 2 reactions, 2 reactors — ties on count with "b", wins on reactors
      record({ targetId: "a", kind: "like", fromId: "did:key:alice", timestamp: now }),
      record({ targetId: "a", kind: "like", fromId: "did:key:bob", timestamp: now }),
      // "d" and "c": both 1 reaction / 1 reactor — tie-break falls to targetId asc
      record({ targetId: "d", kind: "laugh", fromId: "did:key:carol", timestamp: now }),
      record({ targetId: "c", kind: "laugh", fromId: "did:key:carol", timestamp: now }),
    ];
    const ranking = computeDailyRanking(reactions, [], now);
    expect(ranking.map((e) => e.targetId)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an empty array when there are no reactions today", () => {
    expect(computeDailyRanking([], [], now)).toEqual([]);
  });

  it("folds distinct viewers into viewCount and score, deduped per person", () => {
    const views: ViewRecord[] = [
      viewRecord({ targetId: "a", fromId: "did:key:alice", timestamp: now }),
      viewRecord({ targetId: "a", fromId: "did:key:bob", timestamp: now }),
      // A duplicate record for alice (e.g. defensive re-add) must not
      // double-count — dedup is the store's job, but the ranking math should
      // also tolerate it via the Set-based grouping.
      viewRecord({ targetId: "a", fromId: "did:key:alice", timestamp: now }),
    ];
    const ranking = computeDailyRanking([], views, now);
    expect(ranking).toHaveLength(1);
    expect(ranking[0].targetId).toBe("a");
    expect(ranking[0].count).toBe(0);
    expect(ranking[0].viewCount).toBe(2);
    expect(ranking[0].score).toBe(2); // 0 reactions*3 + 2 views*1
  });

  it("filters out views from a different local day", () => {
    const views: ViewRecord[] = [
      viewRecord({ targetId: "a", timestamp: now }),
      viewRecord({ targetId: "b", timestamp: yesterday }),
    ];
    const ranking = computeDailyRanking([], views, now);
    expect(ranking).toHaveLength(1);
    expect(ranking[0].targetId).toBe("a");
  });

  it("weights reactions above views in the combined score (reaction x3 + view x1)", () => {
    const reactions: ReactionRecord[] = [
      // "few-reactions": 1 reaction, 0 views -> score 3
      record({ targetId: "few-reactions", kind: "like", fromId: "did:key:alice", timestamp: now }),
    ];
    const views: ViewRecord[] = [
      // "many-views": 0 reactions, 2 views -> score 2, still behind "few-reactions"
      viewRecord({ targetId: "many-views", fromId: "did:key:alice", timestamp: now }),
      viewRecord({ targetId: "many-views", fromId: "did:key:bob", timestamp: now }),
    ];
    const ranking = computeDailyRanking(reactions, views, now);
    expect(ranking.map((e) => e.targetId)).toEqual(["few-reactions", "many-views"]);
    expect(ranking[0].score).toBe(3);
    expect(ranking[1].score).toBe(2);
  });
});

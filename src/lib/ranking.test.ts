import { describe, expect, it } from "vitest";
import { computeDailyRanking, isSameLocalDay } from "./ranking";
import type { ReactionRecord } from "./reactionStore";

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
    const ranking = computeDailyRanking(reactions, now);
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
    const ranking = computeDailyRanking(reactions, now);
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
    const ranking = computeDailyRanking(reactions, now);
    expect(ranking[0].byKind).toEqual({ like: 0, fire: 0, clap: 1, laugh: 0 });
  });

  it("carries targetType from the first record seen for a targetId", () => {
    const reactions: ReactionRecord[] = [record({ targetId: "p1", targetType: "program", timestamp: now })];
    const ranking = computeDailyRanking(reactions, now);
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
    const ranking = computeDailyRanking(reactions, now);
    expect(ranking.map((e) => e.targetId)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an empty array when there are no reactions today", () => {
    expect(computeDailyRanking([], now)).toEqual([]);
  });
});

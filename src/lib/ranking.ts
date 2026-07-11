// Pure ranking math over reactions (no storage/DOM access) — kept separate
// from lib/reactionStore.ts so it's trivially unit-testable and reusable
// (e.g. from a worker or a future server-side aggregate) without dragging in
// localStorage. Callers pass the output of reactionStore's loadReactions().
//
// Tie-break rationale for computeDailyRanking's sort: count desc is the
// primary signal ("most reacted today"), reactors desc as the first
// tie-break rewards broad reach over one person mashing every emoji on the
// same item, and targetId asc as the final tie-break makes the ordering
// fully deterministic (stable across runs/environments) when both are equal
// — otherwise Array#sort's relative order for ties would depend on the
// input order, which callers shouldn't have to reason about.

import { REACTION_KINDS, type ReactionKind } from "../types";
import type { ReactionRecord } from "./reactionStore";

export interface RankingEntry {
  targetId: string;
  targetType: "article" | "program";
  count: number; // reactions today (sum of byKind)
  byKind: Record<ReactionKind, number>; // zero-filled for all kinds
  reactors: number; // distinct fromIds today
}

/** Whether two epoch-ms timestamps fall on the same local calendar date. */
export function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function zeroCounts(): Record<ReactionKind, number> {
  const out = {} as Record<ReactionKind, number>;
  for (const kind of REACTION_KINDS) out[kind] = 0;
  return out;
}

/**
 * Builds today's (local calendar day, relative to `now`) reaction ranking:
 * filters to same-day reactions, groups by targetId, and sorts by count desc,
 * then reactors desc, then targetId asc (see header comment for why).
 */
export function computeDailyRanking(reactions: ReactionRecord[], now: number = Date.now()): RankingEntry[] {
  const today = reactions.filter((r) => isSameLocalDay(r.timestamp, now));

  const groups = new Map<
    string,
    { targetType: "article" | "program"; byKind: Record<ReactionKind, number>; reactors: Set<string> }
  >();
  for (const r of today) {
    let group = groups.get(r.targetId);
    if (!group) {
      // targetType is taken from the first record seen for this targetId;
      // in practice a given id only ever has one targetType.
      group = { targetType: r.targetType, byKind: zeroCounts(), reactors: new Set() };
      groups.set(r.targetId, group);
    }
    group.byKind[r.kind] += 1;
    group.reactors.add(r.fromId);
  }

  const entries: RankingEntry[] = [];
  for (const [targetId, group] of groups) {
    const count = REACTION_KINDS.reduce((sum, kind) => sum + group.byKind[kind], 0);
    entries.push({
      targetId,
      targetType: group.targetType,
      count,
      byKind: group.byKind,
      reactors: group.reactors.size,
    });
  }

  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.reactors !== a.reactors) return b.reactors - a.reactors;
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
  });

  return entries;
}

// Pure ranking math over reactions + views (no storage/DOM access) — kept
// separate from lib/reactionStore.ts/lib/viewStore.ts so it's trivially
// unit-testable and reusable (e.g. from a worker or a future server-side
// aggregate) without dragging in localStorage. Callers pass the output of
// reactionStore's loadReactions() and viewStore's loadViews().
//
// Score formula: reactions are a deliberate, opt-in signal (picking an
// emoji and sending a signed wire for it) while a view is recorded
// automatically just by opening a reader — so a raw view count would let
// passive traffic dominate over intentional engagement. Reactions are
// weighted 3x a view (REACTION_WEIGHT/VIEW_WEIGHT below); both reactions
// and views are deduped by (targetId, fromId[, kind]) at the store layer
// (reactionStore.hasReacted / viewStore.hasViewed), keyed by the viewer's
// DID pubkey, so neither term can be inflated by one person re-reacting or
// re-opening the same target.
//
// Tie-break rationale for computeDailyRanking's sort: score desc is the
// primary signal ("today's combined engagement"), count desc as the first
// tie-break keeps reactions as the decisive factor when two targets land on
// the same score, reactors desc rewards broad reach over one person mashing
// every emoji on the same item, viewCount desc breaks any remaining tie by
// raw reach, and targetId asc is the final tie-break so the ordering is
// fully deterministic (stable across runs/environments) when everything
// else is equal — otherwise Array#sort's relative order for ties would
// depend on the input order, which callers shouldn't have to reason about.

import { REACTION_KINDS, type ReactionKind } from "../types";
import type { ReactionRecord } from "./reactionStore";
import type { ViewRecord } from "./viewStore";

/** How many score points a single reaction is worth, relative to a view. */
const REACTION_WEIGHT = 3;
/** How many score points a single distinct-viewer view is worth. */
const VIEW_WEIGHT = 1;

export interface RankingEntry {
  targetId: string;
  targetType: "article" | "program";
  count: number; // reactions today (sum of byKind)
  byKind: Record<ReactionKind, number>; // zero-filled for all kinds
  reactors: number; // distinct fromIds today
  viewCount: number; // distinct viewers today (views are deduped per viewer, so this is also "views today")
  score: number; // count * REACTION_WEIGHT + viewCount * VIEW_WEIGHT
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
 * Builds today's (local calendar day, relative to `now`) ranking: filters
 * reactions and views to same-day records, groups both by targetId, and
 * sorts by score desc (see header comment for the full tie-break chain).
 * `views` defaults to `[]` so existing reaction-only callers keep working.
 */
export function computeDailyRanking(
  reactions: ReactionRecord[],
  views: ViewRecord[] = [],
  now: number = Date.now(),
): RankingEntry[] {
  const todayReactions = reactions.filter((r) => isSameLocalDay(r.timestamp, now));
  const todayViews = views.filter((v) => isSameLocalDay(v.timestamp, now));

  const groups = new Map<
    string,
    {
      targetType: "article" | "program";
      byKind: Record<ReactionKind, number>;
      reactors: Set<string>;
      viewers: Set<string>;
    }
  >();

  function groupFor(targetId: string, targetType: "article" | "program") {
    let group = groups.get(targetId);
    if (!group) {
      // targetType is taken from the first record seen for this targetId;
      // in practice a given id only ever has one targetType.
      group = { targetType, byKind: zeroCounts(), reactors: new Set(), viewers: new Set() };
      groups.set(targetId, group);
    }
    return group;
  }

  for (const r of todayReactions) {
    const group = groupFor(r.targetId, r.targetType);
    group.byKind[r.kind] += 1;
    group.reactors.add(r.fromId);
  }
  for (const v of todayViews) {
    const group = groupFor(v.targetId, v.targetType);
    group.viewers.add(v.fromId);
  }

  const entries: RankingEntry[] = [];
  for (const [targetId, group] of groups) {
    const count = REACTION_KINDS.reduce((sum, kind) => sum + group.byKind[kind], 0);
    const viewCount = group.viewers.size;
    entries.push({
      targetId,
      targetType: group.targetType,
      count,
      byKind: group.byKind,
      reactors: group.reactors.size,
      viewCount,
      score: count * REACTION_WEIGHT + viewCount * VIEW_WEIGHT,
    });
  }

  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.count !== a.count) return b.count - a.count;
    if (b.reactors !== a.reactors) return b.reactors - a.reactors;
    if (b.viewCount !== a.viewCount) return b.viewCount - a.viewCount;
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
  });

  return entries;
}

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useInterests } from "./useInterests";
import { loadInterests } from "../lib/interestStore";
import { rankRecommendations } from "../lib/recommendation";
import type { InterestState, RankedRecommendation, RecommendationCandidate } from "../lib/recommendationTypes";

const EMPTY: InterestState = { enabled: false, mode: "latest", records: [] };

function exclusions(state: InterestState): string {
  return state.records.filter((r) => r.feedback === "less").map((r) => r.candidate.key).sort().join("\n");
}

/** Keep learned interests fixed for this visit, including after closing a reader.
 * Only an explicit refresh or a new mount applies reading history.
 * Preferences, dismissal, and reset still apply immediately. */
export function useRecommendationSnapshot(refreshKey = 0) {
  const live = useInterests();
  const [snapshot, setSnapshot] = useState<InterestState>(() => loadInterests());
  const previousRefresh = useRef(refreshKey);
  useEffect(() => {
    const refreshed = previousRefresh.current !== refreshKey;
    previousRefresh.current = refreshKey;
    if (live.enabled !== snapshot.enabled || live.mode !== snapshot.mode ||
        exclusions(live) !== exclusions(snapshot) ||
        (live.records.length === 0 && snapshot.records.length > 0) ||
        refreshed) {
      setSnapshot(refreshed ? loadInterests() : live);
    }
  }, [live, snapshot, refreshKey]);
  return snapshot;
}

/** Re-rank on a new snapshot. Incoming items append without shuffling cards
 * already on screen. Removed/hidden candidates never survive in this order. */
export function useRankedCandidates(candidates: RecommendationCandidate[], state?: InterestState): RankedRecommendation[] {
  const previous = useRef<{ state: InterestState; keys: string[] } | null>(null);
  const selected = state ?? EMPTY;
  return useMemo(() => {
    const ranked = rankRecommendations(candidates, selected);
    if (selected.enabled && selected.mode === "recommended" && previous.current?.state === selected) {
      const byKey = new Map(ranked.map((entry) => [entry.candidate.key, entry]));
      const retained: RankedRecommendation[] = [];
      for (const key of previous.current.keys) {
        const entry = byKey.get(key);
        if (entry) { retained.push(entry); byKey.delete(key); }
      }
      ranked.splice(0, ranked.length, ...retained, ...byKey.values());
    }
    previous.current = { state: selected, keys: ranked.map((entry) => entry.candidate.key) };
    return ranked;
  }, [candidates, selected]);
}

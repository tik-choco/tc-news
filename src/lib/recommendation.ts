import { featureSimilarity, recommendationFeatures, type RecommendationFeatures } from "./recommendationFeatures";
import type { InterestRecord, InterestState, RankedRecommendation, RecommendationCandidate } from "./recommendationTypes";

export const RECOMMENDATION_VERSION = "local-content-v1";
const DAY = 86_400_000;
const MAX_HISTORY_AGE = 30 * DAY;
const READ_THRESHOLD_MS = 15_000;

interface ProfileGroup {
  category: string;
  terms: Map<string, number>;
  mass: number;
}

function age(timestamp: number, now: number): number {
  return Math.max(0, now - (Number.isFinite(timestamp) ? timestamp : 0));
}

function decay(timestamp: number, halfLife: number, now: number): number {
  return 2 ** (-age(timestamp, now) / halfLife);
}

function latestFirst(a: RecommendationCandidate, b: RecommendationCandidate): number {
  return b.publishedAt - a.publishedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Storage normally has one record per item. Deduplicate again at the pure
 * boundary so repeated rows cannot increase either confidence or weight. */
function uniqueRecords(records: InterestRecord[]): Map<string, InterestRecord> {
  const result = new Map<string, InterestRecord>();
  for (const record of records) {
    const previous = result.get(record.candidate.key);
    if (!previous || record.updatedAt > previous.updatedAt ||
      (record.updatedAt === previous.updatedAt && record.lastImpressionAt > previous.lastImpressionAt)) {
      result.set(record.candidate.key, record);
    }
  }
  return result;
}

function positiveWeight(record: InterestRecord): number {
  if (record.feedback === "less") return 0;
  if (record.feedback === "more") return 3;
  // Impression-only records have no open timestamp and must not teach
  // positive interest, even if they have been visible many times.
  if (!(record.openedAt > 0)) return 0;
  return record.activeMs >= READ_THRESHOLD_MS ? 1 : 0.2;
}

function addToProfile(groups: Map<string, ProfileGroup>, features: RecommendationFeatures, weight: number): void {
  if (weight <= 0) return;
  // Known categories preserve multiple distinct interests. Unknown category
  // values go into one text group to keep inference bounded on peer content.
  const category = /^(tech|business|society|science|culture|sports|life)$/.test(features.category)
    ? features.category : "";
  let group = groups.get(category);
  if (!group) {
    group = { category, terms: new Map(), mass: 0 };
    groups.set(category, group);
  }
  group.mass += weight;
  for (const [term, value] of features.terms) group.terms.set(term, (group.terms.get(term) ?? 0) + value * weight);
}

function normalizeProfile(groups: Map<string, ProfileGroup>): ProfileGroup[] {
  for (const group of groups.values()) {
    const norm = Math.sqrt([...group.terms.values()].reduce((sum, value) => sum + value * value, 0));
    if (norm > 0) for (const [term, value] of group.terms) group.terms.set(term, value / norm);
  }
  return [...groups.values()];
}

function matchProfile(features: RecommendationFeatures, groups: ProfileGroup[]): { text: number; category: number } {
  const largestMass = Math.max(0, ...groups.map((group) => group.mass));
  let text = 0;
  let category = 0;
  for (const group of groups) {
    // A smaller interest can still surface relevant stories without a single
    // accidental click becoming as strong as an established preference.
    const strength = Math.sqrt(group.mass / largestMass);
    text = Math.max(text, featureSimilarity(features.terms, group.terms) * strength);
    if (group.category && group.category === features.category) category = Math.max(category, strength);
  }
  return { text, category };
}

function sourceKey(candidate: RecommendationCandidate): string {
  return candidate.source || `unknown:${candidate.key}`;
}

/** Pure deterministic ranking. The bounded feature memo never changes output. */
export function rankRecommendations(
  candidates: RecommendationCandidate[],
  state: InterestState,
  now: number = Date.now(),
): RankedRecommendation[] {
  const records = uniqueRecords(state.records);
  const seen = new Set<string>();
  const available = candidates.filter((candidate) => {
    if (seen.has(candidate.key) || records.get(candidate.key)?.feedback === "less") return false;
    seen.add(candidate.key);
    return true;
  });
  const chronological = () => [...available].sort(latestFirst).map((candidate): RankedRecommendation => ({
    candidate, score: decay(candidate.publishedAt, 2 * DAY, now), reason: "recent",
  }));
  // A manual dismissal stays effective while paused/in latest mode. Pausing
  // disables profiling, not the reader's explicit request to hide an item.
  if (!state.enabled || state.mode === "latest") return chronological();

  const shortGroups = new Map<string, ProfileGroup>();
  const longGroups = new Map<string, ProfileGroup>();
  const negativeGroups = new Map<string, ProfileGroup>();
  const familiarSources = new Set<string>();
  const familiarCategories = new Set<string>();
  let effectiveCount = 0;
  for (const record of records.values()) {
    const timestamp = record.updatedAt || record.openedAt;
    if (age(timestamp, now) > MAX_HISTORY_AGE) continue;
    const weight = positiveWeight(record);
    if (!weight && record.feedback !== "less") continue;
    const features = recommendationFeatures(record.candidate);
    const longWeight = decay(timestamp, 14 * DAY, now);
    if (record.feedback === "less") {
      addToProfile(negativeGroups, features, longWeight);
      continue;
    }
    effectiveCount += weight * longWeight;
    addToProfile(shortGroups, features, weight * decay(timestamp, 2 * DAY, now));
    addToProfile(longGroups, features, weight * longWeight);
    familiarSources.add(sourceKey(record.candidate));
    if (features.category) familiarCategories.add(features.category);
  }
  // Cold start and reset are exactly newest-first, with no exploration or
  // diversity heuristics changing that promise.
  if (effectiveCount === 0) return chronological();
  const shortProfile = normalizeProfile(shortGroups);
  const longProfile = normalizeProfile(longGroups);
  const negativeProfile = normalizeProfile(negativeGroups);
  const personalWeight = 0.65 * effectiveCount / (effectiveCount + 8);
  const candidateCategories = new Map<string, string>();

  const scores = available.map((candidate): RankedRecommendation => {
    const features = recommendationFeatures(candidate);
    candidateCategories.set(candidate.key, features.category);
    const shortMatch = matchProfile(features, shortProfile);
    const longMatch = matchProfile(features, longProfile);
    const text = 0.6 * shortMatch.text + 0.4 * longMatch.text;
    const category = 0.6 * shortMatch.category + 0.4 * longMatch.category;
    const affinity = 0.85 * text + 0.15 * category;
    const record = records.get(candidate.key);
    const readPenalty = record?.openedAt ? (record.activeMs >= READ_THRESHOLD_MS ? 0.08 : 0.025) * decay(record.openedAt, 3 * DAY, now) : 0;
    const repeatPenalty = record ? Math.min(0.06, Math.max(0, record.impressions - 1) * 0.012) * decay(record.lastImpressionAt, 3 * DAY, now) : 0;
    const negativeMatch = matchProfile(features, negativeProfile);
    const score = (1 - personalWeight) * decay(candidate.publishedAt, 2 * DAY, now)
      + personalWeight * affinity - readPenalty - repeatPenalty - 0.04 * negativeMatch.text;
    return { candidate, score, reason: text >= 0.1 ? "related" : category > 0 ? "category" : "recent" };
  });
  scores.sort((a, b) => b.score - a.score || latestFirst(a.candidate, b.candidate));

  const result: RankedRecommendation[] = [];
  const sourceCounts = new Map<string, number>();
  while (scores.length) {
    // Every fifth slot can explore. Deterministic recency picks provide
    // variety without random reshuffles on re-render.
    const explorationSlot = (result.length + 1) % 5 === 0;
    const underCap = (entry: RankedRecommendation) => result.length >= 10 || (sourceCounts.get(sourceKey(entry.candidate)) ?? 0) < 3;
    const hasUncapped = result.length < 10 && scores.some(underCap);
    let index = scores.findIndex((entry) => !hasUncapped || underCap(entry));
    let exploring = false;
    if (explorationSlot) {
      let explorationIndex = -1;
      for (let i = 0; i < scores.length; i++) {
        const entry = scores[i];
        if (hasUncapped && !underCap(entry)) continue;
        const candidate = entry.candidate;
        const category = candidateCategories.get(candidate.key);
        const novel = !familiarSources.has(sourceKey(candidate)) || (category && !familiarCategories.has(category));
        if (!novel || (records.get(candidate.key)?.openedAt ?? 0) > 0) continue;
        if (explorationIndex < 0 || latestFirst(candidate, scores[explorationIndex].candidate) < 0) explorationIndex = i;
      }
      if (explorationIndex >= 0) { index = explorationIndex; exploring = true; }
    }
    const [chosen] = scores.splice(index, 1);
    result.push(exploring ? { ...chosen, reason: "explore" } : chosen);
    const source = sourceKey(chosen.candidate);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  return result;
}

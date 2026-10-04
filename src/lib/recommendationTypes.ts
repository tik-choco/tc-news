export type RecommendationMode = "recommended" | "latest";

export interface RecommendationCandidate {
  key: string;
  id: string;
  type: "feed" | "article";
  title: string;
  summary: string;
  category?: string;
  tags: string[];
  source: string;
  publishedAt: number;
}

export interface InterestRecord {
  candidate: RecommendationCandidate;
  openedAt: number;
  updatedAt: number;
  activeMs: number;
  feedback: "more" | "less" | null;
  impressions: number;
  lastImpressionAt: number;
}

export interface InterestState {
  enabled: boolean;
  mode: RecommendationMode;
  records: InterestRecord[];
}

export interface RankedRecommendation {
  candidate: RecommendationCandidate;
  score: number;
  reason: "related" | "category" | "explore" | "recent";
}

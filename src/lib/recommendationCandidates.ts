import type { FeedItem, NewsArticle } from "../types";
import type { RecommendationCandidate } from "./recommendationTypes";

function hostname(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function feedCandidate(item: FeedItem): RecommendationCandidate {
  return {
    key: `feed:${item.id}`, id: item.id, type: "feed", title: item.title,
    summary: item.summary, category: item.category, tags: [],
    source: hostname(item.link) || item.feedId,
    publishedAt: item.publishedAt || item.fetchedAt,
  };
}

export function articleCandidate(article: NewsArticle): RecommendationCandidate {
  return {
    key: `article:${article.id}`, id: article.id, type: "article", title: article.title,
    summary: article.excerpt, category: article.category, tags: article.tags,
    source: hostname(article.sourceLinks[0]?.url ?? "") || article.authorDid,
    publishedAt: article.createdAt,
  };
}

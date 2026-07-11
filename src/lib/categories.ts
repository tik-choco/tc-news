// Fixed article-category taxonomy. NewsArticle.category rides the wire
// (shared via P2P), so these keys are a wire contract and must never change
// once published — renaming/removing a key would silently reclassify
// already-shared articles as unknown on receiving peers.

/** 記事カテゴリーの固定taxonomy。ワイヤ互換のためキーは変更禁止。 */
export const ARTICLE_CATEGORIES = [
  "tech",
  "business",
  "society",
  "science",
  "culture",
  "sports",
  "life",
  "other",
] as const;

export type ArticleCategory = (typeof ARTICLE_CATEGORIES)[number];

/** 未知の値はnull(未分類)。大文字小文字は吸収する。 */
export function coerceCategory(value: unknown): ArticleCategory | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  const match = ARTICLE_CATEGORIES.find((c) => c === normalized);
  return match ?? null;
}

/** UIラベル用i18nキー: "common.categoryTech" のようにキャメル結合で返す。 */
export function categoryLabelKey(category: ArticleCategory): string {
  return `common.category${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}

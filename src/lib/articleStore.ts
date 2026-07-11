// Persistence for the current user's own generated articles ("記事" tab).
// Same defensive-parsing shape as the rest of tc-news's localStorage
// modules: JSON.parse in a try/catch, every field coerced to its expected
// type, invalid entries dropped rather than crashing the app.

import type { NewsArticle, SourceLink } from "../types";

const ARTICLES_KEY = "tc-news:articles";
const MAX_ARTICLES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSourceLink(value: unknown): SourceLink | null {
  if (!isRecord(value)) return null;
  const url = typeof value.url === "string" ? value.url : "";
  if (!url) return null;
  return { title: typeof value.title === "string" ? value.title : "", url };
}

function sanitizeArticle(value: unknown): NewsArticle | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;

  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
  const tags = Array.isArray(value.tags) ? value.tags.filter((t): t is string => typeof t === "string") : [];
  const sourceLinks = Array.isArray(value.sourceLinks)
    ? value.sourceLinks.map(sanitizeSourceLink).filter((l): l is SourceLink => l !== null)
    : [];

  const article: NewsArticle = {
    id,
    title: typeof value.title === "string" ? value.title : "",
    excerpt: typeof value.excerpt === "string" ? value.excerpt : "",
    body: typeof value.body === "string" ? value.body : "",
    tags,
    sourceLinks,
    authorDid: typeof value.authorDid === "string" ? value.authorDid : "",
    authorName: typeof value.authorName === "string" ? value.authorName : "",
    createdAt,
  };
  if (typeof value.cid === "string") article.cid = value.cid;
  if (typeof value.shared === "boolean") article.shared = value.shared;
  if (typeof value.origin === "string") article.origin = value.origin;
  if (typeof value.category === "string" && value.category) article.category = value.category;
  if (typeof value.lang === "string" && value.lang) article.lang = value.lang;
  if (typeof value.imageUrl === "string" && value.imageUrl) article.imageUrl = value.imageUrl;
  return article;
}

function persist(articles: NewsArticle[]): void {
  try {
    localStorage.setItem(ARTICLES_KEY, JSON.stringify(articles.slice(0, MAX_ARTICLES)));
  } catch (error) {
    console.warn("tc-news: failed to persist articles", error);
  }
}

/** createdAt 降順で自分の生成記事を返す。 */
export function loadMyArticles(): NewsArticle[] {
  try {
    const raw = localStorage.getItem(ARTICLES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeArticle)
      .filter((a): a is NewsArticle => a !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** id が一致する既存記事を置き換え、無ければ先頭に追加する(上限200)。 */
export function upsertMyArticle(article: NewsArticle): void {
  const existing = loadMyArticles();
  const next = [article, ...existing.filter((a) => a.id !== article.id)].sort((a, b) => b.createdAt - a.createdAt);
  persist(next);
}

export function deleteMyArticle(id: string): void {
  const existing = loadMyArticles();
  persist(existing.filter((a) => a.id !== id));
}

/**
 * 受信記事を自分の記事としてコピー保存する。origin=取得元roomId。
 * 既に同idが存在すれば何もしない(falseを返す)。保存できたらtrue。
 */
export function saveSharedArticle(article: NewsArticle, originRoomId: string): boolean {
  const existing = loadMyArticles();
  if (existing.some((a) => a.id === article.id)) return false;
  const copy: NewsArticle = { ...article, origin: originRoomId, shared: false, cid: article.cid };
  persist([copy, ...existing].sort((a, b) => b.createdAt - a.createdAt));
  return true;
}

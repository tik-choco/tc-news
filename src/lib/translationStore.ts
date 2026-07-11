// Local read-through cache for translated article content, keyed by
// articleId×lang. Populated either by a local translateArticle() LLM call or
// by a received tc-news:translation wire (see hooks/useNewsRoom.ts) — either
// way, once a translation lands here, no peer needs to re-run the LLM for
// the same article×language pair. Same defensive-parsing localStorage
// pattern as articleEvaluation.ts, but keyed flat (not per-room): a
// translation is useful regardless of which room/tab it was first seen in.

const TRANSLATIONS_KEY = "tc-news:translations";
const MAX_TRANSLATIONS = 500;

export interface ArticleTranslation {
  id: string; // 共有時はwire id、ローカルのみの翻訳は生成id
  articleId: string;
  lang: string;
  title: string;
  excerpt: string;
  body: string;
  translatorDid: string;
  translatorName: string;
  translatedAt: number; // epoch ms
  cid?: string; // P2P共有済みの場合のみ設定
}

function cacheKey(articleId: string, lang: string): string {
  return `${articleId}::${lang}`;
}

function newTranslationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `translation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function isArticleTranslation(value: unknown): value is ArticleTranslation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.articleId === "string" &&
    typeof v.lang === "string" &&
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    typeof v.translatorDid === "string" &&
    typeof v.translatedAt === "number"
  );
}

function coerceArticleTranslation(value: unknown): ArticleTranslation | null {
  if (!isArticleTranslation(value)) return null;
  return {
    id: value.id,
    articleId: value.articleId,
    lang: value.lang,
    title: value.title,
    excerpt: typeof value.excerpt === "string" ? value.excerpt : "",
    body: value.body,
    translatorDid: value.translatorDid,
    translatorName: typeof value.translatorName === "string" ? value.translatorName : "",
    translatedAt: value.translatedAt,
    cid: typeof value.cid === "string" ? value.cid : undefined,
  };
}

function loadAll(): Record<string, ArticleTranslation> {
  try {
    const raw = localStorage.getItem(TRANSLATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ArticleTranslation> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const record = coerceArticleTranslation(v);
      if (record) out[k] = record;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAll(all: Record<string, ArticleTranslation>): void {
  try {
    localStorage.setItem(TRANSLATIONS_KEY, JSON.stringify(all));
  } catch {
    // Storage full / unavailable — non-fatal.
  }
}

/** 記事×言語の翻訳(あれば)。無ければnull — 呼び出し側はLLM翻訳を実行する合図として使う。 */
export function getTranslation(articleId: string, lang: string): ArticleTranslation | null {
  return loadAll()[cacheKey(articleId, lang)] ?? null;
}

/**
 * 翻訳を保存する。id未指定ならローカル生成(P2P未共有の翻訳用)。上限件数を超えたら
 * 古いエントリから間引く。
 */
export function saveTranslation(record: Omit<ArticleTranslation, "id"> & { id?: string }): ArticleTranslation {
  const full: ArticleTranslation = { ...record, id: record.id ?? newTranslationId() };
  const all = loadAll();
  all[cacheKey(full.articleId, full.lang)] = full;
  const entries = Object.entries(all);
  if (entries.length > MAX_TRANSLATIONS) {
    entries.sort((a, b) => b[1].translatedAt - a[1].translatedAt);
    persistAll(Object.fromEntries(entries.slice(0, MAX_TRANSLATIONS)));
  } else {
    persistAll(all);
  }
  return full;
}

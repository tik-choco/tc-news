// Article evaluation — LLM-as-judge scoring for "how good is this generated
// article" (accuracy, clarity, coverage, headline quality, neutrality),
// surfaced in ArticlesView. Evaluation records are local-only (never sent
// over P2P — see docs/SPEC3.md) so a peer can't spoof/spam another user's
// scores; only the taxonomy category the record proposes may later be copied
// onto the shared NewsArticle by the caller. The coding style
// (extractJson/coerceScore defensive parsing, persisted history,
// requestChatCompletion call shape) mirrors tc-town's characterEvaluation.ts,
// and the English-prompt + injected `language` convention mirrors generate.ts.

import type { ChatMessage } from "@tik-choco/mistai";
import type { NewsArticle } from "../types";
import { requestChatCompletion } from "./llm";
import { tGlobal } from "./i18n";
import { ARTICLE_CATEGORIES, coerceCategory } from "./categories";
import { kvGetSync, kvSetSync } from "./kvStore";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

export interface ArticleEvaluationAxis {
  key: string;
  rubric: string; // English — used directly in the judge prompt.
}

/** 5軸。キーは変更禁止(i18nラベルは articles.axis_<key>)。 */
export const ARTICLE_AXES: readonly ArticleEvaluationAxis[] = [
  {
    key: "accuracy_score",
    rubric: "Does the article stay strictly within the given sources, with speculation clearly flagged?",
  },
  {
    key: "clarity_score",
    rubric: "Is the article well structured (headings, paragraphs, lead) and easy to read?",
  },
  {
    key: "coverage_score",
    rubric: "Does it capture the key points of the sources without omissions or redundancy?",
  },
  {
    key: "headline_score",
    rubric: "Do the title and excerpt accurately and attractively summarize the body?",
  },
  {
    key: "neutrality_score",
    rubric: "Does it avoid sensational or one-sided phrasing and keep a balanced tone?",
  },
];

// -----------------------------------------------------------------------------
// Record model
// -----------------------------------------------------------------------------

export interface ArticleEvaluationRecord {
  id: string;
  articleId: string;
  /** epoch millis */
  evaluatedAt: number;
  /** axis key -> 1..5（パース失敗時は 0） */
  scores: Record<string, number>;
  /** 総合スコア (0-100)。算出式は computeOverallScore() を参照。 */
  overallScore: number;
  /** 総評(UIの言語で) */
  notes: string;
  /** 改善提案(UIの言語で) */
  suggestions: string[];
  /** 評価者が選んだカテゴリー(taxonomy外は "" に強制) */
  category: string;
}

// -----------------------------------------------------------------------------
// Persistence (mist KV via lib/kvStore.ts, defensive parsing — same pattern
// as characterEvaluation.ts)
// -----------------------------------------------------------------------------

const EVALUATIONS_KEY = "tc-news:evaluations";
const MAX_HISTORY_PER_ARTICLE = 10;

function newEvalId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `article-eval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function isArticleEvaluationRecord(value: unknown): value is ArticleEvaluationRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.articleId === "string" &&
    typeof r.evaluatedAt === "number" &&
    typeof r.notes === "string" &&
    typeof r.overallScore === "number" &&
    typeof r.category === "string" &&
    !!r.scores &&
    typeof r.scores === "object" &&
    Array.isArray(r.suggestions)
  );
}

function coerceArticleEvaluationRecord(value: unknown): ArticleEvaluationRecord | null {
  if (!isArticleEvaluationRecord(value)) return null;
  const scores: Record<string, number> = {};
  for (const [key, v] of Object.entries(value.scores)) {
    if (typeof v === "number") scores[key] = v;
  }
  const suggestions = value.suggestions.filter((s): s is string => typeof s === "string");
  return {
    id: value.id,
    articleId: value.articleId,
    evaluatedAt: value.evaluatedAt,
    scores,
    overallScore: value.overallScore,
    notes: value.notes,
    suggestions,
    category: value.category,
  };
}

function loadAllEvaluations(): Record<string, ArticleEvaluationRecord[]> {
  try {
    const raw = kvGetSync(EVALUATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ArticleEvaluationRecord[]> = {};
    for (const [articleId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const records = list
        .map(coerceArticleEvaluationRecord)
        .filter((r): r is ArticleEvaluationRecord => r !== null);
      if (records.length > 0) out[articleId] = records;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAllEvaluations(all: Record<string, ArticleEvaluationRecord[]>): void {
  kvSetSync(EVALUATIONS_KEY, JSON.stringify(all));
}

function saveEvaluation(record: ArticleEvaluationRecord): void {
  const all = loadAllEvaluations();
  const existing = all[record.articleId] ?? [];
  const next = [record, ...existing]
    .sort((a, b) => b.evaluatedAt - a.evaluatedAt)
    .slice(0, MAX_HISTORY_PER_ARTICLE);
  all[record.articleId] = next;
  persistAllEvaluations(all);
}

/** 記事の評価履歴を新しい順に返す */
export function listArticleEvaluations(articleId: string): ArticleEvaluationRecord[] {
  const all = loadAllEvaluations();
  return [...(all[articleId] ?? [])].sort((a, b) => b.evaluatedAt - a.evaluatedAt);
}

/** 最新の評価（なければ null） */
export function getLatestArticleEvaluation(articleId: string): ArticleEvaluationRecord | null {
  return listArticleEvaluations(articleId)[0] ?? null;
}

export function deleteArticleEvaluations(articleId: string): void {
  const all = loadAllEvaluations();
  if (!(articleId in all)) return;
  delete all[articleId];
  persistAllEvaluations(all);
}

// -----------------------------------------------------------------------------
// Overall score
// -----------------------------------------------------------------------------

/** 5軸(1-5)の平均を0-100に換算する。 */
export function computeOverallScore(scores: Record<string, number>): number {
  const values = ARTICLE_AXES.map((axis) => scores[axis.key] ?? 0);
  const axisAverage = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  return Math.round((axisAverage / 5) * 100);
}

// -----------------------------------------------------------------------------
// Prompt building
// -----------------------------------------------------------------------------

// The judge only needs to read the article, not regenerate it — very long
// bodies just burn context, so trim to the first 6000 characters.
const MAX_BODY_CHARS = 6000;

function buildSystemPrompt(language: string): string {
  const rubricBlock = ARTICLE_AXES.map((axis) => `- ${axis.key}: ${axis.rubric}`).join("\n");
  const keyList = [...ARTICLE_AXES.map((axis) => axis.key), "notes", "suggestions", "category"].join(", ");
  const categoryList = ARTICLE_CATEGORIES.join(", ");

  return (
    "You are an evaluator (LLM judge) for a web news article. Score each axis from 1 to 5 " +
    `and return only JSON with keys: ${keyList}. ` +
    `Score each axis strictly according to the following rubric:\n${rubricBlock}\n` +
    `Write notes and suggestions in ${language}. ` +
    "notes should be a short, concrete overall assessment. " +
    "suggestions should be a JSON array of 2 to 5 short strings, each a concrete improvement. " +
    `category must be exactly one of: ${categoryList} (single best fit).`
  );
}

function formatSourceLinks(sourceLinks: NewsArticle["sourceLinks"]): string {
  if (sourceLinks.length === 0) return "(none)";
  return sourceLinks.map((link) => `- [${link.title}](${link.url})`).join("\n");
}

function formatArticleBlock(article: NewsArticle): string {
  const body = article.body.length > MAX_BODY_CHARS ? `${article.body.slice(0, MAX_BODY_CHARS)}...` : article.body;
  const lines = [
    `Title: ${article.title}`,
    `Excerpt: ${article.excerpt || "(none)"}`,
    `Tags: ${article.tags.length > 0 ? article.tags.join(", ") : "(none)"}`,
    `Source links:\n${formatSourceLinks(article.sourceLinks)}`,
    `Body:\n${body}`,
  ];
  return lines.join("\n\n");
}

// -----------------------------------------------------------------------------
// LLM response parsing (same defensive style as characterEvaluation.ts)
// -----------------------------------------------------------------------------

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

function coerceScore(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) throw new TypeError("evaluation score is not a number");
  return Math.max(1, Math.min(5, Math.trunc(n)));
}

function coerceSuggestions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : String(v).trim()))
      .filter((s) => s.length > 0)
      .slice(0, 6);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((s) => s.replace(/^[-・*\s]+/, "").trim())
      .filter((s) => s.length > 0)
      .slice(0, 6);
  }
  return [];
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * 記事をLLM judgeに採点させる。成功時は保存してからresolve。
 * LLM呼び出し失敗は tGlobal("errors.evalFailed", {detail}) のメッセージでthrow。
 */
export async function evaluateArticle(
  article: NewsArticle,
  opts: { profileId: string; language: string },
): Promise<ArticleEvaluationRecord> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(opts.language) },
    { role: "user", content: formatArticleBlock(article) },
  ];

  let responseText: string;
  try {
    responseText = await requestChatCompletion(opts.profileId, messages, { temperature: 0.2 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("errors.evalFailed", { detail }));
  }

  let scores: Record<string, number>;
  let notes: string;
  let suggestions: string[];
  let category: string;
  try {
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    scores = {};
    for (const axis of ARTICLE_AXES) {
      scores[axis.key] = coerceScore(data[axis.key] ?? 0);
    }
    notes = data.notes === undefined ? "" : String(data.notes);
    suggestions = coerceSuggestions(data.suggestions);
    category = coerceCategory(data.category) ?? "";
  } catch {
    scores = {};
    for (const axis of ARTICLE_AXES) {
      scores[axis.key] = 0;
    }
    notes = `Evaluator returned non-JSON output: ${responseText.slice(0, 300)}`;
    suggestions = [];
    category = "";
  }

  const record: ArticleEvaluationRecord = {
    id: newEvalId(),
    articleId: article.id,
    evaluatedAt: Date.now(),
    scores,
    overallScore: computeOverallScore(scores),
    notes,
    suggestions,
    category,
  };
  saveEvaluation(record);
  return record;
}

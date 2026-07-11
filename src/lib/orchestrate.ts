// Orchestrated ("編集部") article generation: an orchestrator LLM (typically a
// stronger model, e.g. fable5) reads the candidate FeedItems and plans how to
// split them into 1..N article assignments; worker LLM calls (typically a
// cheaper model, e.g. sonnet5) then generate every assigned article in
// parallel via generate.ts. Which shared preset (lib/llmConfig.ts) plays
// which role is configured in tc-news' local ProviderSettings
// (orchestratorPresetId / workerPresetId, "" = the shared default preset —
// lib/llmSettings.ts). Over the AI Network the parallel worker requests share
// one provider connection — the provider serves them concurrently.
//
// Plan parsing follows generate.ts's defensive extractJson pattern: a
// malformed or empty plan degrades to a single assignment covering every
// item (i.e. the same behavior as plain generateArticle), never a throw.
// Only the orchestrator/worker LLM calls themselves may throw.

import type { ChatMessage } from "@tik-choco/mistai";
import type { FeedItem, NewsArticle } from "../types";
import { requestChatCompletion } from "./llm";
import { generateArticle } from "./generate";

/** 計画1件 = worker 1体が書く記事1本ぶんの担当範囲。 */
export interface ArticleAssignment {
  /** 担当するFeedItem.idの集合(必ず1件以上、既知のidのみ)。 */
  itemIds: string[];
  /** orchestratorがworkerへ渡す記事の切り口・編集方針。 */
  instruction: string;
}

/** orchestratorに一度の計画で割り当てさせる記事本数の上限。 */
export const MAX_ASSIGNMENTS = 5;

function buildPlannerSystemPrompt(language: string): string {
  return (
    "You are the chief editor of a news desk planning today's coverage. " +
    "You are given a list of feed items, each with an id. Group related items into " +
    `1 to ${MAX_ASSIGNMENTS} article assignments for staff writers. Each assignment covers a coherent ` +
    "topic; unrelated items belong in separate assignments, and near-duplicate items belong " +
    "in the same one. Every assignment needs at least one item; you may leave trivial items " +
    "unassigned. For each assignment, write a short editorial instruction for the writer " +
    `in ${language} (the angle, what to emphasize, what to compare). ` +
    'Return only the following JSON: {"articles": [{"itemIds": string[], "instruction": string}]}.'
  );
}

function buildPlannerUserMessage(items: FeedItem[], instruction?: string): string {
  const lines = items.map((item) => `- id: ${item.id}\n  title: ${item.title}\n  summary: ${item.summary}`);
  let message = lines.join("\n");
  const trimmed = instruction?.trim();
  if (trimmed) message += `\n\nEditor-in-chief's instructions for the whole batch: ${trimmed}`;
  return message;
}

// Same outermost-{...} extraction as generate.ts, so a plan wrapped in prose
// or code fences still parses.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

/**
 * orchestratorの応答テキストを検証済みの割り当てリストに変換する。未知のid・
 * 空のitemIds・不正な形はすべて落とし、使える割り当てが1件も残らなければ
 * 「全アイテムを1記事に」へフォールバックする(= 従来の単発生成と同じ挙動)。
 */
export function parsePlan(responseText: string, items: FeedItem[], batchInstruction?: string): ArticleAssignment[] {
  const knownIds = new Set(items.map((item) => item.id));
  const fallback: ArticleAssignment[] = [
    { itemIds: items.map((item) => item.id), instruction: batchInstruction?.trim() ?? "" },
  ];

  let data: unknown;
  try {
    data = JSON.parse(extractJson(responseText));
  } catch {
    return fallback;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return fallback;

  const rawArticles = (data as Record<string, unknown>).articles;
  if (!Array.isArray(rawArticles)) return fallback;

  const seen = new Set<string>();
  const assignments: ArticleAssignment[] = [];
  for (const raw of rawArticles) {
    if (assignments.length >= MAX_ASSIGNMENTS) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const itemIds = Array.isArray(record.itemIds)
      ? record.itemIds.filter((id): id is string => typeof id === "string" && knownIds.has(id) && !seen.has(id))
      : [];
    if (itemIds.length === 0) continue;
    itemIds.forEach((id) => seen.add(id));
    assignments.push({
      itemIds,
      instruction: typeof record.instruction === "string" ? record.instruction : "",
    });
  }

  return assignments.length > 0 ? assignments : fallback;
}

export interface OrchestrateOptions {
  /** orchestrator(計画)役のプロファイルid。 */
  orchestratorProfileId: string;
  /** worker(執筆)役のプロファイルid。 */
  workerProfileId: string;
  /** バッチ全体へのユーザー指示(計画プロンプトとフォールバック割り当てに乗る)。 */
  instruction?: string;
  authorDid: string;
  authorName: string;
  /** Endonym of the target language, e.g. "日本語". */
  language: string;
  /** Locale code stamped onto each article as NewsArticle.lang. */
  locale: string;
  /** 進捗UI用: 計画完了時に総数、以降worker 1体の完了ごとに呼ばれる。 */
  onProgress?: (done: number, total: number) => void;
}

export interface OrchestrateResult {
  articles: NewsArticle[];
  /** 失敗したworkerのエラーメッセージ(部分成功を許す)。 */
  errors: string[];
}

/**
 * orchestratorで計画→workerを並列fan-outして記事群を生成する。計画の失敗は
 * フォールバックで吸収するため、投げるのはorchestrator呼び出し自体の失敗
 * (LLM未設定・接続不可など)のみ。workerの失敗は記事単位でerrorsに積み、
 * 成功した記事は必ず返す。
 */
export async function runOrchestratedGeneration(
  items: FeedItem[],
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildPlannerSystemPrompt(opts.language) },
    { role: "user", content: buildPlannerUserMessage(items, opts.instruction) },
  ];
  const responseText = await requestChatCompletion(opts.orchestratorProfileId, messages);
  const assignments = parsePlan(responseText, items, opts.instruction);

  const itemsById = new Map(items.map((item) => [item.id, item]));
  let done = 0;
  opts.onProgress?.(0, assignments.length);

  const settled = await Promise.allSettled(
    assignments.map((assignment) =>
      generateArticle(
        assignment.itemIds.map((id) => itemsById.get(id)).filter((item): item is FeedItem => item !== undefined),
        {
          profileId: opts.workerProfileId,
          instruction: assignment.instruction.trim() || undefined,
          authorDid: opts.authorDid,
          authorName: opts.authorName,
          language: opts.language,
          locale: opts.locale,
        },
      ).finally(() => {
        done += 1;
        opts.onProgress?.(done, assignments.length);
      }),
    ),
  );

  const articles: NewsArticle[] = [];
  const errors: string[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") articles.push(result.value);
    else errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
  }
  return { articles, errors };
}

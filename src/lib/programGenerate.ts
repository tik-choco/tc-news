// Radio-program script generation: turns a selection of NewsArticles into a
// RadioProgram whose segments are meant to be read aloud via TTS (see
// tts.ts). One LLM call produces strict JSON — parsing mirrors generate.ts's
// extractJson pattern (first "{" to last "}", code-fence tolerant) — but
// unlike generate.ts, any failure here (the LLM call itself, or a malformed/
// empty reply) is surfaced as a single Error via tGlobal("program.
// generateFailed", { detail }) so the caller only has one failure path to
// handle.

import type { ChatMessage } from "@tik-choco/mistai";
import type { NewsArticle, ProgramSegment, RadioProgram } from "../types";
import { requestChatCompletion } from "./llm";
import { tGlobal } from "./i18n";

const BODY_EXCERPT_CHARS = 1500;

// English-based prompt so behavior is consistent regardless of the target
// script language, which is injected via {language}. The JSON output shape
// ({"title","segments":[{"articleId","text"}]}) is a hard contract with the
// parsing logic below and must not change.
function buildSystemPrompt(language: string): string {
  return (
    "You are a radio news program writer. Based on the given articles, write a spoken-word " +
    "narration script for a short news radio program. Return only the following JSON: " +
    '{"title": string, "segments": [{"articleId": string | null, "text": string}]}. ' +
    "The segments array must start with a short opening greeting (articleId: null), then exactly " +
    "one narration segment per article in the given order (articleId set to that article's id, " +
    "text roughly 150-300 words), and end with a short closing (articleId: null). Write smooth, " +
    "natural transitions between segments. Every segment's text must be plain, conversational " +
    "spoken-language prose meant to be read aloud by a text-to-speech engine: no markdown syntax, " +
    "no URLs, no emoji, no bullet points or headings. " +
    `Write everything in ${language}.`
  );
}

// Rough markdown stripping so the LLM sees readable prose rather than syntax
// noise: headings/emphasis markers dropped, links reduced to their text.
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .trim();
}

function truncateBody(body: string): string {
  const plain = stripMarkdown(body);
  return plain.length > BODY_EXCERPT_CHARS ? `${plain.slice(0, BODY_EXCERPT_CHARS)}…` : plain;
}

function buildUserMessage(articles: NewsArticle[]): string {
  return articles
    .map((article, index) => {
      return (
        `Article ${index + 1}\n` +
        `id: ${article.id}\n` +
        `title: ${article.title}\n` +
        `excerpt: ${article.excerpt}\n` +
        `body: ${truncateBody(article.body)}`
      );
    })
    .join("\n\n");
}

// Ported from generate.ts's extractJson: grabs the outermost {...} span so a
// reply wrapped in prose/code-fences still parses.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

function newProgramId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `program-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export interface GenerateProgramOptions {
  profileId: string;
  /** Endonym of the target language for the generated script, e.g. "English". */
  language: string;
  /** Locale code stamped onto the program as RadioProgram.lang, e.g. "en". */
  locale: string;
}

export async function generateProgram(
  articles: NewsArticle[],
  options: GenerateProgramOptions,
): Promise<RadioProgram> {
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(options.language) },
      { role: "user", content: buildUserMessage(articles) },
    ];

    const responseText = await requestChatCompletion(options.profileId, messages);

    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    const knownIds = new Set(articles.map((a) => a.id));

    const rawSegments = Array.isArray(data.segments) ? data.segments : [];
    const segments: ProgramSegment[] = [];
    for (const raw of rawSegments) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) continue;
      const segment: ProgramSegment = { text };
      if (typeof record.articleId === "string" && knownIds.has(record.articleId)) {
        segment.articleId = record.articleId;
      }
      segments.push(segment);
    }

    if (segments.length === 0) {
      throw new Error("empty script");
    }

    const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : tGlobal("program.untitledProgram");

    const articlesById = new Map(articles.map((a) => [a.id, a]));
    const segmentImageUrl = segments
      .map((s) => (s.articleId ? articlesById.get(s.articleId)?.imageUrl : undefined))
      .find((url): url is string => Boolean(url));
    const imageUrl = segmentImageUrl ?? articles.find((a) => a.imageUrl)?.imageUrl;

    const program: RadioProgram = {
      id: newProgramId(),
      title,
      segments,
      createdAt: Date.now(),
      lang: options.locale,
    };
    if (imageUrl) program.imageUrl = imageUrl;
    return program;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(tGlobal("program.generateFailed", { detail }));
  }
}

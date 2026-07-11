// Persistence for AI-generated radio programs ("番組" tab). Same
// defensive-parsing shape as the rest of tc-news's localStorage modules (see
// articleStore.ts): JSON.parse in a try/catch, every field coerced to its
// expected type, invalid entries dropped rather than crashing the app.

import type { ProgramSegment, RadioProgram } from "../types";

const PROGRAMS_KEY = "tc-news:programs";
const MAX_PROGRAMS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSegment(value: unknown): ProgramSegment | null {
  if (!isRecord(value)) return null;
  const text = typeof value.text === "string" ? value.text : "";
  if (!text) return null;
  const segment: ProgramSegment = { text };
  if (typeof value.articleId === "string" && value.articleId) segment.articleId = value.articleId;
  return segment;
}

function sanitizeProgram(value: unknown): RadioProgram | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  const title = typeof value.title === "string" ? value.title : "";
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
  const rawSegments = Array.isArray(value.segments) ? value.segments : [];
  const segments = rawSegments.map(sanitizeSegment).filter((s): s is ProgramSegment => s !== null);

  const program: RadioProgram = { id, title, segments, createdAt };
  if (typeof value.lang === "string" && value.lang) program.lang = value.lang;
  if (typeof value.authorDid === "string" && value.authorDid) program.authorDid = value.authorDid;
  if (typeof value.authorName === "string" && value.authorName) program.authorName = value.authorName;
  if (typeof value.shared === "boolean") program.shared = value.shared;

  // audioCidsはsegmentsとインデックス対応するため、生のsegments配列が1件でも
  // 間引かれていたら対応がずれる。また audioCids 自体も全要素が非空文字列で
  // segmentsと同じ長さである必要がある。条件を満たさなければ番組自体は保持
  // しつつ音声フィールドごと破棄する。
  const segmentsIntact = segments.length === rawSegments.length;
  const rawAudioCids = Array.isArray(value.audioCids) ? value.audioCids : null;
  const audioCidsAllStrings =
    rawAudioCids !== null && rawAudioCids.every((c): c is string => typeof c === "string" && c.length > 0);
  if (segmentsIntact && rawAudioCids && audioCidsAllStrings && rawAudioCids.length === segments.length) {
    program.audioCids = rawAudioCids;
    program.audioMime = typeof value.audioMime === "string" && value.audioMime ? value.audioMime : "audio/mpeg";
    if (typeof value.audioVoice === "string" && value.audioVoice) program.audioVoice = value.audioVoice;
  }
  return program;
}

function persist(programs: RadioProgram[]): void {
  try {
    localStorage.setItem(PROGRAMS_KEY, JSON.stringify(programs.slice(0, MAX_PROGRAMS)));
  } catch (error) {
    console.warn("tc-news: failed to persist programs", error);
  }
}

/** createdAt 降順で保存済みの番組を返す。 */
export function loadPrograms(): RadioProgram[] {
  try {
    const raw = localStorage.getItem(PROGRAMS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeProgram)
      .filter((p): p is RadioProgram => p !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** 新しい番組を先頭に追加して保存する(上限50、新しい順に切り詰め)。 */
export function addProgram(program: RadioProgram): RadioProgram[] {
  const existing = loadPrograms();
  const next = [program, ...existing.filter((p) => p.id !== program.id)].sort((a, b) => b.createdAt - a.createdAt);
  persist(next);
  return next;
}

/** id が一致する番組を削除して保存する。 */
export function removeProgram(id: string): RadioProgram[] {
  const existing = loadPrograms();
  const next = existing.filter((p) => p.id !== id);
  persist(next);
  return next;
}

/**
 * id が一致する既存番組を置き換え、無ければ先頭に追加して保存する(上限50、新しい
 * 順に切り詰め)。addProgramと違い「新規作成」を意味しない呼び出し元向け — 例えば
 * 番組をP2P共有した後にauthorDid/authorName/shared:trueを書き戻すケース。
 */
export function upsertProgram(program: RadioProgram): RadioProgram[] {
  const existing = loadPrograms();
  const next = [program, ...existing.filter((p) => p.id !== program.id)].sort((a, b) => b.createdAt - a.createdAt);
  persist(next);
  return next;
}

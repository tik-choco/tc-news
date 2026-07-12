// Wire format + localStorage persistence for P2P news-article sharing over
// mistlib (see hooks/useNewsRoom.ts). Structured article bodies are
// content-addressed via storage_add() and only the CID + metadata travels
// on the signed wire — mirrors tc-chat's post-stream wire pattern. Same
// shape is reused for tc-news:translation wires (see TranslationWire below):
// a translation is a separate, independently-signed annotation on an
// article, not a modification of the immutable article record itself.
// tc-news:reaction (ReactionWire) and tc-news:program (ProgramWire) wires
// follow the same signed-envelope shape but are intentionally NOT part of
// the NewsWire union or the article wireLog: reactions are aggregated
// separately (lib/reactionStore.ts) and replayed to newcomers from their own
// log (loadReactionLog/appendReactionLog below) so a burst of reactions
// can't evict article wires from the replay window. Programs reuse the
// article's CID-on-signed-wire pattern verbatim (loadSharedPrograms /
// saveSharedPrograms mirror loadSharedArticles / saveSharedArticles) and,
// like reactions, get their own replay log (loadProgramLog/appendProgramLog)
// so shared programs reach late joiners without competing with article wires
// for replay-window slots.
import type { NewsArticle, ProgramSegment, RadioProgram } from "../types";
import { safeSetItem } from "./safeStorage";

/** 全ユーザー共通のグローバル記事ルーム。ファミリー他アプリもこの定数値で購読できる(well-known)。 */
export const GLOBAL_ARTICLES_ROOM_ID = "tc-global-articles";

export interface ArticleWire extends Record<string, unknown> {
  type: "tc-news:article";
  id: string; // article.id
  fromId: string; // 送信者DID
  fromName: string;
  timestamp: number;
  cid: string; // NewsArticle全体のJSONのCID
  signature: string;
  // 発行元アプリ名(現状 "tc-news")。optional: 既存クライアントのwireには無い
  // ので、無くても有効なwireとして扱う(後方互換)。wireSign.ts の
  // signWireFields/verifyWire は signature を除く全フィールドを対称に
  // stableStringify するため、このフィールドを足しても署名/検証のペアは
  // 崩れない(列挙方式ではないので追加・削除だけで壊れない)。
  fromApp?: string;
}

export interface HistoryRequestWire extends Record<string, unknown> {
  type: "tc-news:history-request";
  fromId: string;
  timestamp: number;
}

/**
 * 記事の翻訳結果を1件配信するワイヤ。articleId×langごとに1件が想定値だが、複数の
 * ピアが同時に翻訳して先着順にならないケースはあり得るため、受信側は「まだ持って
 * いなければ採用」でデデュープする(hooks/useNewsRoom.ts の hydrateTranslation)。
 */
export interface TranslationWire extends Record<string, unknown> {
  type: "tc-news:translation";
  id: string; // 翻訳レコードの一意id(article.id ではない)
  articleId: string; // NewsArticle.id
  lang: string; // 翻訳先ロケール(lib/i18n の Locale値)
  fromId: string; // 翻訳者DID
  fromName: string;
  timestamp: number;
  cid: string; // TranslationPayload全体のJSONのCID
  signature: string;
  fromApp?: string;
}

/** TranslationWire.cid が指す本体。 */
export interface TranslationPayload extends Record<string, unknown> {
  articleId: string;
  lang: string;
  title: string;
  excerpt: string;
  body: string;
}

export type NewsWire = ArticleWire | TranslationWire;

/**
 * リアクション(👍🔥👏😂)1件を配信するワイヤ。targetId は記事/番組どちらのidも
 * 取り得るため targetType で区別する。kind はここではワイヤ形状として文字列である
 * ことのみ検証し、REACTION_KINDS に含まれるかの意味検証は受信フック側で行う
 * (受信側が知らない新しい種類を追加してもワイヤ検証自体は壊れないようにするため)。
 */
export interface ReactionWire extends Record<string, unknown> {
  type: "tc-news:reaction";
  id: string; // ワイヤの一意id(uuid) — targetIdではない
  targetId: string; // NewsArticle.id または RadioProgram.id
  targetType: "article" | "program";
  kind: string; // REACTION_KINDS のいずれか(受信側で検証)
  fromId: string; // 送信者DID
  fromName: string;
  timestamp: number;
  signature: string;
  fromApp?: string;
}

/**
 * 番組(RadioProgram)をP2P共有するワイヤ。記事と同じくJSON全体をCID化し、
 * CID+メタデータだけを署名して配信する(ArticleWireと対称の形)。
 */
export interface ProgramWire extends Record<string, unknown> {
  type: "tc-news:program";
  id: string; // program.id
  fromId: string;
  fromName: string;
  timestamp: number;
  cid: string; // RadioProgram全体のJSONのCID
  signature: string;
  fromApp?: string;
}

const SHARED_ARTICLES_KEY_PREFIX = "tc-news:shared:";
const WIRE_LOG_KEY_PREFIX = "tc-news:wirelog:";
const SHARED_PROGRAMS_KEY_PREFIX = "tc-news:shared-programs:";
const REACTION_LOG_KEY_PREFIX = "tc-news:reactionlog:";
const PROGRAM_LOG_KEY_PREFIX = "tc-news:programlog:";
const MAX_SHARED_ARTICLES = 200;
const MAX_WIRE_LOG = 300;
const MAX_SHARED_PROGRAMS = 100;
const MAX_REACTION_LOG = 1000;
const MAX_PROGRAM_LOG = 100;

export function newTranslationWireId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `translation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function newReactionWireId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `reaction-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function isSourceLink(value: unknown): value is { title: string; url: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === "string" && typeof v.url === "string";
}

function sanitizeArticle(value: unknown): NewsArticle | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return null;
  if (typeof v.title !== "string") return null;
  if (typeof v.body !== "string") return null;
  if (typeof v.authorDid !== "string") return null;
  if (typeof v.createdAt !== "number") return null;
  return {
    id: v.id,
    title: v.title,
    excerpt: typeof v.excerpt === "string" ? v.excerpt : "",
    body: v.body,
    tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [],
    sourceLinks: Array.isArray(v.sourceLinks) ? v.sourceLinks.filter(isSourceLink) : [],
    authorDid: v.authorDid,
    authorName: typeof v.authorName === "string" ? v.authorName : "",
    createdAt: v.createdAt,
    cid: typeof v.cid === "string" ? v.cid : undefined,
    shared: typeof v.shared === "boolean" ? v.shared : undefined,
    category: typeof v.category === "string" && v.category ? v.category : undefined,
    lang: typeof v.lang === "string" && v.lang ? v.lang : undefined,
    imageUrl: typeof v.imageUrl === "string" && v.imageUrl ? v.imageUrl : undefined,
  };
}

export function loadSharedArticles(roomId: string): NewsArticle[] {
  try {
    const raw = localStorage.getItem(SHARED_ARTICLES_KEY_PREFIX + roomId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeArticle).filter((a): a is NewsArticle => a !== null);
  } catch {
    return [];
  }
}

export function saveSharedArticles(roomId: string, articles: NewsArticle[]): void {
  const sorted = [...articles].sort((a, b) => b.createdAt - a.createdAt);
  const trimmed = sorted.slice(0, MAX_SHARED_ARTICLES);
  safeSetItem(SHARED_ARTICLES_KEY_PREFIX + roomId, JSON.stringify(trimmed));
}

function sanitizeSharedProgramSegment(value: unknown): ProgramSegment | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== "string" || !v.text) return null;
  const segment: ProgramSegment = { text: v.text };
  if (typeof v.articleId === "string" && v.articleId) segment.articleId = v.articleId;
  if (typeof v.ruby === "string" && v.ruby) segment.ruby = v.ruby;
  return segment;
}

/**
 * 受信した番組JSON(ProgramWire.cidの中身)をRadioProgramへ検証・変換する。
 * sanitizeArticleと同じ防御的パース方針: 必須フィールドが欠けていればnull、
 * segmentsは不正な要素だけ間引き、1件も残らなければnull(空の番組は共有不可)。
 * 受信側の表示状態として常にshared:trueを付与する。
 */
export function sanitizeSharedProgram(value: unknown): RadioProgram | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return null;
  if (typeof v.title !== "string") return null;
  if (typeof v.createdAt !== "number") return null;
  const rawSegments = Array.isArray(v.segments) ? v.segments : [];
  const segments = rawSegments.map(sanitizeSharedProgramSegment).filter((s): s is ProgramSegment => s !== null);
  if (segments.length === 0) return null;
  const program: RadioProgram = {
    id: v.id,
    title: v.title,
    segments,
    createdAt: v.createdAt,
    shared: true,
  };
  if (typeof v.lang === "string" && v.lang) program.lang = v.lang;
  if (typeof v.authorDid === "string" && v.authorDid) program.authorDid = v.authorDid;
  if (typeof v.authorName === "string" && v.authorName) program.authorName = v.authorName;
  if (typeof v.imageUrl === "string" && v.imageUrl) program.imageUrl = v.imageUrl;

  // audioCidsはsegmentsとインデックス対応するため、生のsegments配列が1件でも
  // 間引かれていたら対応がずれる。また audioCids 自体も全要素が非空文字列で
  // segmentsと同じ長さである必要がある。条件を満たさなければ番組自体は保持
  // しつつ音声フィールドごと破棄する(programStore.tsのsanitizeProgramと同じ方針)。
  const segmentsIntact = segments.length === rawSegments.length;
  const rawAudioCids = Array.isArray(v.audioCids) ? v.audioCids : null;
  const audioCidsAllStrings =
    rawAudioCids !== null && rawAudioCids.every((c): c is string => typeof c === "string" && c.length > 0);
  if (segmentsIntact && rawAudioCids && audioCidsAllStrings && rawAudioCids.length === segments.length) {
    program.audioCids = rawAudioCids;
    program.audioMime = typeof v.audioMime === "string" && v.audioMime ? v.audioMime : "audio/mpeg";
    if (typeof v.audioVoice === "string" && v.audioVoice) program.audioVoice = v.audioVoice;
  }
  return program;
}

export function loadSharedPrograms(roomId: string): RadioProgram[] {
  try {
    const raw = localStorage.getItem(SHARED_PROGRAMS_KEY_PREFIX + roomId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeSharedProgram).filter((p): p is RadioProgram => p !== null);
  } catch {
    return [];
  }
}

export function saveSharedPrograms(roomId: string, programs: RadioProgram[]): void {
  const sorted = [...programs].sort((a, b) => b.createdAt - a.createdAt);
  const trimmed = sorted.slice(0, MAX_SHARED_PROGRAMS);
  safeSetItem(SHARED_PROGRAMS_KEY_PREFIX + roomId, JSON.stringify(trimmed));
}

function isArticleWire(value: unknown): value is ArticleWire {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "tc-news:article" &&
    typeof v.id === "string" &&
    typeof v.fromId === "string" &&
    typeof v.fromName === "string" &&
    typeof v.timestamp === "number" &&
    typeof v.cid === "string" &&
    typeof v.signature === "string" &&
    // fromApp is optional (back-compat with pre-fromApp wires); if present it
    // must be a string.
    (v.fromApp === undefined || typeof v.fromApp === "string")
  );
}

function isTranslationWire(value: unknown): value is TranslationWire {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "tc-news:translation" &&
    typeof v.id === "string" &&
    typeof v.articleId === "string" &&
    typeof v.lang === "string" &&
    typeof v.fromId === "string" &&
    typeof v.fromName === "string" &&
    typeof v.timestamp === "number" &&
    typeof v.cid === "string" &&
    typeof v.signature === "string" &&
    (v.fromApp === undefined || typeof v.fromApp === "string")
  );
}

export function isReactionWire(value: unknown): value is ReactionWire {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "tc-news:reaction" &&
    typeof v.id === "string" &&
    typeof v.targetId === "string" &&
    (v.targetType === "article" || v.targetType === "program") &&
    typeof v.kind === "string" &&
    typeof v.fromId === "string" &&
    typeof v.fromName === "string" &&
    typeof v.timestamp === "number" &&
    typeof v.signature === "string" &&
    (v.fromApp === undefined || typeof v.fromApp === "string")
  );
}

export function isProgramWire(value: unknown): value is ProgramWire {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "tc-news:program" &&
    typeof v.id === "string" &&
    typeof v.fromId === "string" &&
    typeof v.fromName === "string" &&
    typeof v.timestamp === "number" &&
    typeof v.cid === "string" &&
    typeof v.signature === "string" &&
    (v.fromApp === undefined || typeof v.fromApp === "string")
  );
}

export function loadWireLog(roomId: string): NewsWire[] {
  try {
    const raw = localStorage.getItem(WIRE_LOG_KEY_PREFIX + roomId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((w): w is NewsWire => isArticleWire(w) || isTranslationWire(w));
  } catch {
    return [];
  }
}

/** Records a signed wire for later replay, deduped by wire id, newest kept. */
export function appendWireLog(roomId: string, wire: NewsWire): void {
  const log = loadWireLog(roomId);
  if (log.some((w) => w.id === wire.id)) return;
  const next = [...log, wire];
  const trimmed = next.length > MAX_WIRE_LOG ? next.slice(next.length - MAX_WIRE_LOG) : next;
  safeSetItem(WIRE_LOG_KEY_PREFIX + roomId, JSON.stringify(trimmed));
}

/**
 * リアクションの履歴ログ(新規参加者へのリプレイ用)。記事のwireLogとは別キーで
 * 保持する — リアクションは頻発しうるため、同じログを共有すると記事ワイヤが
 * リプレイ窓から押し出されてしまう(ヘッダコメント参照)。
 */
export function loadReactionLog(roomId: string): ReactionWire[] {
  try {
    const raw = localStorage.getItem(REACTION_LOG_KEY_PREFIX + roomId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReactionWire);
  } catch {
    return [];
  }
}

/** リアクションワイヤをwire idでデデュープして記録する(新しい順に上限件数で切り詰め)。 */
export function appendReactionLog(roomId: string, wire: ReactionWire): void {
  const log = loadReactionLog(roomId);
  if (log.some((w) => w.id === wire.id)) return;
  const next = [...log, wire];
  const trimmed = next.length > MAX_REACTION_LOG ? next.slice(next.length - MAX_REACTION_LOG) : next;
  safeSetItem(REACTION_LOG_KEY_PREFIX + roomId, JSON.stringify(trimmed));
}

/**
 * 番組ワイヤの履歴ログ(新規参加者へのリプレイ用)。記事のwireLogとは別キーで保持
 * する理由はリアクションと同じ — ログを混ぜると番組が記事ワイヤをリプレイ窓から
 * 押し出し得る(ヘッダコメント参照)。かつては番組は意図的にリプレイ対象外だった
 * が、「共有ボタンを押しても後から参加したユーザーに届かない」ため専用ログで
 * リプレイ対象に加えた。
 */
export function loadProgramLog(roomId: string): ProgramWire[] {
  try {
    const raw = localStorage.getItem(PROGRAM_LOG_KEY_PREFIX + roomId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProgramWire);
  } catch {
    return [];
  }
}

/** 番組ワイヤをwire id(=program.id)でデデュープして記録する(上限件数で切り詰め)。 */
export function appendProgramLog(roomId: string, wire: ProgramWire): void {
  const log = loadProgramLog(roomId);
  if (log.some((w) => w.id === wire.id)) return;
  const next = [...log, wire];
  const trimmed = next.length > MAX_PROGRAM_LOG ? next.slice(next.length - MAX_PROGRAM_LOG) : next;
  safeSetItem(PROGRAM_LOG_KEY_PREFIX + roomId, JSON.stringify(trimmed));
}

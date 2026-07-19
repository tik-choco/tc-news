// Local read-through cache for translated RadioProgram scripts, keyed by
// programId×lang. Same local-only rationale as feedTranslationStore.ts: a
// program translation (lib/programTranslate.ts) is a convenience for the
// viewer of one program, never shared over P2P, so it's never persisted to
// or read from the room — the same programId×lang pair just doesn't re-run
// the LLM every time the script pane re-renders. Same defensive-parsing +
// kvStore persistence pattern as feedTranslationStore.ts, plus the
// byte-level safety net from partialFeedTranslationStore.ts's persistAll
// (a program script's segment count isn't bounded the same way a single
// feed item's HTML is, so entry count alone doesn't cap serialized size).
// Persisted via kvStore (mist KV, OPFS-backed; localStorage only as a
// pre-hydration/fallback path — see kvStore.ts's module header).

import { KV_VALUE_SOFT_LIMIT_BYTES, kvGetSync, kvSetSync, utf8ByteLength } from "./kvStore";

const PROGRAM_TRANSLATIONS_KEY = "tc-news:program-translations";
const MAX_PROGRAM_TRANSLATIONS = 20;

export interface ProgramTranslation {
  programId: string; // RadioProgram.id
  lang: string; // UI locale the translation targets (lib/i18n Locale value)
  title: string;
  // Same length and order as the program's segments at translation time.
  segmentTexts: string[];
  translatedAt: number; // epoch ms
  // Viewer-rendered audio for the *translated* script, mirroring
  // RadioProgram.audioCids/audioMime/audioVoice but living here instead of
  // on the program: translated audio is as local-only as the translated
  // text itself, so it must never ride the tc-news:program wire (which
  // serializes the whole RadioProgram, audio CIDs included). Absent until
  // the viewer renders it via ProgramView's audio button on the translated
  // variant. Same length/order as segmentTexts.
  audioCids?: string[];
  audioMime?: string;
  audioVoice?: string; // OpenAI voice id used at render time (display only)
}

function cacheKey(programId: string, lang: string): string {
  return `${programId}::${lang}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isProgramTranslation(value: unknown): value is ProgramTranslation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.programId === "string" &&
    typeof v.lang === "string" &&
    typeof v.title === "string" &&
    isStringArray(v.segmentTexts) &&
    typeof v.translatedAt === "number" &&
    (v.audioCids === undefined || isStringArray(v.audioCids)) &&
    (v.audioMime === undefined || typeof v.audioMime === "string") &&
    (v.audioVoice === undefined || typeof v.audioVoice === "string")
  );
}

function coerceProgramTranslation(value: unknown): ProgramTranslation | null {
  if (!isProgramTranslation(value)) return null;
  return {
    programId: value.programId,
    lang: value.lang,
    title: value.title,
    segmentTexts: value.segmentTexts,
    translatedAt: value.translatedAt,
    audioCids: value.audioCids,
    audioMime: value.audioMime,
    audioVoice: value.audioVoice,
  };
}

function loadAll(): Record<string, ProgramTranslation> {
  try {
    const raw = kvGetSync(PROGRAM_TRANSLATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ProgramTranslation> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const record = coerceProgramTranslation(v);
      if (record) out[k] = record;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAll(all: Record<string, ProgramTranslation>): void {
  // Same byte-level safety net as partialFeedTranslationStore.ts's
  // persistAll: the mist KV rejects any single value over ~1MiB, and
  // MAX_PROGRAM_TRANSLATIONS alone doesn't bound byte size (a long program
  // with many segments can already carry a fair amount of translated text
  // per entry). Trim oldest-first (by translatedAt) until the serialized
  // blob is back under the soft limit.
  let entries = Object.entries(all);
  let serialized = JSON.stringify(Object.fromEntries(entries));
  while (entries.length > 0 && utf8ByteLength(serialized) > KV_VALUE_SOFT_LIMIT_BYTES) {
    entries = entries.sort((a, b) => b[1].translatedAt - a[1].translatedAt).slice(0, -1);
    serialized = JSON.stringify(Object.fromEntries(entries));
  }
  kvSetSync(PROGRAM_TRANSLATIONS_KEY, serialized);
}

/** 番組×言語の翻訳(あれば)。無ければnull — 呼び出し側はLLM翻訳を実行する合図として使う。 */
export function getProgramTranslation(programId: string, lang: string): ProgramTranslation | null {
  return loadAll()[cacheKey(programId, lang)] ?? null;
}

/**
 * 翻訳を保存する。上限件数を超えたら古いエントリ(translatedAtが古い順)から間引く。
 */
export function saveProgramTranslation(record: ProgramTranslation): void {
  const all = loadAll();
  all[cacheKey(record.programId, record.lang)] = record;
  const entries = Object.entries(all);
  if (entries.length > MAX_PROGRAM_TRANSLATIONS) {
    entries.sort((a, b) => b[1].translatedAt - a[1].translatedAt);
    persistAll(Object.fromEntries(entries.slice(0, MAX_PROGRAM_TRANSLATIONS)));
  } else {
    persistAll(all);
  }
}

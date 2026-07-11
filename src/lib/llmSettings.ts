// Local (non-shared) settings for tc-news: which shared preset (see
// lib/llmConfig.ts) plays which app-specific role, plus two purely local
// toggles (TTS enabled, AI Network consumer enabled). The actual connection
// info (providers) and model configs (presets) now live in the co-owned
// tc-shared-llm-config-v1 key so they're reusable across the tik-choco app
// family — see lib/llmConfig.ts and
// protocol/docs/data-contracts/docs/llm-config.md ("アプリローカル層の指針").
// This module only owns the "which preset for which tc-news feature" mapping,
// plus the one-time migration of tc-news' old per-app profile/tts/network
// settings into the shared key.
//
// Persisted to localStorage as JSON under the same key tc-news always used
// (`tc-news:provider-settings`), parsed defensively. A stored record still
// carrying the legacy shape (`profiles`/`defaultProfileId`/`tts.baseUrl`/
// `networkRoomId`/...) is migrated into the shared key on first load after
// this version ships, then immediately re-persisted in the new shape — so
// the migration only ever runs once per browser (detected by the presence of
// the `profiles` key, which the new shape never has).

import { emptyLlmConfig, ensurePreset, ensureProvider, loadLlmConfig, normalizeBaseUrl, saveLlmConfig } from "./llmConfig";

const SETTINGS_KEY = "tc-news:provider-settings";

/** reasoning_effort の選択肢。空文字はパラメータを送らない選択を表す。 */
export const REASONING_EFFORT_OPTIONS: string[] = ["none", "low", "medium", "high"];

/** 新規プリセット作成時の既定 reasoning_effort — 思考なしで応答を速くするため "none"。 */
export const DEFAULT_REASONING_EFFORT = "none";

/** tc-news固有のローカル設定。接続情報(provider)・モデル設定(preset)自体は共有キー
 * tc-shared-llm-config-v1(lib/llmConfig.ts)にあり、ここは「どの機能でどのpresetを
 * 使うか」というアプリ固有のポインタだけを持つ。 */
export interface ProviderSettings {
  /** OpenAI互換TTSを使うか。無効(既定)ならブラウザ内蔵TTSにフォールバックする。 */
  ttsEnabled: boolean;
  /** AI NetworkルームへLLM呼び出しを流すか(lib/network.ts)。 */
  networkConsumerEnabled: boolean;
  /** 編集部生成のorchestrator役に使うpreset id。""はdefaultPresetIdに従う。 */
  orchestratorPresetId: string;
  /** 編集部生成のworker役に使うpreset id。""はdefaultPresetIdに従う。 */
  workerPresetId: string;
}

function defaultProviderSettings(): ProviderSettings {
  return {
    ttsEnabled: false,
    networkConsumerEnabled: false,
    orchestratorPresetId: "",
    workerPresetId: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSettings(value: Record<string, unknown>): ProviderSettings {
  return {
    ttsEnabled: value.ttsEnabled === true,
    networkConsumerEnabled: value.networkConsumerEnabled === true,
    orchestratorPresetId: typeof value.orchestratorPresetId === "string" ? value.orchestratorPresetId : "",
    workerPresetId: typeof value.workerPresetId === "string" ? value.workerPresetId : "",
  };
}

// ---- one-time legacy migration --------------------------------------------

interface LegacyProfile {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningEffort?: string;
}

// Mirrors the old sanitizeProfile()'s defensive field-by-field coercion so a
// legacy record saved by any earlier version of tc-news still migrates
// cleanly, even if it predates a shape change.
function sanitizeLegacyProfile(value: unknown): LegacyProfile | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  const temperature =
    typeof value.temperature === "number" && Number.isFinite(value.temperature) ? value.temperature : 0.7;
  const reasoningEffort =
    typeof value.reasoningEffort === "string" &&
    (value.reasoningEffort === "" || REASONING_EFFORT_OPTIONS.includes(value.reasoningEffort))
      ? value.reasoningEffort
      : DEFAULT_REASONING_EFFORT;
  return {
    id,
    label: typeof value.label === "string" ? value.label : id,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    model: typeof value.model === "string" ? value.model : "",
    temperature: Math.min(2, Math.max(0, temperature)),
    reasoningEffort,
  };
}

interface LegacyTts {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
}

function sanitizeLegacyTts(value: unknown): LegacyTts {
  if (!isRecord(value)) return { baseUrl: "", apiKey: "", model: "", voice: "" };
  return {
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    model: typeof value.model === "string" ? value.model : "",
    voice: typeof value.voice === "string" ? value.voice : "",
  };
}

const PRISTINE_DEFAULT_BASE_URL = normalizeBaseUrl("http://localhost:1234/v1");

/** そのブラウザで一度も編集されていない、旧初回起動時のままの既定プロファイルか。
 * 中身が空同然のプロファイルを共有設定へノイズとして持ち込まないためのガード
 * (バグ #migration-policy: 「pristine-defaultはスキップ」)。 */
function isPristineDefaultProfile(profile: LegacyProfile): boolean {
  return (
    normalizeBaseUrl(profile.baseUrl) === PRISTINE_DEFAULT_BASE_URL &&
    profile.apiKey.trim() === "" &&
    profile.model.trim() === ""
  );
}

/**
 * 旧ローカル設定(`profiles`/`defaultProfileId`/`tts`/`networkRoomId` を持つ形)
 * を検出したときに一度だけ走る移行処理。各プロファイルはprovider+presetへ(id を
 * 保持したまま)分解して共有キーへ追加し(ensureProvider/ensurePreset は
 * dedupe-or-append のみで既存エントリを消さない)、defaultPresetId/tts/
 * network.roomId は現在値が空のときだけ埋める — 複数アプリが同時に移行しても
 * 互いの設定を消し合わないための「merge-never-delete」規則
 * (protocol/docs/data-contracts/docs/llm-config.md 参照)。ロール参照
 * (orchestrator/worker)とnetworkConsumerEnabled/tts.enabledはtc-news固有の
 * ローカル値なので、そのまま新形式へ運ぶ。
 */
function migrateLegacySettings(raw: Record<string, unknown>): ProviderSettings {
  const cfg = loadLlmConfig() ?? emptyLlmConfig();

  const legacyProfiles = Array.isArray(raw.profiles)
    ? raw.profiles.map(sanitizeLegacyProfile).filter((p): p is LegacyProfile => p !== null)
    : [];
  const migratedIds = new Set<string>();
  for (const profile of legacyProfiles) {
    if (isPristineDefaultProfile(profile)) continue;
    const providerId = ensureProvider(cfg, { label: profile.label, baseUrl: profile.baseUrl, apiKey: profile.apiKey });
    ensurePreset(cfg, {
      id: profile.id,
      label: profile.label,
      providerId,
      model: profile.model,
      temperature: profile.temperature,
      ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    });
    migratedIds.add(profile.id);
  }

  // Only point defaultPresetId at the migrated default profile if it was
  // actually migrated (not skipped as pristine) — otherwise leave
  // defaultPresetId alone (resolvePreset() falls back gracefully either way).
  const legacyDefaultProfileId = typeof raw.defaultProfileId === "string" ? raw.defaultProfileId : "";
  if (cfg.defaultPresetId === "" && migratedIds.has(legacyDefaultProfileId)) {
    cfg.defaultPresetId = legacyDefaultProfileId;
  }

  const legacyTts = sanitizeLegacyTts(raw.tts);
  if (!cfg.tts) {
    if (legacyTts.baseUrl.trim() !== "") {
      const ttsProviderId = ensureProvider(cfg, { baseUrl: legacyTts.baseUrl, apiKey: legacyTts.apiKey });
      cfg.tts = { providerId: ttsProviderId, model: legacyTts.model };
      if (legacyTts.voice.trim() !== "") cfg.tts.voice = legacyTts.voice;
    } else if (legacyTts.model.trim() !== "") {
      cfg.tts = { model: legacyTts.model };
      if (legacyTts.voice.trim() !== "") cfg.tts.voice = legacyTts.voice;
    }
  }

  const legacyRoomId = typeof raw.networkRoomId === "string" ? raw.networkRoomId.trim() : "";
  if (cfg.network.roomId === "" && legacyRoomId !== "") {
    cfg.network.roomId = legacyRoomId;
  }

  saveLlmConfig(cfg);

  const rolePointer = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    ttsEnabled: isRecord(raw.tts) && raw.tts.enabled === true,
    networkConsumerEnabled: raw.networkConsumerEnabled === true,
    orchestratorPresetId: rolePointer(raw.orchestratorProfileId),
    workerPresetId: rolePointer(raw.workerProfileId),
  };
}

export function loadProviderSettings(): ProviderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultProviderSettings();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return defaultProviderSettings();
    if ("profiles" in parsed) {
      const migrated = migrateLegacySettings(parsed);
      saveProviderSettings(migrated);
      return migrated;
    }
    return sanitizeSettings(parsed);
  } catch {
    return defaultProviderSettings();
  }
}

export function saveProviderSettings(settings: ProviderSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("tc-news: failed to persist provider settings", error);
  }
}

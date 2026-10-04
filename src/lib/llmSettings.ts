import {
  createProvider, createRoomProvider, emptyLlmConfig, isModelRef, loadLlmConfig,
  normalizeBaseUrl, patchProvider, presetIdToRef, providerKind, saveLlmConfig,
  type ModelRefV1, type SharedLlmConfigV1,
} from "./llmConfig";
import { isLlmConfigCorrupted } from "./llmConfigStore";
import { REASONING_EFFORT_OPTIONS, type LlmLocalSettings, type TaskModelV1, type ReasoningEffort } from "@tik-choco/mistai/preact";
import { safeSetItem } from "./safeStorage";

const SETTINGS_KEY = "tc-news:provider-settings";
export type ProviderSettings = LlmLocalSettings;
export type TaskId = "default" | "orchestrator" | "worker";
const TASK_IDS: TaskId[] = ["default", "orchestrator", "worker"];
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const effort = (v: unknown): ReasoningEffort => REASONING_EFFORT_OPTIONS.includes(v as ReasoningEffort) ? v as ReasoningEffort : "none";
const defaults = (): ProviderSettings => ({ tasks: Object.fromEntries(TASK_IDS.map(id => [id, { reasoningEffort: "none" }])), roomProvide: {}, recentModels: [] });

function sanitize(raw: Record<string, any>): ProviderSettings {
  const next = defaults();
  for (const id of TASK_IDS) {
    const task = record(raw.tasks?.[id]) ? raw.tasks[id] : {};
    next.tasks[id] = { ...(isModelRef(task.ref) ? { ref: task.ref } : {}), reasoningEffort: effort(task.reasoningEffort) };
  }
  if (record(raw.roomProvide)) for (const [id, room] of Object.entries(raw.roomProvide)) {
    if (record(room)) next.roomProvide[id] = { enabled: room.enabled === true, shared: Array.isArray(room.shared) ? room.shared.filter(isModelRef) : [] };
  }
  next.recentModels = Array.isArray(raw.recentModels) ? raw.recentModels.filter(isModelRef).filter((ref: ModelRefV1, i: number, refs: ModelRefV1[]) => refs.findIndex(r => r.providerId === ref.providerId && r.model === ref.model) === i).slice(0, 8) : [];
  return next;
}

// Very old profiles are imported directly as refs, without creating new legacy presets.
function importProfiles(cfg: SharedLlmConfigV1, raw: Record<string, any>) {
  const refs = new Map<string, ModelRefV1>();
  const ensure = (baseUrl: string, apiKey: string, label = baseUrl) => {
    const url = normalizeBaseUrl(baseUrl);
    const existing = cfg.providers.find(p => normalizeBaseUrl(p.baseUrl) === url && p.apiKey === apiKey);
    if (existing) return existing.id;
    const id = createProvider(cfg, label);
    patchProvider(cfg, id, { baseUrl: url, apiKey });
    return id;
  };
  for (const profile of Array.isArray(raw.profiles) ? raw.profiles : []) {
    if (!record(profile) || typeof profile.id !== "string" || typeof profile.baseUrl !== "string" || !profile.baseUrl.trim()) continue;
    if (normalizeBaseUrl(profile.baseUrl) === "http://localhost:1234/v1" && !profile.apiKey && !profile.model) continue;
    const providerId = ensure(profile.baseUrl, typeof profile.apiKey === "string" ? profile.apiKey : "", profile.label);
    const model = typeof profile.model === "string" ? profile.model : "";
    refs.set(profile.id, { providerId, model });
    const provider = cfg.providers.find(p => p.id === providerId)!;
    if (model && !provider.modelsFetchedAt) provider.models = [...new Set([...(provider.models ?? []), model])];
  }
  if (!cfg.defaultModel) cfg.defaultModel = refs.get(raw.defaultProfileId);
  if (!cfg.tts && record(raw.tts) && typeof raw.tts.model === "string" && raw.tts.model) {
    const providerId = raw.tts.baseUrl ? ensure(raw.tts.baseUrl, raw.tts.apiKey ?? "") : cfg.defaultModel?.providerId;
    cfg.tts = { providerId, model: raw.tts.model, ...(raw.tts.voice ? { voice: raw.tts.voice } : {}) };
  }
  return refs;
}

export function loadProviderSettings(): ProviderSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    if (!record(raw)) return defaults();
    if (record(raw.tasks)) return sanitize(raw);
    if (isLlmConfigCorrupted()) return defaults(); // Leave the migration sources available for a retry.
    const cfg = loadLlmConfig() ?? emptyLlmConfig();
    const previous = JSON.stringify(cfg);
    const profileRefs = importProfiles(cfg, raw);
    const next = defaults();
    const task = (id: unknown, ownEffort: unknown): TaskModelV1 => {
      const old = cfg.presets.find(p => p.id === id) ?? (Array.isArray(raw.profiles) ? raw.profiles.find(p => p.id === id) : undefined);
      const ref = typeof id === "string" ? profileRefs.get(id) ?? presetIdToRef(cfg, id) : undefined;
      return { ...(ref ? { ref } : {}), reasoningEffort: effort(ownEffort ?? old?.reasoningEffort) };
    };
    next.tasks.default = { reasoningEffort: task(raw.defaultProfileId ?? cfg.defaultPresetId, raw.defaultReasoningEffort).reasoningEffort };
    next.tasks.orchestrator = task(raw.orchestratorPresetId ?? raw.orchestratorProfileId, raw.orchestratorReasoningEffort);
    next.tasks.worker = task(raw.workerPresetId ?? raw.workerProfileId, raw.workerReasoningEffort);
    const roomId = cfg.network.roomId.trim() || (typeof raw.networkRoomId === "string" ? raw.networkRoomId.trim() : "");
    if (roomId) {
      const { id } = createRoomProvider(cfg, { roomId });
      const shared = (Array.isArray(raw.networkProviderPresetIds) ? raw.networkProviderPresetIds : []).map((id: string) => presetIdToRef(cfg, id)).filter((ref: ModelRefV1 | undefined): ref is ModelRefV1 => !!ref && cfg.providers.some(p => p.id === ref.providerId && providerKind(p) === "http"));
      next.roomProvide[id] = { enabled: raw.networkProviderEnabled === true, shared };
    }
    if (JSON.stringify(cfg) !== previous) saveLlmConfig(cfg);
    // Missing local data uses defaults without a gratuitous migration write.
    if (Object.keys(raw).length) saveProviderSettings(next);
    return next;
  } catch { return defaults(); }
}

export function saveProviderSettings(settings: ProviderSettings): boolean {
  const ok = safeSetItem(SETTINGS_KEY, JSON.stringify(settings));
  if (ok) for (const listener of listeners) listener(settings);
  return ok;
}
const listeners = new Set<(settings: ProviderSettings) => void>();
export function subscribeProviderSettings(listener: (settings: ProviderSettings) => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === SETTINGS_KEY) listener(loadProviderSettings()); };
  window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => { window.removeEventListener("storage", onStorage); listeners.delete(listener); };
}
export const localSettingsAdapter = {
  get: loadProviderSettings,
  set: saveProviderSettings,
  subscribe: (cb: () => void) => subscribeProviderSettings(() => cb()),
};

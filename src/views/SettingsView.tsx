// Settings screen: 全般 / AI接続 / AI Network / タスク の4タブ構成
// (tc-docs/drafts/llm-settings-common-v1.md — AI設定・AI Network設定・タスク設定
// の共通化ガイドv1のUI仕様に準拠。参照実装はtc-translateのSettingsModal).
//   - general: app-level prefs, persisted via props.onSettingsChange.
//   - connection: providers/presets — a flat card grid with click-to-open
//     inline editing (see server-list-header/model-row-list/model-row/
//     grid-add-tile in styles/settings-llm.css). Both "接続先" (LlmProviderV1)
//     and "モデル" (ModelPresetV1) grids are independent, not nested.
//   - network: AI Networkのconsumer(他者のLLMを使う)とprovider(自分のLLMを
//     提供する)。providerのライフサイクル本体はapp.tsx側
//     (hooks/useNetworkProviderHost.ts)がマウントし続けており、ここは
//     props.networkProvider(UseNetworkProviderResult)を表示するだけ —
//     設定画面を閉じても提供が途切れないようにするため。tc-newsのprovider
//     hookは単一の既定プリセットだけを提供する作り(モデル一覧の広告や
//     mist-network://疑似プロバイダの取り込みはない)なので、共有モデルの
//     チェックリストは持たない — 提供ON/OFFと状態パネルのみ。
//   - tasks: 既定/編集部:計画/編集部:執筆 の各preset+reasoning_effort、
//     および読み上げ(TTS)のモデル/ボイスピッカーを1画面に統合。常時表示の
//     説明段落は置かず、各行ラベルのhoverツールチップ(data-tip)に説明を持たせる。
//
// llm/network/tasksタブはどちらも2層の設定を編集する:
//   - the co-owned shared config tc-shared-llm-config-v1 (providers/presets/
//     tts/network.roomId — lib/llmConfig.ts), which other tik-choco apps on
//     the same origin read and write too, and which same-tab components
//     (e.g. the Onboarding overlay) also write to. Every edit here goes
//     through lib/llmConfigStore.ts's updateLlmConfig() — a read-modify-write
//     against the *current* storage value, never a stale in-memory `shared`
//     snapshot — and `shared` state is kept in sync via
//     subscribeLlmConfigStore() (same-tab writes + other tabs' storage
//     events; the vendored subscribeLlmConfig() only catches the latter, see
//     llmConfigStore.ts's header for why that's not enough here);
//   - tc-news' own local settings (which preset plays which role, plus the
//     ttsEnabled/networkConsumerEnabled/networkProviderEnabled toggles —
//     lib/llmSettings.ts), similarly subscribed via subscribeProviderSettings().
//
// The active tab is pure UI state — it must not gate any hook below (the
// consumer connection effect, the shared-config subscription, etc. all stay
// unconditional at the top of the component), so switching tabs never resets
// a live connection. Selected tab is remembered in localStorage (tc-town's
// SettingsView does the same — see ../tc-town/src/views/SettingsView.tsx).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  AlertTriangle,
  Cpu,
  Network,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  Sliders,
  Sparkles,
  X,
} from "lucide-preact";
import { MESSAGES_EN, MESSAGES_JA } from "@tik-choco/mistai";
import { ProviderStatusPanel } from "@tik-choco/mistai/preact";
import "@tik-choco/mistai/ui.css";
import type { AppSettings } from "../types";
import {
  emptyLlmConfig,
  loadLlmConfig,
  resolvePreset,
  type LlmProviderV1,
  type ModelPresetV1,
  type SharedLlmConfigV1,
} from "../lib/llmConfig";
import { isLlmConfigCorrupted, subscribeLlmConfigStore, updateLlmConfig } from "../lib/llmConfigStore";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  loadProviderSettings,
  saveProviderSettings,
  subscribeProviderSettings,
  type ProviderSettings,
} from "../lib/llmSettings";
import { requestOnboarding } from "../lib/onboarding";
import {
  connectNetworkConsumer,
  consumerStatus,
  disconnectNetworkConsumer,
  onConsumerStatusChange,
  type ConsumerStatus,
  type UseNetworkProviderResult,
} from "../lib/network";
import { useModelOptions, type ModelFetchStatus } from "../lib/models";
import { OPENAI_TTS_VOICES, useVoiceOptions } from "../lib/voices";
import { LOCALES, LOCALE_LABELS, useLocale, useT } from "../lib/i18n";
import { safeSetItem } from "../lib/safeStorage";
import "../styles/components.css";
import "../styles/settings.css";
import "../styles/settings-llm.css";

type SettingsTab = "general" | "connection" | "network" | "tasks";

const SETTINGS_TAB_IDS: SettingsTab[] = ["general", "connection", "network", "tasks"];
const SETTINGS_TAB_STORAGE_KEY = "tc-news:settings-tab";

/** Loads the last-active tab from localStorage, validated against the known
 * tab ids. Falls back to "general" if unset, malformed, or storage is
 * unavailable (private mode, etc.) — never throws. */
function loadSettingsTab(): SettingsTab {
  try {
    const raw = localStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
    if (raw && (SETTINGS_TAB_IDS as string[]).includes(raw)) return raw as SettingsTab;
  } catch {
    // localStorage unavailable — fall back to default.
  }
  return "general";
}

function saveSettingsTab(tab: SettingsTab): void {
  // Non-fatal on failure — the tab just won't be remembered next visit.
  safeSetItem(SETTINGS_TAB_STORAGE_KEY, tab);
}

function getHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** Dedupes `options` against the current `value` (so a manually-typed or
 * stale value stays selectable) and sorts for a stable <select> order. Shared
 * by ModelField and VoiceField. */
function mergeOptions(value: string, options: string[]): string[] {
  const merged = value.trim() ? [value, ...options] : options;
  return [...new Set(merged)].sort((a, b) => a.localeCompare(b));
}

/** Shared select + refresh + manual-entry markup behind ModelField and
 * VoiceField. Callers own their own fetch hook and status copy; this just
 * renders the widget. */
function ModelSelectField(props: {
  value: string;
  options: string[];
  status: ModelFetchStatus;
  statusText: string;
  canFetch: boolean;
  refresh: () => void;
  onChange: (value: string) => void;
  manualPlaceholder: string;
  refreshTitle: string;
  unselectedLabel: string;
}): JSX.Element {
  const { value, options, status, statusText, canFetch, refresh, onChange, manualPlaceholder, refreshTitle, unselectedLabel } =
    props;
  const t = useT();
  const [manualEntry, setManualEntry] = useState(false);

  return (
    <div class="model-field">
      {manualEntry ? (
        <input value={value} placeholder={manualPlaceholder} onInput={(e) => onChange(e.currentTarget.value)} />
      ) : (
        <div class="model-field-row">
          <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
            {value.trim() === "" ? <option value="">{unselectedLabel}</option> : null}
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="button"
            class={`icon-btn${status === "loading" ? " loading" : ""}`}
            onClick={refresh}
            disabled={status === "loading" || !canFetch}
            title={refreshTitle}
            aria-label={refreshTitle}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      )}
      <div class="model-field-footer">
        <span class="model-field-status">{statusText}</span>
        <button type="button" class="link-btn" onClick={() => setManualEntry((prev) => !prev)}>
          {manualEntry ? t("settings.modelSelectFromList") : t("settings.modelManualEntry")}
        </button>
      </div>
    </div>
  );
}

/** Model picker for a provider/preset card: a <select> populated from
 * useModelOptions(baseUrl, apiKey), a refresh button, and a manual-entry
 * fallback toggle for endpoints that can't list models. Exported so the
 * onboarding wizard's LLM step (components/Onboarding.tsx) can reuse it. */
export function ModelField(props: {
  value: string;
  baseUrl: string;
  apiKey: string;
  onChange: (model: string) => void;
}): JSX.Element {
  const { value, baseUrl, apiKey, onChange } = props;
  const t = useT();
  const { options, status, errorMessage, refresh } = useModelOptions(baseUrl, apiKey);

  const selectableOptions = useMemo(() => mergeOptions(value, options), [options, value]);
  const canFetch = baseUrl.trim().length > 0;
  const statusText =
    status === "loading"
      ? t("settings.modelLoading")
      : status === "error"
        ? errorMessage || t("settings.modelErrorFallback")
        : status === "done"
          ? t("settings.modelFetched", { count: options.length })
          : "";

  return (
    <ModelSelectField
      value={value}
      options={selectableOptions}
      status={status}
      statusText={statusText}
      canFetch={canFetch}
      refresh={refresh}
      onChange={onChange}
      manualPlaceholder="gpt-4o-mini"
      refreshTitle={t("settings.modelRefreshTitle")}
      unselectedLabel={t("settings.modelUnselected")}
    />
  );
}

/** Voice picker for the TTS section: mirrors ModelField's UX but sources
 * options from useVoiceOptions(baseUrl, apiKey). Most OpenAI-compatible TTS
 * endpoints don't expose a voices-listing endpoint, so on a fetch error we
 * fall back to OPENAI_TTS_VOICES (the standard OpenAI voice set) instead of
 * leaving the select empty. */
function VoiceField(props: {
  value: string;
  baseUrl: string;
  apiKey: string;
  onChange: (voice: string) => void;
}): JSX.Element {
  const { value, baseUrl, apiKey, onChange } = props;
  const t = useT();
  const { options, status, refresh } = useVoiceOptions(baseUrl, apiKey);

  const fetchedOrFallback = status === "error" ? OPENAI_TTS_VOICES : options;
  const selectableOptions = useMemo(() => mergeOptions(value, fetchedOrFallback), [fetchedOrFallback, value]);
  const canFetch = baseUrl.trim().length > 0;
  const statusText =
    status === "loading"
      ? t("settings.voiceLoading")
      : status === "error"
        ? t("settings.voiceErrorFallback")
        : status === "done"
          ? t("settings.voiceFetched", { count: options.length })
          : "";

  return (
    <ModelSelectField
      value={value}
      options={selectableOptions}
      status={status}
      statusText={statusText}
      canFetch={canFetch}
      refresh={refresh}
      onChange={onChange}
      manualPlaceholder="alloy"
      refreshTitle={t("settings.voiceRefreshTitle")}
      unselectedLabel={t("settings.modelUnselected")}
    />
  );
}

export function SettingsView(props: {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  networkProvider: UseNetworkProviderResult;
}): JSX.Element {
  const { settings, onSettingsChange, networkProvider } = props;
  const t = useT();
  const { locale, setLocale } = useLocale();

  // Pure UI state — must not gate any hook below (see header comment).
  const [tab, setTabState] = useState<SettingsTab>(() => loadSettingsTab());
  function setTab(next: SettingsTab): void {
    setTabState(next);
    saveSettingsTab(next);
  }

  // tc-news-local role pointers + toggles (lib/llmSettings.ts). Subscribed
  // (this tab + other tabs) so an external write to the same key — e.g. the
  // Onboarding overlay saving networkProviderEnabled — is reflected here too.
  const [provider, setProvider] = useState<ProviderSettings>(() => loadProviderSettings());
  useEffect(() => subscribeProviderSettings(setProvider), []);

  // The shared, co-owned config (lib/llmConfig.ts) — subscribed via
  // llmConfigStore's subscribeLlmConfigStore (not the vendored
  // subscribeLlmConfig) so an edit made from another tc-* app's tab, *or*
  // from another same-tab component (e.g. the Onboarding overlay), shows up
  // here without a reload. See llmConfigStore.ts's header for why the
  // vendored subscribeLlmConfig (storage-event only) isn't enough.
  const [shared, setShared] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());
  useEffect(() => subscribeLlmConfigStore((cfg) => setShared(cfg ?? emptyLlmConfig())), []);

  // Corrupted-record / write-failure banners (see llmConfigStore.ts). Once
  // corrupted it's assumed to stay that way until fixed elsewhere, so the
  // initial isLlmConfigCorrupted() check is enough; a later successful write
  // through applyLlmConfigUpdate clears it again (that write only succeeds
  // once the record is no longer corrupted).
  const [sharedConfigCorrupted, setSharedConfigCorrupted] = useState(() => isLlmConfigCorrupted());
  const [llmConfigSaveFailed, setLlmConfigSaveFailed] = useState(false);
  const [providerSettingsSaveFailed, setProviderSettingsSaveFailed] = useState(false);

  function updateGeneral(patch: Partial<AppSettings>) {
    onSettingsChange({ ...settings, ...patch });
  }

  function updateProvider(next: ProviderSettings) {
    setProvider(next);
    setProviderSettingsSaveFailed(!saveProviderSettings(next));
  }

  // Always a read-modify-write against the *current* storage value (never a
  // stale `shared` snapshot) — see llmConfigStore.ts's header for why: a
  // naive save-the-in-memory-state re-persists whatever `shared` happened to
  // be captured as, discarding any provider/preset another tab (or another
  // same-tab component) wrote in the meantime.
  function applyLlmConfigUpdate(mutate: (config: SharedLlmConfigV1) => void) {
    const result = updateLlmConfig(mutate);
    setShared(result.config);
    if (result.ok) {
      setLlmConfigSaveFailed(false);
      setSharedConfigCorrupted(false);
    } else if (result.reason === "corrupted") {
      setSharedConfigCorrupted(true);
    } else {
      setLlmConfigSaveFailed(true);
    }
  }

  function updateLlmProvider(id: string, patch: Partial<Omit<LlmProviderV1, "id">>) {
    applyLlmConfigUpdate((cfg) => {
      const target = cfg.providers.find((p) => p.id === id);
      if (target) Object.assign(target, patch);
    });
  }

  // A provider still referenced by a preset or by the shared TTS config can't
  // be deleted out from under them — the trash button is disabled instead.
  function providerInUse(id: string): boolean {
    return shared.presets.some((p) => p.providerId === id) || shared.tts?.providerId === id;
  }

  function deleteLlmProvider(id: string) {
    if (providerInUse(id)) return;
    applyLlmConfigUpdate((cfg) => {
      cfg.providers = cfg.providers.filter((p) => p.id !== id);
    });
  }

  function updatePreset(id: string, patch: Partial<Omit<ModelPresetV1, "id">>) {
    applyLlmConfigUpdate((cfg) => {
      const target = cfg.presets.find((p) => p.id === id);
      if (target) Object.assign(target, patch);
    });
  }

  function deletePreset(id: string) {
    applyLlmConfigUpdate((cfg) => {
      cfg.presets = cfg.presets.filter((p) => p.id !== id);
      // 削除したプリセットが既定だった場合、"" にせず残っているプリセットの
      // 先頭を新しい既定に昇格させる(残りがなければ ""=未設定)。
      if (cfg.defaultPresetId === id) {
        cfg.defaultPresetId = cfg.presets[0]?.id ?? "";
      }
    });
    // 役割ポインタが消えたプリセットを指したままにしない("" = 既定に従う)。
    if (provider.orchestratorPresetId === id || provider.workerPresetId === id) {
      updateProvider({
        ...provider,
        orchestratorPresetId: provider.orchestratorPresetId === id ? "" : provider.orchestratorPresetId,
        workerPresetId: provider.workerPresetId === id ? "" : provider.workerPresetId,
      });
    }
  }

  // TTS falls back to the default preset's provider when it doesn't specify
  // its own (see resolveVoice() in lib/llmConfig.ts) — mirror that here so
  // the model/voice pickers fetch against the right endpoint.
  const ttsProviderId = shared.tts?.providerId || shared.presets.find((p) => p.id === shared.defaultPresetId)?.providerId;
  const ttsProvider = shared.providers.find((p) => p.id === ttsProviderId);

  // ----- AI Network consumer connection lifecycle ---------------------------
  const [consumer, setConsumer] = useState<ConsumerStatus>(() => consumerStatus());
  useEffect(() => onConsumerStatusChange(setConsumer), []);

  const consumerRoom = shared.network.roomId.trim();
  useEffect(() => {
    if (!provider.networkConsumerEnabled || !consumerRoom) {
      disconnectNetworkConsumer();
      return;
    }
    // Debounced so typing a room id doesn't thrash the connection.
    const timer = setTimeout(() => void connectNetworkConsumer(consumerRoom), 500);
    return () => clearTimeout(timer);
  }, [provider.networkConsumerEnabled, consumerRoom]);

  function consumerStatusLabel(status: ConsumerStatus): string {
    switch (status.phase) {
      case "joining":
        return t("settings.networkStatusJoining");
      case "searching":
        return t("settings.networkStatusSearching");
      case "connected":
        return t("settings.networkStatusConnected", {
          models: status.models?.length ? status.models.join(", ") : "-",
        });
      case "error":
        return t("settings.networkStatusError", { detail: status.message });
      default:
        return t("settings.networkStatusIdle");
    }
  }

  // ----- AI Network room id (shared config, blur/Enter commit) --------------
  const [roomIdDraft, setRoomIdDraft] = useState(shared.network.roomId);
  useEffect(() => {
    setRoomIdDraft(shared.network.roomId);
  }, [shared.network.roomId]);
  function commitRoomId() {
    const roomId = roomIdDraft.trim();
    if (roomId !== shared.network.roomId) {
      applyLlmConfigUpdate((cfg) => {
        cfg.network = { roomId };
      });
    }
  }

  // ----- AI Network provider (share this app's LLM) -------------------------
  // The provider's connect/serve lifecycle itself lives in app.tsx
  // (hooks/useNetworkProviderHost.ts) so it keeps running while this settings
  // screen is closed; props.networkProvider is just the live status to render.
  const target = useMemo(() => resolvePreset(shared), [shared]);
  const upstreamConfigured = Boolean(target && target.model.trim() && target.baseUrl.trim());

  // ===== AI接続タブ: 接続先(provider) / モデル(preset) の独立したカードグリッド =====
  // providerId -> fetched models... is delegated entirely to ModelField's own
  // useModelOptions hook (fetch-on-mount + refresh button), so no extra
  // provider-level fetch state is needed here — only which single inline row
  // (edit or add) is currently open.
  const [editingProviderId, setEditingProviderId] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [npLabel, setNpLabel] = useState("");
  const [npBaseUrl, setNpBaseUrl] = useState("");
  const [npApiKey, setNpApiKey] = useState("");

  const [editingPresetId, setEditingPresetId] = useState("");
  const [addingModel, setAddingModel] = useState(false);
  const [amLabel, setAmLabel] = useState("");
  const [amProviderId, setAmProviderId] = useState("");
  const [amModel, setAmModel] = useState("");

  function closeAllInlineRows(): void {
    setEditingProviderId("");
    setAddingProvider(false);
    setEditingPresetId("");
    setAddingModel(false);
  }

  // If the entity currently being edited disappears (e.g. removed from
  // another tab/app via the shared config), close its inline row instead of
  // leaving it editing a value that no longer exists.
  useEffect(() => {
    if (editingProviderId && !shared.providers.some((p) => p.id === editingProviderId)) setEditingProviderId("");
    if (editingPresetId && !shared.presets.some((p) => p.id === editingPresetId)) setEditingPresetId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared.providers, shared.presets]);

  // Every inline row commits on blur/selection rather than an explicit
  // "決定" button, so the only remaining way to close a row that's just had
  // its label tweaked is clicking outside it (or Escape).
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const mouseDownInsideRef = useRef(false);
  useEffect(() => {
    if (!editingProviderId && !addingProvider && !editingPresetId && !addingModel) return undefined;

    function handleDocumentMouseDown(event: MouseEvent): void {
      mouseDownInsideRef.current = Boolean(activeRowRef.current && activeRowRef.current.contains(event.target as Node));
    }
    function handleDocumentClick(event: MouseEvent): void {
      if (activeRowRef.current && activeRowRef.current.contains(event.target as Node)) return;
      if (mouseDownInsideRef.current) return;
      closeAllInlineRows();
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") closeAllInlineRows();
    }

    document.addEventListener("mousedown", handleDocumentMouseDown);
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [editingProviderId, addingProvider, editingPresetId, addingModel]);

  function handleOpenEditProvider(llmProvider: LlmProviderV1): void {
    closeAllInlineRows();
    setEditingProviderId(llmProvider.id);
  }

  function handleOpenAddProvider(): void {
    closeAllInlineRows();
    setAddingProvider(true);
    setNpLabel("");
    setNpBaseUrl("");
    setNpApiKey("");
  }

  function handleSaveNewProvider(): void {
    const baseUrl = npBaseUrl.trim().replace(/\/$/, "");
    if (!baseUrl) return;
    applyLlmConfigUpdate((cfg) => {
      cfg.providers.push({
        id: crypto.randomUUID(),
        label: npLabel.trim(),
        baseUrl,
        apiKey: npApiKey,
      });
    });
    setAddingProvider(false);
  }

  function handleRemoveProviderRow(llmProvider: LlmProviderV1): void {
    if (providerInUse(llmProvider.id)) return;
    deleteLlmProvider(llmProvider.id);
    if (editingProviderId === llmProvider.id) setEditingProviderId("");
    if (amProviderId === llmProvider.id) {
      setAddingModel(false);
      setAmProviderId("");
      setAmModel("");
    }
  }

  function handleOpenAddModel(): void {
    closeAllInlineRows();
    setAddingModel(true);
    setAmLabel("");
    setAmProviderId(shared.providers[0]?.id ?? "");
    setAmModel("");
  }

  function handleSaveAddModel(model: string): void {
    if (!amProviderId || !model.trim()) return;
    applyLlmConfigUpdate((cfg) => {
      const preset: ModelPresetV1 = {
        id: crypto.randomUUID(),
        label: amLabel.trim() || model.trim(),
        providerId: amProviderId,
        model: model.trim(),
        temperature: 0.7,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
      };
      cfg.presets.push(preset);
      if (cfg.defaultPresetId === "") cfg.defaultPresetId = preset.id;
    });
    setAddingModel(false);
  }

  function handleOpenEditPreset(preset: ModelPresetV1): void {
    closeAllInlineRows();
    setEditingPresetId(preset.id);
  }

  function getPresetBadges(preset: ModelPresetV1): string[] {
    const badges: string[] = [];
    if (shared.defaultPresetId === preset.id) badges.push(t("settings.presetBadgeDefault"));
    if (provider.orchestratorPresetId === preset.id) badges.push(t("settings.presetBadgeOrchestrator"));
    if (provider.workerPresetId === preset.id) badges.push(t("settings.presetBadgeWorker"));
    if (shared.tts?.model && shared.tts.providerId === preset.providerId && shared.tts.model === preset.model) {
      badges.push(t("settings.presetBadgeTts"));
    }
    return badges;
  }

  function renderProviderRow(llmProvider: LlmProviderV1) {
    const isEditing = editingProviderId === llmProvider.id;
    const inUse = providerInUse(llmProvider.id);

    if (isEditing) {
      return (
        <div class="model-row model-row-editing" key={llmProvider.id} ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input
              value={llmProvider.label}
              onInput={(e) => updateLlmProvider(llmProvider.id, { label: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder={t("settings.labelPlaceholder")}
              autoComplete="off"
            />
            <input
              value={llmProvider.baseUrl}
              title={llmProvider.baseUrl}
              onInput={(e) => updateLlmProvider(llmProvider.id, { baseUrl: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="http://localhost:1234/v1"
              autoComplete="off"
            />
            <input
              type="password"
              value={llmProvider.apiKey}
              onInput={(e) => updateLlmProvider(llmProvider.id, { apiKey: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>
        </div>
      );
    }

    return (
      <div class="model-row" key={llmProvider.id}>
        <button type="button" class="model-row-main" onClick={() => handleOpenEditProvider(llmProvider)}>
          <span class="model-row-label">{llmProvider.label || getHostLabel(llmProvider.baseUrl)}</span>
          <span class="model-row-model">{getHostLabel(llmProvider.baseUrl)}</span>
        </button>
        <button
          type="button"
          class="model-row-remove"
          onClick={(e) => {
            e.stopPropagation();
            handleRemoveProviderRow(llmProvider);
          }}
          disabled={inUse}
          title={inUse ? t("settings.deleteConnectionInUse") : t("settings.deleteConnectionTitle")}
          aria-label={t("settings.deleteConnectionAria")}
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  function renderAddProviderTile() {
    if (addingProvider) {
      return (
        <div class="model-row model-row-editing model-row-add" ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input
              value={npLabel}
              onInput={(e) => setNpLabel(e.currentTarget.value)}
              placeholder={t("settings.labelPlaceholder")}
              autoComplete="off"
            />
            <input
              value={npBaseUrl}
              onInput={(e) => setNpBaseUrl(e.currentTarget.value)}
              placeholder="http://localhost:1234/v1"
              autoComplete="off"
            />
            <input
              type="password"
              value={npApiKey}
              onInput={(e) => setNpApiKey(e.currentTarget.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>
          <div class="model-row-add-actions">
            <button
              type="button"
              class="connection-form-btn connection-form-btn-primary"
              onClick={handleSaveNewProvider}
              disabled={!npBaseUrl.trim()}
            >
              <Plus size={13} /> {t("settings.add")}
            </button>
            <button type="button" class="connection-form-btn" onClick={() => setAddingProvider(false)}>
              {t("settings.cancel")}
            </button>
          </div>
        </div>
      );
    }
    return (
      <button type="button" class="grid-add-tile" onClick={handleOpenAddProvider}>
        <Plus size={16} />
        <span>{t("settings.addConnectionTile")}</span>
      </button>
    );
  }

  function renderModelRow(preset: ModelPresetV1) {
    const isEditing = editingPresetId === preset.id;

    if (isEditing) {
      const presetProvider = shared.providers.find((p) => p.id === preset.providerId);
      return (
        <div class="model-row model-row-editing" key={preset.id} ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input
              value={preset.label}
              onInput={(e) => updatePreset(preset.id, { label: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder={t("settings.labelPlaceholder")}
              autoComplete="off"
            />
            <select value={preset.providerId} onChange={(e) => updatePreset(preset.id, { providerId: e.currentTarget.value })}>
              {shared.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || getHostLabel(p.baseUrl)}
                </option>
              ))}
            </select>
            <div class="connection-form-model-field">
              <ModelField
                value={preset.model}
                baseUrl={presetProvider?.baseUrl ?? ""}
                apiKey={presetProvider?.apiKey ?? ""}
                onChange={(model) => updatePreset(preset.id, { model })}
              />
            </div>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={preset.temperature ?? 0.7}
              onInput={(e) => {
                const parsed = Number.parseFloat(e.currentTarget.value);
                updatePreset(preset.id, { temperature: Number.isFinite(parsed) ? parsed : 0.7 });
              }}
              aria-label={t("settings.temperature")}
              title={t("settings.temperature")}
            />
            <select
              value={preset.reasoningEffort || "none"}
              onChange={(e) => updatePreset(preset.id, { reasoningEffort: e.currentTarget.value })}
              aria-label={t("settings.reasoningEffort")}
              title={t("settings.reasoningEffort")}
            >
              {REASONING_EFFORT_OPTIONS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </div>
        </div>
      );
    }

    const badges = getPresetBadges(preset);
    return (
      <div class="model-row" key={preset.id}>
        <button type="button" class="model-row-main" onClick={() => handleOpenEditPreset(preset)}>
          <span class="model-row-label">{preset.label}</span>
          <span class="model-row-model">{preset.model || t("settings.modelUnselected")}</span>
          <span class="model-row-provider">
            {shared.providers.find((p) => p.id === preset.providerId)?.label ?? ""}
          </span>
        </button>
        {badges.length > 0 ? (
          <span class="model-row-badges">
            {badges.map((badge) => (
              <span key={badge} class="task-badge">
                {badge}
              </span>
            ))}
          </span>
        ) : null}
        <button
          type="button"
          class="model-row-remove"
          onClick={(e) => {
            e.stopPropagation();
            deletePreset(preset.id);
            if (editingPresetId === preset.id) setEditingPresetId("");
          }}
          title={t("settings.deletePresetTitle")}
          aria-label={t("settings.deletePresetAria")}
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  function renderAddModelTile() {
    if (shared.providers.length === 0) {
      return (
        <button type="button" class="grid-add-tile" disabled title={t("settings.addModelNeedConnection")}>
          <Plus size={16} />
          <span>{t("settings.addModelTile")}</span>
        </button>
      );
    }
    if (addingModel) {
      return (
        <div class="model-row model-row-editing model-row-add" ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input
              value={amLabel}
              onInput={(e) => setAmLabel(e.currentTarget.value)}
              placeholder={t("settings.labelPlaceholder")}
              autoComplete="off"
            />
            <select value={amProviderId} onChange={(e) => setAmProviderId(e.currentTarget.value)}>
              <option value="" disabled>
                {t("settings.selectConnectionPlaceholder")}
              </option>
              {shared.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || getHostLabel(p.baseUrl)}
                </option>
              ))}
            </select>
            <div class="connection-form-model-field">
              <ModelField
                value={amModel}
                baseUrl={shared.providers.find((p) => p.id === amProviderId)?.baseUrl ?? ""}
                apiKey={shared.providers.find((p) => p.id === amProviderId)?.apiKey ?? ""}
                onChange={(model) => {
                  setAmModel(model);
                  if (model.trim()) handleSaveAddModel(model);
                }}
              />
            </div>
          </div>
          <div class="model-row-add-actions">
            <button type="button" class="connection-form-btn" onClick={() => setAddingModel(false)}>
              {t("settings.cancel")}
            </button>
          </div>
        </div>
      );
    }
    return (
      <button type="button" class="grid-add-tile" onClick={handleOpenAddModel}>
        <Plus size={16} />
        <span>{t("settings.addModelTile")}</span>
      </button>
    );
  }

  // ===== タスクタブ: 既定 / 編集部:計画 / 編集部:執筆 の preset+reasoning_effort =====
  // reasoning_effortはpreset自体が持つ値(共有config)を、そのタスクが実際に
  // 解決するpreset単位で編集する — resolvePreset()と同じフォールバック規則
  // ("" = 既定プリセットに従う)を使うので、既定と役割が同じpresetを指している
  // 間は両方の行が同じ値を表示・編集する。
  function renderReasoningEffortSelect(resolved: { presetId: string; reasoningEffort?: string } | null) {
    return (
      <div class="task-model-field">
        <select
          value={resolved?.reasoningEffort || "none"}
          disabled={!resolved}
          onChange={(e) => {
            if (resolved) updatePreset(resolved.presetId, { reasoningEffort: e.currentTarget.value });
          }}
          aria-label={t("settings.reasoningEffort")}
          title={t("settings.reasoningEffort")}
        >
          {REASONING_EFFORT_OPTIONS.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const orchestratorResolved = resolvePreset(shared, provider.orchestratorPresetId);
  const workerResolved = resolvePreset(shared, provider.workerPresetId);
  const defaultResolved = resolvePreset(shared, shared.defaultPresetId);

  // ----- TTS task row: a single model picker (no engine select) -------------
  const ttsModelRaw = shared.tts?.model ?? "";
  const ttsProviderIdRaw = shared.tts?.providerId;
  const matchedTtsPreset = shared.presets.find(
    (p) => p.providerId === ttsProviderIdRaw && p.model === ttsModelRaw && ttsModelRaw !== "",
  );

  function handleTtsPickerChange(value: string): void {
    if (value === "__current__") return;
    if (value === "") {
      applyLlmConfigUpdate((cfg) => {
        cfg.tts = { model: "" };
      });
      updateProvider({ ...provider, ttsEnabled: false });
      return;
    }
    const preset = shared.presets.find((p) => p.id === value);
    if (!preset) return;
    applyLlmConfigUpdate((cfg) => {
      cfg.tts = { providerId: preset.providerId, model: preset.model };
    });
    updateProvider({ ...provider, ttsEnabled: true });
  }

  return (
    <div class="settings-view">
      <div class="settings-inner">
        <h1 class="settings-title">
          <SettingsIcon size={20} /> {t("settings.title")}
        </h1>

        <div class="settings-tabs" role="tablist" aria-label={t("settings.tabsAriaLabel")}>
          <button
            type="button"
            role="tab"
            id="settings-tab-general"
            aria-selected={tab === "general"}
            aria-controls="settings-panel-general"
            class={`settings-tab${tab === "general" ? " settings-tab--active" : ""}`}
            onClick={() => setTab("general")}
          >
            <Sliders size={14} /> {t("settings.tabGeneral")}
          </button>
          <button
            type="button"
            role="tab"
            id="settings-tab-connection"
            aria-selected={tab === "connection"}
            aria-controls="settings-panel-connection"
            class={`settings-tab${tab === "connection" ? " settings-tab--active" : ""}`}
            onClick={() => setTab("connection")}
          >
            <Plug size={14} /> {t("settings.tabConnection")}
          </button>
          <button
            type="button"
            role="tab"
            id="settings-tab-network"
            aria-selected={tab === "network"}
            aria-controls="settings-panel-network"
            class={`settings-tab${tab === "network" ? " settings-tab--active" : ""}`}
            onClick={() => setTab("network")}
          >
            <Network size={14} /> {t("settings.tabNetwork")}
          </button>
          <button
            type="button"
            role="tab"
            id="settings-tab-tasks"
            aria-selected={tab === "tasks"}
            aria-controls="settings-panel-tasks"
            class={`settings-tab${tab === "tasks" ? " settings-tab--active" : ""}`}
            onClick={() => setTab("tasks")}
          >
            <Cpu size={14} /> {t("settings.tabTasks")}
          </button>
        </div>

        {llmConfigSaveFailed || providerSettingsSaveFailed ? (
          <p class="settings-alert" role="alert">
            <AlertTriangle size={14} /> {t("settings.saveFailedWarning")}
          </p>
        ) : null}

        {tab === "general" ? (
          <section
            class="settings-section"
            role="tabpanel"
            id="settings-panel-general"
            aria-labelledby="settings-tab-general"
          >
            <h2 class="settings-heading">{t("settings.tabGeneral")}</h2>

            <label class="field">
              <span>{t("settings.language")}</span>
              <select value={locale} onChange={(e) => setLocale(e.currentTarget.value as typeof locale)}>
                {LOCALES.map((loc) => (
                  <option key={loc} value={loc}>
                    {LOCALE_LABELS[loc]}
                  </option>
                ))}
              </select>
            </label>

            <label class="field">
              <span>{t("settings.displayName")}</span>
              <input
                value={settings.userName}
                placeholder={t("common.anonymous")}
                onInput={(e) => updateGeneral({ userName: e.currentTarget.value })}
              />
            </label>

            <label class="field">
              <span>{t("settings.roomId")}</span>
              <input
                value={settings.roomId}
                placeholder="tc-news"
                onInput={(e) => updateGeneral({ roomId: e.currentTarget.value })}
              />
              <span class="field-hint">{t("settings.roomIdHint")}</span>
            </label>

            <label class="field">
              <span>{t("settings.corsProxy")}</span>
              <input
                value={settings.corsProxy}
                placeholder="https://corsproxy.io/?url="
                onInput={(e) => updateGeneral({ corsProxy: e.currentTarget.value })}
              />
              <span class="field-hint">{t("settings.corsProxyHint")}</span>
            </label>

            <label class="field">
              <span>{t("settings.refreshInterval")}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={settings.refreshIntervalMin}
                onInput={(e) => {
                  const parsed = Number.parseInt(e.currentTarget.value, 10);
                  updateGeneral({ refreshIntervalMin: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 });
                }}
              />
            </label>

            <label class="checkbox-field">
              <input
                type="checkbox"
                checked={settings.autoGenerate}
                onChange={(e) => updateGeneral({ autoGenerate: e.currentTarget.checked })}
              />
              <span>{t("settings.autoGenerate")}</span>
            </label>

            <label class="checkbox-field">
              <input
                type="checkbox"
                checked={settings.programRuby}
                onChange={(e) => updateGeneral({ programRuby: e.currentTarget.checked })}
              />
              <span>
                {t("settings.programRuby")}
                <br />
                <span class="field-hint">{t("settings.programRubyHint")}</span>
              </span>
            </label>

            <label class="checkbox-field">
              <input
                type="checkbox"
                checked={settings.globalShare}
                onChange={(e) => updateGeneral({ globalShare: e.currentTarget.checked })}
              />
              <span>
                {t("settings.globalShareLabel")}
                <br />
                <span class="field-hint">{t("settings.globalShareDesc")}</span>
              </span>
            </label>

            <label class="checkbox-field">
              <input
                type="checkbox"
                checked={settings.showMediaPreviews}
                onChange={(e) => updateGeneral({ showMediaPreviews: e.currentTarget.checked })}
              />
              <span>
                {t("settings.showMediaPreviews")}
                <br />
                <span class="field-hint">{t("settings.showMediaPreviewsHint")}</span>
              </span>
            </label>

            <h2 class="settings-heading">
              <Sparkles size={16} /> {t("onboarding.reopenTitle")}
            </h2>
            <p class="field-hint">{t("onboarding.reopenHint")}</p>
            <button type="button" class="btn btn-primary" onClick={requestOnboarding}>
              <Sparkles size={15} /> {t("onboarding.reopenButton")}
            </button>
          </section>
        ) : null}

        {tab === "connection" ? (
          <section
            class="settings-section"
            role="tabpanel"
            id="settings-panel-connection"
            aria-labelledby="settings-tab-connection"
          >
            <p class="field-hint">{t("settings.connectionHint")}</p>

            {sharedConfigCorrupted ? (
              <p class="settings-alert" role="alert">
                <AlertTriangle size={14} /> {t("settings.sharedConfigCorruptedWarning")}
              </p>
            ) : null}

            <div class="server-list-header">
              <label>{t("settings.connectionsHeading")}</label>
            </div>
            <div class="settings-flat-section settings-flat-section-connection">
              <div class="model-row-list">
                {shared.providers.map((llmProvider) => renderProviderRow(llmProvider))}
                {renderAddProviderTile()}
              </div>
            </div>

            <div class="server-list-header">
              <label>{t("settings.modelsHeading")}</label>
            </div>
            <div class="settings-flat-section settings-flat-section-models">
              <div class="model-row-list">
                {shared.presets.map((preset) => renderModelRow(preset))}
                {renderAddModelTile()}
              </div>
            </div>
          </section>
        ) : null}

        {tab === "network" ? (
          <section
            class="settings-section"
            role="tabpanel"
            id="settings-panel-network"
            aria-labelledby="settings-tab-network"
          >
            <p class="field-hint">{t("settings.networkTabHint")}</p>

            <label class="field">
              <span>{t("settings.networkRoomId")}</span>
              <input
                value={roomIdDraft}
                onInput={(e) => setRoomIdDraft(e.currentTarget.value)}
                onBlur={commitRoomId}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder={t("settings.networkRoomIdPlaceholder")}
              />
            </label>

            <div class="settings-role-group">
              <div class="settings-role-card">
                <label class="settings-role-head">
                  <input
                    type="checkbox"
                    checked={provider.networkConsumerEnabled}
                    onChange={(e) => updateProvider({ ...provider, networkConsumerEnabled: e.currentTarget.checked })}
                  />
                  <span class="settings-role-title">
                    <Network size={15} /> {t("settings.networkConsumerTitle")}
                  </span>
                </label>
                <p class="settings-role-desc">{t("settings.networkConsumerDesc")}</p>
                {provider.networkConsumerEnabled ? (
                  <div class="settings-role-body">
                    <p class="settings-role-desc" role="status">
                      {consumerStatusLabel(consumer)}
                    </p>
                  </div>
                ) : null}
              </div>

              <div class="settings-role-card">
                <label class="settings-role-head">
                  <input
                    type="checkbox"
                    checked={provider.networkProviderEnabled}
                    onChange={(e) => updateProvider({ ...provider, networkProviderEnabled: e.currentTarget.checked })}
                  />
                  <span class="settings-role-title">
                    <Server size={15} /> {t("settings.networkProviderTitle")}
                  </span>
                </label>
                <p class="settings-role-desc">{t("settings.networkProviderDesc")}</p>
                {provider.networkProviderEnabled ? (
                  <div class="settings-role-body">
                    <ProviderStatusPanel
                      status={networkProvider.status}
                      statusUpdatedAt={networkProvider.statusUpdatedAt}
                      errorMessage={networkProvider.errorMessage}
                      ownNodeId={networkProvider.ownNodeId}
                      peers={networkProvider.peers}
                      consumerCount={networkProvider.consumerCount}
                      logs={networkProvider.logs}
                      messages={locale === "ja" ? MESSAGES_JA : MESSAGES_EN}
                      notice={!upstreamConfigured ? <p class="settings-role-desc">{t("settings.networkProviderNotConfigured")}</p> : null}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {tab === "tasks" ? (
          <section
            class="settings-section"
            role="tabpanel"
            id="settings-panel-tasks"
            aria-labelledby="settings-tab-tasks"
          >
            <div class="task-model-item">
              <span data-tip={t("settings.taskTipDefault")}>{t("settings.taskDefaultLabel")}</span>
              <div class="task-model-fields">
                <div class="task-model-field">
                  <select
                    value={shared.defaultPresetId}
                    onChange={(e) => {
                      const defaultPresetId = e.currentTarget.value;
                      applyLlmConfigUpdate((cfg) => {
                        cfg.defaultPresetId = defaultPresetId;
                      });
                    }}
                    aria-label={t("settings.taskDefaultLabel")}
                  >
                    <option value="">{t("settings.defaultPresetUnset")}</option>
                    {shared.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label || p.id}
                      </option>
                    ))}
                  </select>
                </div>
                {renderReasoningEffortSelect(defaultResolved)}
              </div>
            </div>

            <div class="task-model-item">
              <span data-tip={t("settings.taskTipOrchestrator")}>{t("settings.taskOrchestratorLabel")}</span>
              <div class="task-model-fields">
                <div class="task-model-field">
                  <select
                    value={provider.orchestratorPresetId}
                    onChange={(e) => updateProvider({ ...provider, orchestratorPresetId: e.currentTarget.value })}
                    aria-label={t("settings.taskOrchestratorLabel")}
                  >
                    <option value="">{t("settings.taskFollowDefault")}</option>
                    {shared.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label || p.id}
                      </option>
                    ))}
                  </select>
                </div>
                {renderReasoningEffortSelect(orchestratorResolved)}
              </div>
            </div>

            <div class="task-model-item">
              <span data-tip={t("settings.taskTipWorker")}>{t("settings.taskWorkerLabel")}</span>
              <div class="task-model-fields">
                <div class="task-model-field">
                  <select
                    value={provider.workerPresetId}
                    onChange={(e) => updateProvider({ ...provider, workerPresetId: e.currentTarget.value })}
                    aria-label={t("settings.taskWorkerLabel")}
                  >
                    <option value="">{t("settings.taskFollowDefault")}</option>
                    {shared.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label || p.id}
                      </option>
                    ))}
                  </select>
                </div>
                {renderReasoningEffortSelect(workerResolved)}
              </div>
            </div>

            <div class="task-model-item">
              <span data-tip={t("settings.taskTipTts")}>{t("settings.taskTtsLabel")}</span>
              <div class="task-model-fields">
                <div class="task-model-field">
                  <select
                    value={ttsModelRaw === "" ? "" : matchedTtsPreset ? matchedTtsPreset.id : "__current__"}
                    onChange={(e) => handleTtsPickerChange(e.currentTarget.value)}
                    aria-label={t("settings.taskTtsLabel")}
                  >
                    <option value="">{t("settings.ttsPickerBrowserOption")}</option>
                    {ttsModelRaw && !matchedTtsPreset ? <option value="__current__">{ttsModelRaw}</option> : null}
                    {shared.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label || p.model || p.id}
                      </option>
                    ))}
                  </select>
                </div>
                {ttsModelRaw !== "" ? (
                  <div class="task-model-field">
                    <VoiceField
                      value={shared.tts?.voice ?? ""}
                      baseUrl={ttsProvider?.baseUrl ?? ""}
                      apiKey={ttsProvider?.apiKey ?? ""}
                      onChange={(voice) =>
                        applyLlmConfigUpdate((cfg) => {
                          const current = cfg.tts ?? { model: "" };
                          cfg.tts = { ...current, voice };
                        })
                      }
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

// Settings screen: 全般 / LLM / AI Network / 音声(TTS) の4タブ構成。
//   - general: app-level prefs, persisted via props.onSettingsChange.
//   - llm: providers/presets + default/orchestrator/worker role pointers.
//   - network: AI Networkのconsumer(他者のLLMを使う)とprovider(自分のLLMを
//     提供する)。providerのライフサイクル本体はapp.tsx側
//     (hooks/useNetworkProviderHost.ts)がマウントし続けており、ここは
//     props.networkProvider(UseNetworkProviderResult)を表示するだけ —
//     設定画面を閉じても提供が途切れないようにするため。
//   - tts: 読み上げ(TTS)の接続先。
//
// llm/network タブはどちらも2層の設定を編集する:
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
import { useEffect, useMemo, useState } from "preact/hooks";
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
  Trash2,
  Volume2,
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
  type VoiceConfigV1,
} from "../lib/llmConfig";
import { isLlmConfigCorrupted, subscribeLlmConfigStore, updateLlmConfig } from "../lib/llmConfigStore";
import {
  DEFAULT_REASONING_EFFORT,
  loadProviderSettings,
  REASONING_EFFORT_OPTIONS,
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

type SettingsTab = "general" | "llm" | "network" | "tts";

const SETTINGS_TAB_IDS: SettingsTab[] = ["general", "llm", "network", "tts"];
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

  // ----- Providers (shared) --------------------------------------------------
  function addLlmProvider() {
    const llmProvider: LlmProviderV1 = {
      id: crypto.randomUUID(),
      label: t("settings.newProviderLabel"),
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
    };
    applyLlmConfigUpdate((cfg) => {
      cfg.providers.push(llmProvider);
    });
  }

  function updateLlmProvider(id: string, patch: Partial<LlmProviderV1>) {
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

  // ----- Presets (shared) -----------------------------------------------------
  function addPreset() {
    const firstProvider = shared.providers[0];
    if (!firstProvider) return;
    const preset: ModelPresetV1 = {
      id: crypto.randomUUID(),
      label: t("settings.newPresetLabel"),
      providerId: firstProvider.id,
      model: "",
      temperature: 0.7,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    };
    applyLlmConfigUpdate((cfg) => {
      cfg.presets.push(preset);
      // 既定が未設定なら、初めて追加したプリセットを自動的に既定にする。
      if (cfg.defaultPresetId === "") cfg.defaultPresetId = preset.id;
    });
  }

  function updatePreset(id: string, patch: Partial<ModelPresetV1>) {
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

  // ----- TTS (shared VoiceConfigV1 + local enabled toggle) --------------------
  function updateTts(patch: Partial<VoiceConfigV1>) {
    applyLlmConfigUpdate((cfg) => {
      const current: VoiceConfigV1 = cfg.tts ?? { model: "" };
      cfg.tts = { ...current, ...patch };
    });
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

  // ----- AI Network provider (share this app's LLM) -------------------------
  // The provider's connect/serve lifecycle itself lives in app.tsx
  // (hooks/useNetworkProviderHost.ts) so it keeps running while this settings
  // screen is closed; props.networkProvider is just the live status to render.
  const target = useMemo(() => resolvePreset(shared), [shared]);
  const upstreamConfigured = Boolean(target && target.model.trim() && target.baseUrl.trim());

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
            id="settings-tab-llm"
            aria-selected={tab === "llm"}
            aria-controls="settings-panel-llm"
            class={`settings-tab${tab === "llm" ? " settings-tab--active" : ""}`}
            onClick={() => setTab("llm")}
          >
            <Cpu size={14} /> {t("settings.tabLlm")}
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
            id="settings-tab-tts"
            aria-selected={tab === "tts"}
            aria-controls="settings-panel-tts"
            class={`settings-tab${tab === "tts" ? " settings-tab--active" : ""}`}
            onClick={() => setTab("tts")}
          >
            <Volume2 size={14} /> {t("settings.tabTts")}
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

        {tab === "llm" ? (
          <section
            class="settings-section"
            role="tabpanel"
            id="settings-panel-llm"
            aria-labelledby="settings-tab-llm"
          >
            <p class="field-hint">{t("settings.llmHint")}</p>

            {sharedConfigCorrupted ? (
              <p class="settings-alert" role="alert">
                <AlertTriangle size={14} /> {t("settings.sharedConfigCorruptedWarning")}
              </p>
            ) : null}

            {/* ----- Providers (shared接続情報) ----------------------------- */}
            <div class="settings-heading-row">
              <h2 class="settings-heading">
                <Plug size={16} /> {t("settings.providersHeading")}
              </h2>
              <button type="button" class="btn btn-ghost" onClick={addLlmProvider}>
                <Plus size={15} /> {t("settings.addProvider")}
              </button>
            </div>
            <p class="field-hint">{t("settings.providersHint")}</p>

            <div class="profile-list">
              {shared.providers.map((llmProvider) => {
                const inUse = providerInUse(llmProvider.id);
                return (
                  <div key={llmProvider.id} class="profile-card">
                    <div class="profile-card-head">
                      <input
                        class="profile-card-label"
                        value={llmProvider.label}
                        placeholder={t("settings.providerNamePlaceholder")}
                        onInput={(e) => updateLlmProvider(llmProvider.id, { label: e.currentTarget.value })}
                      />
                      <button
                        type="button"
                        class="icon-btn danger"
                        onClick={() => deleteLlmProvider(llmProvider.id)}
                        disabled={inUse}
                        title={inUse ? t("settings.deleteProviderInUse") : t("settings.deleteProvider")}
                        aria-label={t("settings.deleteProviderAria")}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>

                    <label class="field">
                      <span>{t("settings.baseUrl")}</span>
                      <input
                        value={llmProvider.baseUrl}
                        placeholder="http://localhost:1234/v1"
                        onInput={(e) => updateLlmProvider(llmProvider.id, { baseUrl: e.currentTarget.value })}
                      />
                    </label>

                    <label class="field">
                      <span>{t("settings.apiKey")}</span>
                      <input
                        type="password"
                        value={llmProvider.apiKey}
                        placeholder="sk-..."
                        autocomplete="off"
                        onInput={(e) => updateLlmProvider(llmProvider.id, { apiKey: e.currentTarget.value })}
                      />
                    </label>
                  </div>
                );
              })}
            </div>

            {/* ----- Presets (shared モデル設定) ------------------------------ */}
            <div class="settings-heading-row">
              <h2 class="settings-heading">
                <Cpu size={16} /> {t("settings.presetsHeading")}
              </h2>
              <button type="button" class="btn btn-ghost" onClick={addPreset} disabled={shared.providers.length === 0}>
                <Plus size={15} /> {t("settings.addPreset")}
              </button>
            </div>
            <p class="field-hint">
              {shared.providers.length === 0 ? t("settings.noProvidersHint") : t("settings.presetsHint")}
            </p>

            <div class="profile-list">
              {shared.presets.map((preset) => {
                const presetProvider = shared.providers.find((p) => p.id === preset.providerId);
                return (
                  <div key={preset.id} class="profile-card">
                    <div class="profile-card-head">
                      <input
                        class="profile-card-label"
                        value={preset.label}
                        placeholder={t("settings.presetNamePlaceholder")}
                        onInput={(e) => updatePreset(preset.id, { label: e.currentTarget.value })}
                      />
                      {preset.id === shared.defaultPresetId ? (
                        <span class="badge">{t("settings.defaultBadge")}</span>
                      ) : null}
                      <button
                        type="button"
                        class="icon-btn danger"
                        onClick={() => deletePreset(preset.id)}
                        title={t("settings.deletePreset")}
                        aria-label={t("settings.deletePresetAria")}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>

                    <label class="field">
                      <span>{t("settings.presetProviderLabel")}</span>
                      <select
                        value={preset.providerId}
                        onChange={(e) => updatePreset(preset.id, { providerId: e.currentTarget.value })}
                      >
                        {shared.providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label || p.id}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label class="field">
                      <span>{t("settings.model")}</span>
                      <ModelField
                        value={preset.model}
                        baseUrl={presetProvider?.baseUrl ?? ""}
                        apiKey={presetProvider?.apiKey ?? ""}
                        onChange={(model) => updatePreset(preset.id, { model })}
                      />
                    </label>

                    <label class="field">
                      <span>{t("settings.temperature")}</span>
                      <input
                        type="number"
                        min={0}
                        max={2}
                        step={0.1}
                        value={preset.temperature ?? 0.7}
                        onInput={(e) => {
                          const parsed = Number.parseFloat(e.currentTarget.value);
                          updatePreset(preset.id, { temperature: Number.isFinite(parsed) ? parsed : 0.7 });
                        }}
                      />
                    </label>

                    <label class="field">
                      <span>{t("settings.reasoningEffort")}</span>
                      <select
                        value={preset.reasoningEffort ?? ""}
                        onChange={(e) => updatePreset(preset.id, { reasoningEffort: e.currentTarget.value })}
                      >
                        <option value="">{t("settings.reasoningEffortNone")}</option>
                        {REASONING_EFFORT_OPTIONS.map((effort) => (
                          <option key={effort} value={effort}>
                            {effort}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>

            <label class="field">
              <span>{t("settings.defaultPreset")}</span>
              <select
                value={shared.defaultPresetId}
                onChange={(e) => {
                  const defaultPresetId = e.currentTarget.value;
                  applyLlmConfigUpdate((cfg) => {
                    cfg.defaultPresetId = defaultPresetId;
                  });
                }}
              >
                <option value="">{t("settings.defaultPresetUnset")}</option>
                {shared.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.id}
                  </option>
                ))}
              </select>
            </label>

            <label class="field">
              <span>{t("settings.orchestratorPreset")}</span>
              <select
                value={provider.orchestratorPresetId}
                onChange={(e) => updateProvider({ ...provider, orchestratorPresetId: e.currentTarget.value })}
              >
                <option value="">{t("settings.roleFollowDefault")}</option>
                {shared.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.id}
                  </option>
                ))}
              </select>
              <span class="field-hint">{t("settings.orchestratorPresetHint")}</span>
            </label>

            <label class="field">
              <span>{t("settings.workerPreset")}</span>
              <select
                value={provider.workerPresetId}
                onChange={(e) => updateProvider({ ...provider, workerPresetId: e.currentTarget.value })}
              >
                <option value="">{t("settings.roleFollowDefault")}</option>
                {shared.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.id}
                  </option>
                ))}
              </select>
              <span class="field-hint">{t("settings.workerPresetHint")}</span>
            </label>
          </section>
        ) : null}

        {tab === "network" ? (
          <section
            class="settings-section"
            role="tabpanel"
            id="settings-panel-network"
            aria-labelledby="settings-tab-network"
          >
            <h2 class="settings-heading">
              <Network size={16} /> {t("settings.networkHeading")}
            </h2>
            <p class="field-hint">{t("settings.networkHint")}</p>

            <label class="field">
              <span>{t("settings.networkRoomId")}</span>
              <input
                value={shared.network.roomId}
                placeholder="tc-llm"
                onInput={(e) => {
                  const roomId = e.currentTarget.value;
                  applyLlmConfigUpdate((cfg) => {
                    cfg.network = { roomId };
                  });
                }}
              />
              <span class="field-hint">{t("settings.networkRoomIdHint")}</span>
            </label>

            {/* ----- Consumer: 共有された他者のLLMを利用する ------------------- */}
            <label class="checkbox-field">
              <input
                type="checkbox"
                checked={provider.networkConsumerEnabled}
                onChange={(e) => updateProvider({ ...provider, networkConsumerEnabled: e.currentTarget.checked })}
              />
              <span>{t("settings.networkConsumerEnabled")}</span>
            </label>

            {provider.networkConsumerEnabled ? (
              <p class="field-hint" role="status">
                {consumerStatusLabel(consumer)}
              </p>
            ) : null}

            {/* ----- Provider: 自分のLLMをAI Networkへ提供する ------------------- */}
            <div class="settings-divider" />

            <label class="checkbox-field checkbox-field--heading">
              <input
                type="checkbox"
                checked={provider.networkProviderEnabled}
                onChange={(e) => updateProvider({ ...provider, networkProviderEnabled: e.currentTarget.checked })}
              />
              <span>
                <Server size={14} /> {t("settings.networkProviderEnabled")}
              </span>
            </label>
            <p class="field-hint">{t("settings.networkProviderHint")}</p>

            {provider.networkProviderEnabled ? (
              <ProviderStatusPanel
                status={networkProvider.status}
                statusUpdatedAt={networkProvider.statusUpdatedAt}
                errorMessage={networkProvider.errorMessage}
                ownNodeId={networkProvider.ownNodeId}
                peers={networkProvider.peers}
                consumerCount={networkProvider.consumerCount}
                logs={networkProvider.logs}
                messages={locale === "ja" ? MESSAGES_JA : MESSAGES_EN}
                notice={!upstreamConfigured ? <p class="field-hint">{t("settings.networkProviderNotConfigured")}</p> : null}
              />
            ) : null}
          </section>
        ) : null}

        {tab === "tts" ? (
          <section
            class="settings-section"
            role="tabpanel"
            id="settings-panel-tts"
            aria-labelledby="settings-tab-tts"
          >
            <h2 class="settings-heading">
              <Volume2 size={16} /> {t("settings.ttsHeading")}
            </h2>
            <p class="field-hint">{t("settings.ttsHint")}</p>

            <label class="checkbox-field">
              <input
                type="checkbox"
                checked={provider.ttsEnabled}
                onChange={(e) => updateProvider({ ...provider, ttsEnabled: e.currentTarget.checked })}
              />
              <span>{t("settings.ttsEnabled")}</span>
            </label>

            <label class="field">
              <span>{t("settings.ttsProvider")}</span>
              <select
                value={shared.tts?.providerId ?? ""}
                onChange={(e) => updateTts({ providerId: e.currentTarget.value || undefined })}
              >
                <option value="">{t("settings.ttsProviderFollowDefault")}</option>
                {shared.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.id}
                  </option>
                ))}
              </select>
            </label>

            <label class="field">
              <span>{t("settings.model")}</span>
              <ModelField
                value={shared.tts?.model ?? ""}
                baseUrl={ttsProvider?.baseUrl ?? ""}
                apiKey={ttsProvider?.apiKey ?? ""}
                onChange={(model) => updateTts({ model })}
              />
            </label>

            <label class="field">
              <span>{t("settings.ttsVoice")}</span>
              <VoiceField
                value={shared.tts?.voice ?? ""}
                baseUrl={ttsProvider?.baseUrl ?? ""}
                apiKey={ttsProvider?.apiKey ?? ""}
                onChange={(voice) => updateTts({ voice })}
              />
            </label>
          </section>
        ) : null}
      </div>
    </div>
  );
}

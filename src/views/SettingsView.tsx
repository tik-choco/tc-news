import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { AlertTriangle, Fingerprint, Settings as SettingsIcon, Sliders, Sparkles, Cpu } from "lucide-preact";
import { MESSAGES_EN, MESSAGES_JA, formatMistaiError } from "@tik-choco/mistai";
import { LlmSettings, Switch } from "@tik-choco/mistai/preact";
import "@tik-choco/mistai/ui.css";
import { loadDelegationFor, subscribeDelegation, type DelegationV1 } from "@tik-choco/mistai/identity";
import { ensureDidIdentity } from "../crypto/didIdentity";
import { pairDidDelegation } from "../lib/didPairing";
import type { AppSettings } from "../types";
import { isLlmConfigCorrupted } from "../lib/llmConfigStore";
import { localSettingsAdapter } from "../lib/llmSettings";
import { requestOnboarding } from "../lib/onboarding";
import { LOCALES, LOCALE_LABELS, useLocale, useT } from "../lib/i18n";
import { AI_SETTINGS_MESSAGES, aiSettingsLocale } from "../lib/i18n/aiSettings";
import { safeSetItem } from "../lib/safeStorage";
import { RecommendationSettings } from "../components/RecommendationSettings";
import { DeveloperSettings } from "../components/DeveloperSettings";
import { MistBuildBanner } from "../components/MistBuildBanner";
export { ModelField } from "../components/OnboardingModelField";
import "../styles/components.css";
import "../styles/settings.css";
import "../styles/settings-llm.css";

export function SettingsView({ settings, onSettingsChange }: {
  settings: AppSettings; onSettingsChange: (next: AppSettings) => void;
}): JSX.Element {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const aiLocale = aiSettingsLocale(locale), copy = AI_SETTINGS_MESSAGES[aiLocale];
  const [tab, setTab] = useState(() => {
    try { const saved = localStorage.getItem("tc-news:settings-tab"); return !saved || saved === "general" ? "general" : "ai"; }
    catch { return "general"; }
  });
  function selectTab(next: string) { setTab(next); safeSetItem("tc-news:settings-tab", next); }
  function updateGeneral(patch: Partial<AppSettings>) { onSettingsChange({ ...settings, ...patch }); }
  // ----- DID委譲(他のtc-*アプリと同一ユーザーとして扱う、did-delegation.md) ---
  // leafDid: このオリジンのデバイス固有DID(crypto/didIdentity.ts)。委譲の
  // 有無に関わらず常に存在する。delegation: leafDidに対して有効な委譲があれば
  // そのレコード(root/exp込み)、無ければundefined。tc-shared-did-delegation-v1
  // は他のtc-*アプリやペアリング成立時に書き換わり得るので、storageイベント
  // (subscribeDelegation)を購読して再検証する。
  const [leafDid, setLeafDid] = useState("");
  useEffect(() => {
    let cancelled = false;
    ensureDidIdentity().then((identity) => {
      if (!cancelled) setLeafDid(identity.did);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [delegation, setDelegation] = useState<DelegationV1 | undefined>(undefined);
  useEffect(() => {
    if (!leafDid) return undefined;
    let cancelled = false;
    function refresh() {
      loadDelegationFor(leafDid).then((d) => {
        if (!cancelled) setDelegation(d);
      });
    }
    refresh();
    const unsubscribe = subscribeDelegation(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [leafDid]);

  const [pairingCode, setPairingCode] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState("");

  async function handlePairDidDelegation() {
    if (!leafDid || pairingBusy || !pairingCode.trim()) return;
    setPairingBusy(true);
    setPairingError("");
    try {
      const result = await pairDidDelegation(pairingCode, leafDid);
      setDelegation(result);
      setPairingCode("");
    } catch (err) {
      setPairingError(formatMistaiError(err, locale === "ja" ? MESSAGES_JA : MESSAGES_EN, t("settings.didPairingUnknownError")));
    } finally {
      setPairingBusy(false);
    }
  }
  return <div class="settings-view"><div class="settings-inner">
    <h1 class="settings-title"><SettingsIcon size={20} /> {t("settings.title")}</h1>
    <div class="settings-tabs" role="tablist" aria-label={t("settings.tabsAriaLabel")}>
      <button type="button" role="tab" id="settings-tab-general" aria-controls="settings-panel-general" aria-selected={tab === "general"} class={`settings-tab${tab === "general" ? " settings-tab--active" : ""}`} onClick={() => selectTab("general")}><Sliders size={14} /> {t("settings.tabGeneral")}</button>
      <button type="button" role="tab" aria-selected={tab === "ai"} class={`settings-tab${tab === "ai" ? " settings-tab--active" : ""}`} onClick={() => selectTab("ai")}><Cpu size={14} /> {copy.ai}</button>
    </div>
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

            <div class="checkbox-field">
              <Switch label={t("settings.autoGenerate")} checked={settings.autoGenerate} onChange={autoGenerate => updateGeneral({ autoGenerate })} />
              <span>{t("settings.autoGenerate")}</span>
            </div>

            <div class="checkbox-field">
              <Switch label={t("settings.programRuby")} checked={settings.programRuby} onChange={programRuby => updateGeneral({ programRuby })} />
              <span>
                {t("settings.programRuby")}
                <br />
                <span class="field-hint">{t("settings.programRubyHint")}</span>
              </span>
            </div>

            <label class="field">
              <span>{t("settings.shareModeLabel")}</span>
              <select
                value={settings.shareMode}
                onChange={(e) =>
                  updateGeneral({ shareMode: e.currentTarget.value as AppSettings["shareMode"] })
                }
              >
                <option value="auto">{t("settings.shareModeAuto")}</option>
                <option value="manual">{t("settings.shareModeManual")}</option>
              </select>
              <span class="field-hint">{t("settings.shareModeDesc")}</span>
            </label>

            <div class="checkbox-field">
              <Switch label={t("settings.globalShareLabel")} checked={settings.globalShare} onChange={globalShare => updateGeneral({ globalShare })} />
              <span>
                {t("settings.globalShareLabel")}
                <br />
                <span class="field-hint">{t("settings.globalShareDesc")}</span>
              </span>
            </div>

            <div class="checkbox-field">
              <Switch label={t("settings.showMediaPreviews")} checked={settings.showMediaPreviews} onChange={showMediaPreviews => updateGeneral({ showMediaPreviews })} />
              <span>
                {t("settings.showMediaPreviews")}
                <br />
                <span class="field-hint">{t("settings.showMediaPreviewsHint")}</span>
              </span>
            </div>

            <RecommendationSettings />

            <h2 class="settings-heading">
              <Fingerprint size={16} /> {t("settings.didSectionHeading")}
            </h2>
            <p class="field-hint">{t("settings.didSectionHint")}</p>
            <p class="field-hint">
              {delegation
                ? t("settings.didStatusActiveDetail", {
                    did: delegation.root,
                    expiry: new Date(delegation.exp).toLocaleString(locale),
                  })
                : t("settings.didStatusNoneDetail", { did: leafDid || "…" })}
            </p>
            <label class="field">
              <span>{t("settings.didPairingCodeLabel")}</span>
              <input
                value={pairingCode}
                onInput={(e) => setPairingCode(e.currentTarget.value)}
                placeholder={t("settings.didPairingCodePlaceholder")}
                disabled={pairingBusy}
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              class="btn"
              onClick={() => void handlePairDidDelegation()}
              disabled={pairingBusy || !pairingCode.trim() || !leafDid}
            >
              <Fingerprint size={15} /> {pairingBusy ? t("settings.didPairingPending") : t("settings.didPairingButton")}
            </button>
            {pairingError ? (
              <p class="settings-alert" role="alert">
                <AlertTriangle size={14} /> {pairingError}
              </p>
            ) : null}

            <h2 class="settings-heading">
              <Sparkles size={16} /> {t("onboarding.reopenTitle")}
            </h2>
            <p class="field-hint">{t("onboarding.reopenHint")}</p>
            <button type="button" class="btn btn-primary" onClick={requestOnboarding}>
              <Sparkles size={15} /> {t("onboarding.reopenButton")}
            </button>
          </section>
        ) : null}


    {tab === "ai" && (isLlmConfigCorrupted() ? <p class="settings-alert" role="alert"><AlertTriangle size={14} /> {t("settings.sharedConfigCorruptedWarning")}</p> :
      <LlmSettings locale={aiLocale} localSettings={localSettingsAdapter} tasks={[
        { id: "default", label: copy.default, tip: copy.defaultTip, reasoning: true },
        { id: "orchestrator", label: copy.orchestrator, tip: copy.orchestratorTip, reasoning: true },
        { id: "worker", label: copy.worker, tip: copy.workerTip, reasoning: true },
      ]} voice={{ tts: {} }} />)}
  </div><div class="settings-diagnostics"><DeveloperSettings /><MistBuildBanner view="settings" /></div></div>;
}

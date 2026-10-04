// First-run welcome lets readers enter the app immediately, with an optional
// setup wizard: LLM connection -> nickname -> feature tour. Every step is
// skippable, and leaving counts as "done" — the caller owns the flag via
// `onStartReading` and `onClose` (see lib/onboarding.ts), and the
// settings screen can re-open this component any time afterwards.
import { useRef, useState } from "preact/hooks";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  Globe,
  Newspaper,
  Plug,
  Rss,
  Settings as SettingsIcon,
  Share2,
  Sparkles,
  UserPlus,
  X,
} from "lucide-preact";
import type { AppSettings } from "../types";
import { emptyLlmConfig, createProvider, patchProvider, resolveModel, normalizeBaseUrl, type ModelRefV1 } from "../lib/llmConfig";
import { loadLlmConfig as readLlmConfig, migrateSharedLlmConfig } from "@tik-choco/mistai/llm-config";
import { updateLlmConfig } from "../lib/llmConfigStore";
import { requestChatCompletion } from "../lib/llm";
import { ModelField } from "../views/SettingsView";
import { useT } from "../lib/i18n";
import "../styles/onboarding.css";

const SETUP_STEPS = ["llm", "name", "tour"] as const;
type OnboardingStep = "welcome" | (typeof SETUP_STEPS)[number];

interface LlmDraft {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type TestState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "ok" }
  | { phase: "error"; message: string }
  // A saveLlmDraft() failure (corrupted shared record, or the write being
  // silently dropped e.g. by a full storage quota) — distinct from "error"
  // (a connection-test failure) so the message doesn't get the "接続に失敗
  // しました" (connection failed) framing for what is actually a save failure.
  | { phase: "save-error"; reason: "corrupted" | "write-failed" };

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

export function Onboarding(props: {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  onStartReading: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState<OnboardingStep>("welcome");

  // LLM draft starts from the shared config's current default preset so
  // re-running the wizard shows (and edits) the real current connection
  // instead of blank fields.
  const [llm, setLlm] = useState<LlmDraft>(() => {
    const cfg = readLlmConfig() ?? emptyLlmConfig();
    // Reading the wizard draft alone does not persist anything. The shell owns load migration.
    migrateSharedLlmConfig(cfg);
    const resolved = resolveModel(cfg);
    return {
      baseUrl: resolved?.baseUrl ?? "",
      apiKey: resolved?.apiKey ?? "",
      model: resolved?.model ?? "",
    };
  });
  const [testState, setTestState] = useState<TestState>({ phase: "idle" });

  const [name, setName] = useState(props.settings.userName);

  function updateLlm(patch: Partial<LlmDraft>) {
    setLlm((prev) => ({ ...prev, ...patch }));
    // Edited connection values invalidate a previous test result.
    setTestState({ phase: "idle" });
  }

  const createdRef = useRef<string | null>(null);
  type SaveLlmDraftResult =
    | { ok: true; ref: ModelRefV1 | null }
    | { ok: false; reason: "corrupted" | "write-failed" };

  function saveLlmDraft(): SaveLlmDraftResult {
    const baseUrl = normalizeBaseUrl(llm.baseUrl);
    if (!baseUrl) return { ok: true, ref: null };
    let ref: ModelRefV1 | null = null;
    const result = updateLlmConfig(cfg => {
      let providerId = createdRef.current;
      if (!providerId || !cfg.providers.some(p => p.id === providerId)) {
        providerId = cfg.providers.find(p => normalizeBaseUrl(p.baseUrl) === baseUrl && p.apiKey === llm.apiKey)?.id ?? createProvider(cfg, baseUrl);
        createdRef.current = providerId;
      }
      const provider = cfg.providers.find(p => p.id === providerId)!;
      const model = llm.model.trim();
      patchProvider(cfg, providerId, { baseUrl, apiKey: llm.apiKey, models: [...new Set([...(provider.models ?? []), ...(model ? [model] : [])])] });
      ref = { providerId, model };
      if (!cfg.defaultModel) cfg.defaultModel = ref;
    });
    return result.ok ? { ok: true, ref } : { ok: false, reason: result.reason };
  }

  async function handleTest() {
    if (testState.phase === "busy") return;
    // Save first so the test exercises the exact same model reference real
    // article generation will use afterwards.
    const saveResult = saveLlmDraft();
    if (!saveResult.ok) {
      setTestState({ phase: "save-error", reason: saveResult.reason });
      return;
    }
    if (saveResult.ref === null) return; // blank base URL: nothing to test yet
    setTestState({ phase: "busy" });
    try {
      await requestChatCompletion(saveResult.ref, [{ role: "user", content: t("onboarding.testMessage") }]);
      setTestState({ phase: "ok" });
    } catch (error) {
      setTestState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function handleLlmNext() {
    const saveResult = saveLlmDraft();
    if (!saveResult.ok) {
      setTestState({ phase: "save-error", reason: saveResult.reason });
      return;
    }
    setStep("name");
  }

  function handleNameNext() {
    props.onSettingsChange({ ...props.settings, userName: name.trim() });
    setStep("tour");
  }

  return (
    <div class="ob-overlay">
      <div class="ob-card" role="dialog" aria-modal="true" aria-label={t("onboarding.dialogAria")}>
        <button
          class="ob-close"
          type="button"
          onClick={props.onClose}
          title={t("onboarding.close")}
          aria-label={t("onboarding.close")}
        >
          <X size={18} />
        </button>

        {step === "welcome" && (
          <div class="ob-body">
            <div class="ob-hero">
              <Sparkles size={36} />
            </div>
            <h2 class="ob-title">{t("onboarding.welcomeTitle")}</h2>
            <p class="ob-text">{t("onboarding.welcomeBody1")}</p>
            <p class="ob-text">{t("onboarding.welcomeBody2")}</p>
          </div>
        )}

        {step === "llm" && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Cpu size={22} />
              <h2 class="ob-title">{t("onboarding.llmTitle")}</h2>
            </div>
            <p class="ob-text">{t("onboarding.llmIntro")}</p>

            <div class="ob-field">
              <label class="ob-label">{t("onboarding.baseUrlLabel")}</label>
              <input
                class="ob-input"
                type="text"
                placeholder={t("onboarding.baseUrlPlaceholder")}
                value={llm.baseUrl}
                onInput={(e) => updateLlm({ baseUrl: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">{t("onboarding.apiKeyLabel")}</label>
              <input
                class="ob-input"
                type="password"
                placeholder="sk-..."
                value={llm.apiKey}
                onInput={(e) => updateLlm({ apiKey: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">{t("onboarding.modelLabel")}</label>
              <ModelField
                value={llm.model}
                baseUrl={llm.baseUrl}
                apiKey={llm.apiKey}
                onChange={(model) => updateLlm({ model })}
              />
            </div>

            <div class="ob-test-row">
              <button
                class="ob-btn"
                type="button"
                onClick={() => void handleTest()}
                disabled={testState.phase === "busy" || !llm.baseUrl.trim()}
              >
                {testState.phase === "busy" ? <span class="spinner" /> : <Plug size={16} />}
                {testState.phase === "busy" ? t("onboarding.testBusy") : t("onboarding.testButton")}
              </button>
              {testState.phase === "ok" && (
                <span class="ob-test-ok">
                  <Check size={16} />
                  {t("onboarding.testOk")}
                </span>
              )}
            </div>
            {testState.phase === "error" && (
              <p class="ob-error">{t("onboarding.testError", { message: testState.message })}</p>
            )}
            {testState.phase === "save-error" && (
              <p class="ob-error">
                {t(
                  testState.reason === "corrupted"
                    ? "onboarding.saveErrorCorrupted"
                    : "onboarding.saveErrorWriteFailed",
                )}
              </p>
            )}
          </div>
        )}

        {step === "name" && (
          <div class="ob-body">
            <div class="ob-step-head">
              <UserPlus size={22} />
              <h2 class="ob-title">{t("onboarding.nameTitle")}</h2>
            </div>
            <p class="ob-text">{t("onboarding.nameIntro")}</p>
            <div class="ob-field">
              <label class="ob-label">{t("onboarding.nameLabel")}</label>
              <input
                class="ob-input"
                type="text"
                placeholder={t("onboarding.namePlaceholder")}
                value={name}
                onInput={(e) => setName(inputValue(e))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleNameNext();
                }}
              />
            </div>
          </div>
        )}

        {step === "tour" && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Check size={22} />
              <h2 class="ob-title">{t("onboarding.tourTitle")}</h2>
            </div>
            <p class="ob-text">{t("onboarding.tourIntro")}</p>
            <ul class="ob-feature-list">
              <li>
                <Rss size={16} />
                <span>
                  <strong>{t("onboarding.tourFeedTitle")}</strong> — {t("onboarding.tourFeedDesc")}
                </span>
              </li>
              <li>
                <Newspaper size={16} />
                <span>
                  <strong>{t("onboarding.tourArticlesTitle")}</strong> — {t("onboarding.tourArticlesDesc")}
                </span>
              </li>
              <li>
                <Share2 size={16} />
                <span>
                  <strong>{t("onboarding.tourShareTitle")}</strong> — {t("onboarding.tourShareDesc")}
                </span>
              </li>
              <li>
                <Globe size={16} />
                <span>
                  <strong>{t("onboarding.tourSharedTitle")}</strong> — {t("onboarding.tourSharedDesc")}
                </span>
              </li>
              <li>
                <SettingsIcon size={16} />
                <span>
                  <strong>{t("onboarding.tourSettingsTitle")}</strong> — {t("onboarding.tourSettingsDesc")}
                </span>
              </li>
            </ul>
            <p class="ob-text ob-text-subtle">{t("onboarding.tourOutro")}</p>
          </div>
        )}

        <footer class="ob-footer">
          {step !== "welcome" && (
            <div class="ob-dots" aria-hidden="true">
              {SETUP_STEPS.map((setupStep) => (
                <span key={setupStep} class={"ob-dot" + (setupStep === step ? " is-active" : "")} />
              ))}
            </div>
          )}
          <div class={"ob-footer-actions" + (step === "welcome" ? " ob-welcome-actions" : "")}>
            {(step === "llm" || step === "name") && (
              <button
                class="ob-btn"
                type="button"
                onClick={() => setStep(step === "llm" ? "welcome" : "llm")}
              >
                <ArrowLeft size={16} />
                {t("onboarding.back")}
              </button>
            )}
            {step === "welcome" && (
              <>
                <button class="ob-btn ob-btn-accent" type="button" onClick={props.onStartReading}>
                  <Newspaper size={16} />
                  {t("onboarding.start")}
                </button>
                <button class="ob-btn" type="button" onClick={() => setStep("llm")}>
                  {t("onboarding.setupCreation")}
                  <ArrowRight size={16} />
                </button>
              </>
            )}
            {step === "llm" && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleLlmNext}>
                {t("onboarding.saveAndNext")}
                <ArrowRight size={16} />
              </button>
            )}
            {step === "name" && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleNameNext}>
                {t("onboarding.next")}
                <ArrowRight size={16} />
              </button>
            )}
            {step === "tour" && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={props.onClose}>
                <Check size={16} />
                {t("onboarding.finish")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

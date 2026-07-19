// First-run wizard shown by app.tsx as a modal overlay: welcome -> LLM
// connection -> nickname -> feature tour. Every step is skippable (the close
// button works at any point) and closing counts as "done" — the flag is
// owned by the caller via `onClose` (see lib/onboarding.ts), and the
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
import { emptyLlmConfig, ensurePreset, ensureProvider, loadLlmConfig, resolvePreset } from "../lib/llmConfig";
import { updateLlmConfig } from "../lib/llmConfigStore";
import { requestChatCompletion } from "../lib/llm";
import { ModelField } from "../views/SettingsView";
import { useT } from "../lib/i18n";
import "../styles/onboarding.css";

const STEP_COUNT = 4;

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
  onClose: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState(0);

  // LLM draft starts from the shared config's current default preset so
  // re-running the wizard shows (and edits) the real current connection
  // instead of blank fields.
  const [llm, setLlm] = useState<LlmDraft>(() => {
    const resolved = resolvePreset(loadLlmConfig() ?? emptyLlmConfig());
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

  // Tracks the provider/preset this wizard session is editing, so repeated
  // saves (e.g. one per field edit + "test connection") update that same
  // shared-config entry in place instead of appending a fresh one on every
  // keystroke (ensureProvider/ensurePreset dedupe by content, not identity,
  // so an in-progress edit wouldn't match its own prior save).
  const createdRef = useRef<{ providerId: string; presetId: string } | null>(null);

  type SaveLlmDraftResult =
    | { ok: true; presetId: string | null }
    | { ok: false; reason: "corrupted" | "write-failed" };

  /** Persists the draft into the shared config (tc-shared-llm-config-v1) via
   * updateLlmConfig()'s read-modify-write — never a stale in-memory
   * snapshot — creating a provider+preset on first save and updating that
   * same pair afterwards. Sets defaultPresetId only if it was still unset.
   *
   * A blank (trimmed) base URL is treated as "nothing to save yet" rather
   * than persisted: ensureProvider("") would otherwise create — and
   * possibly default-preset — an empty, unusable provider entry the moment
   * the wizard reaches step 1. `presetId: null` signals callers there's
   * nothing to test/advance-with yet, distinct from an actual save failure.
   *
   * Returns `ok: false` when updateLlmConfig() refused or lost the write
   * (corrupted shared record, or a silently-dropped write e.g. full storage
   * quota), so callers can surface that instead of silently proceeding as if
   * the draft were saved. */
  function saveLlmDraft(): SaveLlmDraftResult {
    const baseUrl = llm.baseUrl.trim();
    if (baseUrl === "") {
      return { ok: true, presetId: null };
    }

    let presetId = "";
    const result = updateLlmConfig((cfg) => {
      let providerId: string;
      if (createdRef.current) {
        providerId = createdRef.current.providerId;
        presetId = createdRef.current.presetId;
        const provider = cfg.providers.find((p) => p.id === providerId);
        if (provider) {
          provider.baseUrl = baseUrl;
          provider.apiKey = llm.apiKey;
        }
        const preset = cfg.presets.find((p) => p.id === presetId);
        if (preset) preset.model = llm.model.trim();
      } else {
        providerId = ensureProvider(cfg, { baseUrl, apiKey: llm.apiKey });
        presetId = ensurePreset(cfg, { providerId, model: llm.model.trim() });
        createdRef.current = { providerId, presetId };
      }
      if (cfg.defaultPresetId === "") cfg.defaultPresetId = presetId;
    });

    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, presetId };
  }

  async function handleTest() {
    if (testState.phase === "busy") return;
    // Save first so the test exercises the exact same preset lookup real
    // article generation will use afterwards.
    const saveResult = saveLlmDraft();
    if (!saveResult.ok) {
      setTestState({ phase: "save-error", reason: saveResult.reason });
      return;
    }
    if (saveResult.presetId === null) return; // blank base URL: nothing to test yet
    setTestState({ phase: "busy" });
    try {
      await requestChatCompletion(saveResult.presetId, [{ role: "user", content: t("onboarding.testMessage") }]);
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
    setStep(2);
  }

  function handleNameNext() {
    props.onSettingsChange({ ...props.settings, userName: name.trim() });
    setStep(3);
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

        {step === 0 && (
          <div class="ob-body">
            <div class="ob-hero">
              <Sparkles size={36} />
            </div>
            <h2 class="ob-title">{t("onboarding.welcomeTitle")}</h2>
            <p class="ob-text">{t("onboarding.welcomeBody1")}</p>
            <p class="ob-text">{t("onboarding.welcomeBody2")}</p>
          </div>
        )}

        {step === 1 && (
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

        {step === 2 && (
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

        {step === 3 && (
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
          <div class="ob-dots" aria-hidden="true">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span key={i} class={"ob-dot" + (i === step ? " is-active" : "")} />
            ))}
          </div>
          <div class="ob-footer-actions">
            {step > 0 && step < 3 && (
              <button class="ob-btn" type="button" onClick={() => setStep(step - 1)}>
                <ArrowLeft size={16} />
                {t("onboarding.back")}
              </button>
            )}
            {step === 0 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={() => setStep(1)}>
                {t("onboarding.start")}
                <ArrowRight size={16} />
              </button>
            )}
            {step === 1 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleLlmNext}>
                {t("onboarding.saveAndNext")}
                <ArrowRight size={16} />
              </button>
            )}
            {step === 2 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleNameNext}>
                {t("onboarding.next")}
                <ArrowRight size={16} />
              </button>
            )}
            {step === 3 && (
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

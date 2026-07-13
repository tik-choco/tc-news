import { beforeEach, describe, expect, it } from "vitest";
import { LLM_CONFIG_KEY } from "./llmConfig";
import { loadProviderSettings, saveProviderSettings, subscribeProviderSettings, type ProviderSettings } from "./llmSettings";

const SETTINGS_KEY = "tc-news:provider-settings";

function baseSettings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    ttsEnabled: false,
    networkConsumerEnabled: false,
    networkProviderEnabled: false,
    orchestratorPresetId: "",
    workerPresetId: "",
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("loadProviderSettings defaults", () => {
  it("returns all-false/empty defaults when localStorage has nothing stored", () => {
    expect(loadProviderSettings()).toEqual(baseSettings());
  });
});

describe("saveProviderSettings / loadProviderSettings roundtrip", () => {
  it("preserves all fields, including networkProviderEnabled: true", () => {
    const settings = baseSettings({
      ttsEnabled: true,
      networkConsumerEnabled: true,
      networkProviderEnabled: true,
      orchestratorPresetId: "orch-1",
      workerPresetId: "worker-1",
    });
    saveProviderSettings(settings);
    expect(loadProviderSettings()).toEqual(settings);
  });

  it("falls back to defaults when the stored JSON is malformed", () => {
    localStorage.setItem(SETTINGS_KEY, "{not valid json");
    expect(loadProviderSettings()).toEqual(baseSettings());
  });

  it("falls back to defaults when the stored value isn't a JSON object", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify("just a string"));
    expect(loadProviderSettings()).toEqual(baseSettings());
  });

  it("coerces non-boolean networkProviderEnabled to false", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...baseSettings(), networkProviderEnabled: "yes" }));
    expect(loadProviderSettings().networkProviderEnabled).toBe(false);
  });

  it("coerces non-string preset ids to empty strings", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...baseSettings(), orchestratorPresetId: 42, workerPresetId: null }),
    );
    const loaded = loadProviderSettings();
    expect(loaded.orchestratorPresetId).toBe("");
    expect(loaded.workerPresetId).toBe("");
  });
});

describe("subscribeProviderSettings", () => {
  it("notifies a subscribed listener synchronously on same-tab save, and stops after unsubscribe", () => {
    const received: ProviderSettings[] = [];
    const unsubscribe = subscribeProviderSettings((settings) => received.push(settings));

    const first = baseSettings({ ttsEnabled: true });
    saveProviderSettings(first);
    expect(received).toEqual([first]);

    unsubscribe();

    const second = baseSettings({ networkConsumerEnabled: true });
    saveProviderSettings(second);
    // Still just the one notification from before unsubscribing.
    expect(received).toEqual([first]);
  });
});

describe("legacy migration", () => {
  it("migrates an old profiles-shaped record into the new ProviderSettings shape", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        profiles: [],
        defaultProfileId: "",
        networkConsumerEnabled: true,
        orchestratorProfileId: "a",
        workerProfileId: "b",
        tts: { enabled: true },
      }),
    );

    const loaded = loadProviderSettings();
    expect(loaded.networkConsumerEnabled).toBe(true);
    // Legacy shape has no notion of provider-hosting; migration always starts it off.
    expect(loaded.networkProviderEnabled).toBe(false);
    expect(loaded.orchestratorPresetId).toBe("a");
    expect(loaded.workerPresetId).toBe("b");
    expect(loaded.ttsEnabled).toBe(true);

    // Migration is one-time: the record is re-persisted in the new shape, so
    // loading again should return the same (already-migrated) settings rather
    // than re-running the migration.
    expect(loadProviderSettings()).toEqual(loaded);
  });

  it("aborts migration and leaves both records untouched when the shared LLM config is corrupted", () => {
    const legacyRaw = JSON.stringify({
      profiles: [{ id: "a", label: "A", baseUrl: "http://a", apiKey: "k", model: "m", temperature: 0.5 }],
      defaultProfileId: "a",
      networkConsumerEnabled: true,
      orchestratorProfileId: "a",
      workerProfileId: "a",
      tts: { enabled: true },
    });
    localStorage.setItem(SETTINGS_KEY, legacyRaw);

    // The shared key's raw value exists but doesn't sanitize — a corrupted
    // record, not merely absent.
    const corruptedSharedRaw = JSON.stringify({ v: 2, providers: "not-an-array" });
    localStorage.setItem(LLM_CONFIG_KEY, corruptedSharedRaw);

    const loaded = loadProviderSettings();
    // Migration was aborted, so we fall back to plain defaults rather than
    // whatever the legacy record's role pointers were.
    expect(loaded).toEqual(baseSettings());

    // Neither record was overwritten: the corrupted shared config survives
    // untouched (never healed by blind-overwriting with an empty config),
    // and the legacy provider-settings record is left in place so migration
    // can be retried once the shared config is fixed.
    expect(localStorage.getItem(LLM_CONFIG_KEY)).toBe(corruptedSharedRaw);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(legacyRaw);
  });
});

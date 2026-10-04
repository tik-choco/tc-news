import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_CONFIG_KEY, emptyLlmConfig, loadLlmConfig, saveLlmConfig, resolveModel } from "./llmConfig";
import { loadProviderSettings, saveProviderSettings, subscribeProviderSettings } from "./llmSettings";
const KEY = "tc-news:provider-settings";
beforeEach(() => localStorage.clear());

describe("model reference migration", () => {
  it("migrates tasks, effort and room sharing once while preserving shared legacy fields", () => {
    const cfg = emptyLlmConfig();
    cfg.providers = [{ id: "http", label: "Endpoint", baseUrl: "https://example.test/v1", apiKey: "", models: ["cached"] }, { id: "disabled", label: "Disabled", baseUrl: "https://disabled.test/v1", apiKey: "", enabled: false }];
    cfg.presets = [{ id: "plan", label: "Plan", providerId: "http", model: "planned", reasoningEffort: "high" }, { id: "write", label: "Write", providerId: "disabled", model: "written", reasoningEffort: "low" }];
    cfg.defaultPresetId = "plan"; cfg.network.roomId = "legacy-room";
    const legacy = { presets: cfg.presets, defaultPresetId: cfg.defaultPresetId, network: cfg.network };
    saveLlmConfig(cfg);
    localStorage.setItem(KEY, JSON.stringify({ orchestratorPresetId: "plan", workerPresetId: "write", workerReasoningEffort: "max", networkProviderEnabled: true, networkProviderPresetIds: ["plan"] }));
    const local = loadProviderSettings(), shared = loadLlmConfig()!;
    expect(local.tasks.orchestrator).toEqual({ ref: { providerId: "http", model: "planned" }, reasoningEffort: "high" });
    expect(local.tasks.worker).toEqual({ ref: { providerId: "disabled", model: "written" }, reasoningEffort: "max" });
    expect(shared.defaultModel).toEqual({ providerId: "http", model: "planned" });
    const room = shared.providers.find(p => p.baseUrl === "mist-network://legacy-room")!;
    expect(local.roomProvide[room.id]).toEqual({ enabled: true, shared: [{ providerId: "http", model: "planned" }] });
    expect({ presets: shared.presets, defaultPresetId: shared.defaultPresetId, network: shared.network }).toEqual(legacy);
    const stored = [localStorage.getItem(KEY), localStorage.getItem(LLM_CONFIG_KEY)];
    expect(loadProviderSettings()).toEqual(local);
    expect([localStorage.getItem(KEY), localStorage.getItem(LLM_CONFIG_KEY)]).toEqual(stored);
    expect(resolveModel(shared, local.tasks.worker.ref)?.providerId).toBe("http");
    expect(local.tasks.worker.ref?.providerId).toBe("disabled");
  });
  it("ignores retired room mirrors and excludes room models from sharing", () => {
    const cfg = emptyLlmConfig(); cfg.providers = [{ id: "room", label: "Room", baseUrl: "mist-network://team", apiKey: "" }];
    cfg.presets = [{ id: "mirror", label: "Mirror", providerId: "room", model: "remote" }]; cfg.network.roomId = "team";
    saveLlmConfig(cfg); localStorage.setItem(KEY, JSON.stringify({ workerPresetId: "mirror", networkProviderPresetIds: ["mirror"] }));
    const local = loadProviderSettings();
    expect(local.tasks.worker.ref).toBeUndefined(); expect(local.roomProvide.room.shared).toEqual([]);
  });
  it("imports very old profiles directly without writing presets", () => {
    localStorage.setItem(KEY, JSON.stringify({ profiles: [{ id: "old", baseUrl: "http://old.test/v1", apiKey: "", model: "old-model", reasoningEffort: "medium" }], defaultProfileId: "old", workerProfileId: "old" }));
    const local = loadProviderSettings(), cfg = loadLlmConfig()!;
    expect(cfg.presets).toEqual([]); expect(cfg.defaultModel?.model).toBe("old-model");
    expect(local.tasks.worker.ref).toEqual(cfg.defaultModel); expect(local.tasks.worker.reasoningEffort).toBe("medium");
  });
  it("does not overwrite corrupted shared config or migration sources", () => {
    const raw = JSON.stringify({ workerPresetId: "old" }); localStorage.setItem(KEY, raw); localStorage.setItem(LLM_CONFIG_KEY, '{"v":2}');
    loadProviderSettings(); expect(localStorage.getItem(KEY)).toBe(raw); expect(localStorage.getItem(LLM_CONFIG_KEY)).toBe('{"v":2}');
  });
  it("keeps a live fetched cache unchanged", () => {
    const cfg = emptyLlmConfig(); cfg.providers = [{ id: "p", label: "P", baseUrl: "http://p.test", apiKey: "", models: ["live"], modelsFetchedAt: "2026-10-04T00:00:00Z" }];
    cfg.presets = [{ id: "old", label: "Old", providerId: "p", model: "retired" }]; saveLlmConfig(cfg);
    expect(loadLlmConfig()?.providers[0].models).toEqual(["live"]);
  });
});
describe("local settings storage", () => {
  it("roundtrips and notifies only subscribed listeners", () => {
    const settings = loadProviderSettings(), cb = vi.fn(), stop = subscribeProviderSettings(cb);
    settings.tasks.worker.reasoningEffort = "xhigh"; saveProviderSettings(settings); expect(cb).toHaveBeenCalledExactlyOnceWith(settings); stop();
    saveProviderSettings(settings); expect(cb).toHaveBeenCalledTimes(1); expect(loadProviderSettings()).toEqual(settings);
  });
  it("defensively parses malformed local data", () => {
    localStorage.setItem(KEY, JSON.stringify({ tasks: { worker: { ref: "bad", reasoningEffort: "invalid" } }, roomProvide: { bad: null }, recentModels: [null] }));
    expect(loadProviderSettings().tasks.worker).toEqual({ reasoningEffort: "none" }); expect(loadProviderSettings().roomProvide).toEqual({});
  });
});

// Mirrors the model names advertised by AI Network room providers (their
// preset labels, falling back to model ids - see advertisedModelName in
// lib/networkModels.ts) into the shared llm config, so they show up in
// SettingsView's AI接続タブ as ordinary presets - under a
// `mist-network://<roomId>` pseudo-provider - that the user can pick as
// their default/task preset just like a preset backed by a real HTTP
// provider (see resolvePreset in lib/llmConfig.ts, which doesn't
// distinguish the two). Ported from tc-lingo's/tc-translate's
// hooks/useNetworkModelSync.ts (see
// tc-docs/drafts/llm-settings-common-v1.md §4.4) - this import direction was
// previously unimplemented in tc-news (see networkModels.ts's prior header
// and SettingsView.tsx's AI Networkタブ comment).
//
// A mirror, not an append-only import: while connected, presets under the
// room's pseudo-provider whose model is no longer advertised are pruned, so
// a provider unchecking a shared model makes its card disappear here as soon
// as the re-broadcast provider_hello lands. Pruning is scoped strictly to the
// current room's pseudo-provider - entries this sync itself created - so the
// shared config's append-only convention for OTHER apps' providers/presets
// still holds. A disconnect ("searching"/error) is NOT a prune trigger:
// offline isn't the same as un-shared, so imported cards survive reconnects.
//
// Self-contained (own settings/config/status subscriptions, no props) and
// mounted at the app level (app.tsx), like hooks/useNetworkProviderHost.ts,
// so the mirror stays live even while the settings screen is closed. Writes
// go through lib/llmConfigStore.ts's updateLlmConfig() - a read-modify-write
// against the *current* storage value that also notifies same-tab
// subscribers (e.g. SettingsView's Endpoints/Models display) - instead of
// the vendored saveLlmConfig() directly, which only notifies other tabs (see
// llmConfigStore.ts's header for why that's not enough here). Writes are
// skipped entirely when the mirrored set already matches, so reconnects/
// re-renders don't thrash localStorage or retrigger subscribers on every tick.
import { useEffect, useState } from "preact/hooks";
import { emptyLlmConfig, ensurePreset, ensureProvider, loadLlmConfig, normalizeBaseUrl } from "../lib/llmConfig";
import type { SharedLlmConfigV1 } from "../lib/llmConfig";
import { subscribeLlmConfigStore, updateLlmConfig } from "../lib/llmConfigStore";
import { loadProviderSettings, subscribeProviderSettings } from "../lib/llmSettings";
import { NETWORK_PROVIDER_LABEL, networkProviderBaseUrl } from "../lib/networkModels";
import { consumerStatus, onConsumerStatusChange } from "../lib/network";

export function useNetworkModelSync(): void {
  const [networkConsumerEnabled, setNetworkConsumerEnabled] = useState(
    () => loadProviderSettings().networkConsumerEnabled,
  );
  useEffect(() => subscribeProviderSettings((s) => setNetworkConsumerEnabled(s.networkConsumerEnabled)), []);

  const [roomId, setRoomId] = useState(() => (loadLlmConfig() ?? emptyLlmConfig()).network.roomId.trim());
  useEffect(
    () => subscribeLlmConfigStore((cfg) => setRoomId((cfg ?? emptyLlmConfig()).network.roomId.trim())),
    [],
  );

  const [status, setStatus] = useState(() => consumerStatus());
  useEffect(() => onConsumerStatusChange(setStatus), []);

  const connected = status.phase === "connected";
  const models = connected ? status.models : undefined;
  // Deduped/sorted/joined into a single string so the effect below only
  // reruns when the actual model set changes, not on every re-render that
  // produces a new (but equivalent) models array reference.
  const modelsKey = models && models.length ? [...new Set(models)].sort().join("\n") : "";

  useEffect(() => {
    if (!networkConsumerEnabled || !connected) return;

    const baseUrl = networkProviderBaseUrl(roomId);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const modelList = modelsKey ? modelsKey.split("\n") : [];
    const modelSet = new Set(modelList);

    // No-op check mirroring the update below against the current config, so
    // updateLlmConfig - which notifies every same-tab consumer of the shared
    // config - is only called when there's actually something to add or
    // prune. The dedup keys match ensureProvider's/ensurePreset's own
    // (baseUrl+apiKey for the provider; providerId+model+temperature+
    // reasoningEffort for each preset).
    const current = loadLlmConfig() ?? emptyLlmConfig();
    const provider = current.providers.find((p) => p.baseUrl === normalizedBaseUrl && p.apiKey === "");
    const inSync =
      provider === undefined
        ? modelList.length === 0
        : modelList.length === 0
          ? false // provider row lingers although nothing is advertised any more
          : current.presets.every((preset) => preset.providerId !== provider.id || modelSet.has(preset.model)) &&
            modelList.every((model) =>
              current.presets.some(
                (preset) =>
                  preset.providerId === provider.id &&
                  preset.model === model &&
                  preset.temperature === undefined &&
                  preset.reasoningEffort === undefined,
              ),
            );
    if (inSync) return;

    updateLlmConfig((config: SharedLlmConfigV1) => {
      if (modelList.length === 0) {
        // Connected, but the room advertises nothing (everything was
        // un-shared): drop the imported presets and the now-empty
        // pseudo-provider row itself.
        const stale = config.providers.find((p) => p.baseUrl === normalizedBaseUrl && p.apiKey === "");
        if (!stale) return;
        config.presets = config.presets.filter((p) => p.providerId !== stale.id);
        if (config.defaultPresetId && !config.presets.some((p) => p.id === config.defaultPresetId)) {
          config.defaultPresetId = config.presets[0]?.id ?? "";
        }
        config.providers = config.providers.filter((p) => p.id !== stale.id);
        return;
      }

      const providerId = ensureProvider(config, { label: NETWORK_PROVIDER_LABEL, baseUrl, apiKey: "" });
      for (const model of modelList) {
        ensurePreset(config, { providerId, model, label: model });
      }
      const stalePresetIds = new Set(
        config.presets.filter((p) => p.providerId === providerId && !modelSet.has(p.model)).map((p) => p.id),
      );
      if (stalePresetIds.size > 0) {
        config.presets = config.presets.filter((p) => !stalePresetIds.has(p.id));
        if (config.defaultPresetId && stalePresetIds.has(config.defaultPresetId)) {
          config.defaultPresetId = config.presets[0]?.id ?? "";
        }
      }
    });
  }, [networkConsumerEnabled, roomId, connected, modelsKey]);
}

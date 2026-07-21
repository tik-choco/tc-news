// App-level host for the AI Network provider role: keeps @tik-choco/mistai's
// useNetworkProvider running for the whole app lifetime (mounted from
// app.tsx, not SettingsView, so providing continues while the settings screen
// is closed — see ../tc-docs/ai-network.md's "AI 供給の常時性" for why a peer
// should keep serving as long as the tab is open). SettingsView receives the
// returned status object as a prop and only renders it.
//
// The provider always serves the *default preset* (resolvePreset with no id)
// for model-less requests, and additionally serves whichever presets the user
// checked to share (local.networkProviderPresetIds, see SettingsView's AI
// Networkタブ) under their own advertised name (see lib/networkModels.ts) —
// a model-specific request naming one of those is routed to that preset's own
// connection instead of the default. Always calls the upstream API directly
// via requestApiChatCompletionStreaming — routing through requestChatCompletion()
// would loop the request back into the AI Network room it came from when
// consumer mode is also on.

import { useEffect, useMemo, useState } from "preact/hooks";
import {
  createMistNode,
  NODE_ID_STORAGE_KEY,
  useNetworkProvider,
  type UseNetworkProviderResult,
} from "../lib/network";
import {
  emptyLlmConfig,
  loadLlmConfig,
  resolvePreset,
  type ResolvedLlmTargetV1,
  type SharedLlmConfigV1,
} from "../lib/llmConfig";
import { subscribeLlmConfigStore } from "../lib/llmConfigStore";
import { loadProviderSettings, subscribeProviderSettings, type ProviderSettings } from "../lib/llmSettings";
import { requestApiChatCompletionStreaming } from "../lib/llm";
import { advertisedModelName, isNetworkProviderBaseUrl } from "../lib/networkModels";
import { tGlobal } from "../lib/i18n";

/**
 * ユーザーがチェックした`presetIds`(共有するモデル)を共有llm configへ解決する。
 * 解決できなくなったid、resolvePreset()が既定プリセットへ黙ってフォールバック
 * したid(削除済みidの再共有を防ぐガード)、baseUrlがmist-network://疑似
 * プロバイダであるtarget(ネットワーク経由で取り込んだpresetをそのまま
 * 再広告すると、そのルームへリクエストがループする)は除外する。
 */
function resolveSharedTargets(llmConfig: SharedLlmConfigV1, presetIds: string[]): ResolvedLlmTargetV1[] {
  const targets: ResolvedLlmTargetV1[] = [];
  for (const id of presetIds) {
    const resolved = resolvePreset(llmConfig, id);
    if (!resolved || resolved.presetId !== id) continue;
    if (isNetworkProviderBaseUrl(resolved.baseUrl)) continue;
    targets.push(resolved);
  }
  return targets;
}

export function useNetworkProviderHost(): UseNetworkProviderResult {
  const [local, setLocal] = useState<ProviderSettings>(() => loadProviderSettings());
  useEffect(() => subscribeProviderSettings(setLocal), []);

  const [cfg, setCfg] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());
  // subscribeLlmConfigStore (not the vendored subscribeLlmConfig) so a save
  // made in the same tab — e.g. SettingsView or the Onboarding wizard — is
  // picked up immediately instead of only on the next cross-tab `storage`
  // event.
  useEffect(() => subscribeLlmConfigStore((next) => setCfg(next ?? emptyLlmConfig())), []);

  // Debounced so typing a room id in SettingsView doesn't rejoin the room on
  // every keystroke (mirrors the consumer connection's 500ms debounce there).
  const roomId = cfg.network.roomId.trim();
  const [debouncedRoomId, setDebouncedRoomId] = useState(roomId);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedRoomId(roomId), 500);
    return () => clearTimeout(timer);
  }, [roomId]);

  const target = useMemo(() => resolvePreset(cfg), [cfg]);
  const sharedTargets = useMemo(
    () => resolveSharedTargets(cfg, local.networkProviderPresetIds),
    [cfg, local.networkProviderPresetIds],
  );
  // 広告するモデル名を重複排除・ソートして1本の文字列に畳んでからuseMemoに
  // 渡す — sharedTargets配列の中身が実質同じでも参照が毎回変わるため、配列を
  // そのまま依存配列に置くとadvertisedModelsが無駄に再生成されてしまう。
  const advertisedModelsKey = [...new Set(sharedTargets.map(advertisedModelName))].sort().join("\n");
  const advertisedModels = useMemo(
    () => (advertisedModelsKey ? advertisedModelsKey.split("\n") : []),
    [advertisedModelsKey],
  );
  const upstreamConfigured =
    Boolean(target && target.model.trim() !== "" && target.baseUrl.trim() !== "") || sharedTargets.length > 0;

  return useNetworkProvider({
    enabled: local.networkProviderEnabled && upstreamConfigured && debouncedRoomId !== "",
    roomId: debouncedRoomId,
    createNode: createMistNode,
    nodeIdStorageKey: NODE_ID_STORAGE_KEY,
    callLlm: (messages, model, onDelta) => {
      // Re-resolve at call time so in-flight requests see the current config
      // without needing to re-join the room.
      const currentCfg = loadLlmConfig() ?? emptyLlmConfig();
      const currentSettings = loadProviderSettings();
      if (model) {
        const sharedNow = resolveSharedTargets(currentCfg, currentSettings.networkProviderPresetIds);
        const matched = sharedNow.find((t) => advertisedModelName(t) === model);
        if (matched) return requestApiChatCompletionStreaming(matched, messages, undefined, onDelta);
        // 名前付きリクエストだが、現在共有しているモデルの一覧にない —
        // 共有を外した後もそのモデルが使えてしまわないよう、既定プリセット
        // へフォールバックせず拒否する。
        if (sharedNow.length > 0) {
          return Promise.reject(new Error(tGlobal("errors.llmNotConfigured")));
        }
      }
      const current = resolvePreset(currentCfg);
      if (!current) return Promise.reject(new Error(tGlobal("errors.llmNotConfigured")));
      return requestApiChatCompletionStreaming(current, messages, model, onDelta);
    },
    advertisedModels: advertisedModels.length > 0 ? advertisedModels : undefined,
  });
}

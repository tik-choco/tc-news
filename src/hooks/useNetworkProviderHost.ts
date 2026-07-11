// App-level host for the AI Network provider role: keeps @tik-choco/mistai's
// useNetworkProvider running for the whole app lifetime (mounted from
// app.tsx, not SettingsView, so providing continues while the settings screen
// is closed — see ../tc-docs/ai-network.md's "AI 供給の常時性" for why a peer
// should keep serving as long as the tab is open). SettingsView receives the
// returned status object as a prop and only renders it.
//
// The provider serves the *default preset* (resolvePreset with no id) and
// always calls the upstream API directly via requestApiChatCompletionStreaming
// — routing through requestChatCompletion() would loop the request back into
// the AI Network room it came from when consumer mode is also on.

import { useEffect, useMemo, useState } from "preact/hooks";
import {
  createMistNode,
  NODE_ID_STORAGE_KEY,
  useNetworkProvider,
  type UseNetworkProviderResult,
} from "../lib/network";
import { emptyLlmConfig, loadLlmConfig, resolvePreset, subscribeLlmConfig, type SharedLlmConfigV1 } from "../lib/llmConfig";
import { loadProviderSettings, subscribeProviderSettings, type ProviderSettings } from "../lib/llmSettings";
import { requestApiChatCompletionStreaming } from "../lib/llm";
import { tGlobal } from "../lib/i18n";

export function useNetworkProviderHost(): UseNetworkProviderResult {
  const [local, setLocal] = useState<ProviderSettings>(() => loadProviderSettings());
  useEffect(() => subscribeProviderSettings(setLocal), []);

  const [cfg, setCfg] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());
  useEffect(() => subscribeLlmConfig((next) => setCfg(next ?? emptyLlmConfig())), []);

  // Debounced so typing a room id in SettingsView doesn't rejoin the room on
  // every keystroke (mirrors the consumer connection's 500ms debounce there).
  const roomId = cfg.network.roomId.trim();
  const [debouncedRoomId, setDebouncedRoomId] = useState(roomId);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedRoomId(roomId), 500);
    return () => clearTimeout(timer);
  }, [roomId]);

  const target = useMemo(() => resolvePreset(cfg), [cfg]);
  const upstreamConfigured = Boolean(target && target.model.trim() !== "" && target.baseUrl.trim() !== "");

  return useNetworkProvider({
    enabled: local.networkProviderEnabled && upstreamConfigured && debouncedRoomId !== "",
    roomId: debouncedRoomId,
    createNode: createMistNode,
    nodeIdStorageKey: NODE_ID_STORAGE_KEY,
    callLlm: (messages, model, onDelta) => {
      // Re-resolve at call time so in-flight requests see the current config
      // without needing to re-join the room.
      const current = resolvePreset(loadLlmConfig() ?? emptyLlmConfig());
      if (!current) return Promise.reject(new Error(tGlobal("errors.llmNotConfigured")));
      return requestApiChatCompletionStreaming(current, messages, model, onDelta);
    },
  });
}

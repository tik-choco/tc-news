// Chat-completion entry point for tc-news. Callers (article generation,
// translation, orchestration) call requestChatCompletion() with a preset id
// (resolved against the shared tc-shared-llm-config-v1 config, see
// lib/llmConfig.ts) and don't care whether the request goes direct-to-API
// (via @tik-choco/mistai's streamChatCompletion) or over the AI Network (via
// the ConsumerClient in lib/network.ts). Both branches stream deltas through
// onDelta and resolve with the full reply. Modeled on tc-town's src/lib/llm.ts.

import {
  MistaiError,
  formatMistaiError,
  MESSAGES_JA,
  MESSAGES_EN,
  streamChatCompletion,
  type ChatMessage,
  type OpenAIConfig,
} from "@tik-choco/mistai";
import { emptyLlmConfig, loadLlmConfig, normalizeBaseUrl, resolvePreset, type ResolvedLlmTargetV1 } from "./llmConfig";
import { loadProviderSettings } from "./llmSettings";
import { networkClient, requestNetworkChat } from "./network";
import { getLocale, tGlobal } from "./i18n";

export interface RequestChatOptions {
  onDelta?: (delta: string, full: string) => void;
  temperature?: number;
}

// Maps a resolved preset+provider onto the shared library's upstream config.
// reasoningEffort is forwarded only when set and non-empty — an explicit ""
// means the preset opted out of sending the reasoning_effort parameter
// entirely (see llmSettings.ts's legacy migration, which preserves that
// sentinel from the old per-app profile shape).
function apiConfig(target: ResolvedLlmTargetV1, temperature?: number): OpenAIConfig {
  const reasoningEffort = target.reasoningEffort?.trim();
  return {
    baseUrl: normalizeBaseUrl(target.baseUrl),
    apiKey: target.apiKey,
    model: target.model.trim(),
    temperature: temperature ?? target.temperature ?? 0.7,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * Resolves `presetId` (or, if "" / not found, the shared config's
 * defaultPresetId) against tc-shared-llm-config-v1 and requests a chat
 * completion. Routes through the AI Network consumer when it's enabled
 * (tc-news-local toggle) and currently connected (forwarding the preset's
 * model as the requested model, "" meaning "let the provider use its own");
 * otherwise calls the preset's provider directly. Throws a localized Error if
 * no preset/provider can be resolved, or on network/HTTP/empty-response
 * failure (formatted via formatMistaiError).
 */
export async function requestChatCompletion(
  presetId: string,
  messages: ChatMessage[],
  options?: RequestChatOptions,
): Promise<string> {
  const cfg = loadLlmConfig() ?? emptyLlmConfig();
  const resolved = resolvePreset(cfg, presetId || undefined);
  if (!resolved) {
    throw new Error(tGlobal("errors.llmNotConfigured"));
  }
  const local = loadProviderSettings();

  try {
    if (local.networkConsumerEnabled && networkClient.status.phase === "connected") {
      const content = await requestNetworkChat(
        cfg.network.roomId,
        messages,
        resolved.model.trim() || undefined,
        options?.onDelta,
      );
      if (!content.trim()) {
        throw new MistaiError("UPSTREAM_BAD_RESPONSE", tGlobal("errors.llmEmptyResponse"));
      }
      return content;
    }

    // streamChatCompletion's onDelta hands us the fragment only; accumulate
    // the running text ourselves so callers get the (delta, full) pair.
    let full = "";
    const onDelta = options?.onDelta;
    const content = await streamChatCompletion(
      apiConfig(resolved, options?.temperature),
      messages,
      onDelta
        ? (delta) => {
            full += delta;
            onDelta(delta, full);
          }
        : undefined,
    );

    if (!content.trim()) {
      throw new MistaiError("UPSTREAM_BAD_RESPONSE", tGlobal("errors.llmEmptyResponse"));
    }

    return content;
  } catch (err) {
    const messages2 = getLocale() === "ja" ? MESSAGES_JA : MESSAGES_EN;
    throw new Error(formatMistaiError(err, messages2, tGlobal("errors.llmCallFailed")));
  }
}

/**
 * Streaming variant used by the AI Network provider lifecycle (app.tsx) to
 * forward llm_request traffic from remote consumers to this app's configured
 * endpoint. Always calls the API directly — never routes back through the
 * network consumer, which would loop the request into the room it came from.
 * `model` overrides the target's own model when the requester asked for a
 * specific one. Modeled on tc-town's src/lib/llm.ts.
 */
export async function requestApiChatCompletionStreaming(
  target: ResolvedLlmTargetV1,
  messages: ChatMessage[],
  model: string | undefined,
  onDelta: (delta: string) => void,
): Promise<string> {
  const config = apiConfig(target);
  const full = await streamChatCompletion({ ...config, model: (model ?? config.model ?? "").trim() }, messages, onDelta);

  if (!full.trim()) {
    throw new MistaiError("UPSTREAM_BAD_RESPONSE", tGlobal("errors.llmEmptyResponse"));
  }

  return full;
}

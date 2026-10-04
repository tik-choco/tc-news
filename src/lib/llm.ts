// All app chat calls resolve a task's ModelRef, then only the usable shared default.
import { MistaiError, formatMistaiError, MESSAGES_JA, MESSAGES_EN, streamChatCompletion, type ChatMessage } from "@tik-choco/mistai";
import { emptyLlmConfig, loadLlmConfig, resolveModel, providerKind, roomIdFromBaseUrl, type ModelRefV1 } from "./llmConfig";
import { loadProviderSettings } from "./llmSettings";
import { rooms } from "./network";
import { getLocale, tGlobal } from "./i18n";

export interface RequestChatOptions { onDelta?: (delta: string, full: string) => void; }
export async function requestChatCompletion(
  taskOrRef: string | ModelRefV1,
  messages: ChatMessage[],
  options?: RequestChatOptions,
): Promise<string> {
  const local = loadProviderSettings();
  const task = local.tasks[typeof taskOrRef === "string" ? taskOrRef || "default" : "default"] ?? local.tasks.default;
  const target = resolveModel(loadLlmConfig() ?? emptyLlmConfig(), typeof taskOrRef === "string" ? task.ref : taskOrRef);
  if (!target) throw new Error(tGlobal("errors.llmNotConfigured"));
  try {
    let full = "";
    const content = providerKind(target) === "room"
      ? await rooms.requestRoomChat(roomIdFromBaseUrl(target.baseUrl), messages, target.model, options?.onDelta)
      : await streamChatCompletion({ ...target, reasoningEffort: task.reasoningEffort }, messages, options?.onDelta ? delta => {
          full += delta;
          options.onDelta!(delta, full);
        } : undefined);
    if (!content.trim()) throw new MistaiError("UPSTREAM_BAD_RESPONSE", tGlobal("errors.llmEmptyResponse"));
    return content;
  } catch (error) {
    throw new Error(formatMistaiError(error, getLocale() === "ja" ? MESSAGES_JA : MESSAGES_EN, tGlobal("errors.llmCallFailed")));
  }
}

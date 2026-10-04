import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode, encode, EVENT_RAW, type ChatMessage, type ProtocolMessage } from "@tik-choco/mistai";
import { emptyLlmConfig, saveLlmConfig } from "./llmConfig";
import { loadProviderSettings, saveProviderSettings } from "./llmSettings";

const transport = vi.hoisted(() => ({
  join: vi.fn<(...args: unknown[]) => Promise<void>>(), leave: vi.fn(), send: vi.fn(),
  event: undefined as undefined | ((type: number, from: string, payload: unknown, room?: string) => void),
  get: vi.fn(),
}));
vi.mock("./mistClient", () => ({
  NODE_ID_STORAGE_KEY: "test-news-node", getNode: transport.get,
  subscribeEvent: (handler: typeof transport.event) => { transport.event = handler; return () => {}; },
}));

const messages: ChatMessage[] = [{ role: "user", content: "Summarize this article." }];
const hello: ProtocolMessage = { v: 1, type: "provider_hello", services: ["chat", "oai"], models: ["raw-model"] };
let rooms: typeof import("./network").rooms;

function receive(message: ProtocolMessage) {
  transport.event!(EVENT_RAW, "peer", encode(message), "team");
}
function sent() {
  return transport.send.mock.calls.map(call => decode(call[1]));
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
  transport.join.mockResolvedValue(undefined);
  transport.get.mockResolvedValue({ joinRoomAsync: transport.join, leaveRoom: transport.leave, sendMessage: transport.send });
  const config = emptyLlmConfig();
  config.providers = [
    { id: "room", label: "Team", baseUrl: "mist-network://team", apiKey: "" },
    { id: "http", label: "HTTP", baseUrl: "https://upstream.test/v1", apiKey: "test-key" },
  ];
  config.defaultModel = { providerId: "room", model: "raw-model" };
  saveLlmConfig(config);
  const local = loadProviderSettings();
  local.tasks.default.reasoningEffort = "low";
  local.tasks.worker = { ref: config.defaultModel, reasoningEffort: "max" };
  saveProviderSettings(local);
  ({ rooms } = await import("./network"));
});
afterEach(() => {
  rooms.disconnectRoom("team"); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("chat routing", () => {
  it.each(["none", "high", "max"] as const)("sends task effort %s via room chat and streams before completion", async reasoningEffort => {
    const local = loadProviderSettings();
    local.tasks.worker.reasoningEffort = reasoningEffort;
    saveProviderSettings(local);
    await rooms.roomConsumer("team").connect("team");
    receive(hello);
    const chat = vi.spyOn(rooms, "requestRoomChat");
    const tunnel = vi.spyOn(rooms, "requestRoomOpenAi");
    const onDelta = vi.fn();
    const { requestChatCompletion } = await import("./llm");
    let completed = false;
    const answer = requestChatCompletion("worker", messages, { onDelta }).then(text => { completed = true; return text; });
    expect(chat).toHaveBeenCalledExactlyOnceWith("team", messages, { model: "raw-model", reasoningEffort, onDelta });
    await vi.waitFor(() => expect(sent().some(msg => msg?.type === "llm_request")).toBe(true));
    const request = sent().find(msg => msg?.type === "llm_request")!;
    expect(request).toMatchObject({ model: "raw-model", messages, reasoning_effort: reasoningEffort });
    expect(request).not.toHaveProperty("temperature");
    receive({ v: 1, type: "llm_response_chunk", id: request.id, seq: 0, delta: "Hello" });
    expect(onDelta).toHaveBeenNthCalledWith(1, "Hello", "Hello");
    expect(completed).toBe(false);
    receive({ v: 1, type: "llm_response_chunk", id: request.id, seq: 1, delta: " world" });
    expect(onDelta).toHaveBeenNthCalledWith(2, " world", "Hello world");
    receive({ v: 1, type: "llm_response_done", id: request.id, content: "Hello world" });
    await expect(answer).resolves.toBe("Hello world");
    expect(tunnel).not.toHaveBeenCalled();
    expect(sent().some(msg => msg?.type === "oai_request")).toBe(false);
  });

  it("uses default task effort for an explicit room ref without a streaming callback", async () => {
    await rooms.roomConsumer("team").connect("team");
    receive(hello);
    const { requestChatCompletion } = await import("./llm");
    const answer = requestChatCompletion({ providerId: "room", model: "raw-model" }, messages);
    await vi.waitFor(() => expect(sent().some(msg => msg?.type === "llm_request")).toBe(true));
    const request = sent().find(msg => msg?.type === "llm_request")!;
    expect(request).toMatchObject({ reasoning_effort: "low" });
    receive({ v: 1, type: "llm_response_done", id: request.id, content: "Summary" });
    await expect(answer).resolves.toBe("Summary");
  });

  it("preserves image content parts for vision/OCR through the room tunnel", async () => {
    const body = JSON.stringify({ model: "raw-model", reasoning_effort: "high", messages: [{ role: "user", content: [
      { type: "text", text: "Read the text in this image." },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ] }] });
    const chat = vi.spyOn(rooms, "requestRoomChat");
    const response = rooms.requestRoomOpenAi("team", { path: "/chat/completions", method: "POST", contentType: "application/json", body });
    await vi.waitFor(() => {
      if (transport.event) receive(hello);
      expect(sent().some(msg => msg?.type === "oai_request")).toBe(true);
    });
    const request = sent().find(msg => msg?.type === "oai_request")!;
    expect(request).toMatchObject({ path: "/chat/completions", method: "POST", contentType: "application/json", last: true });
    expect(atob(request.data)).toBe(body);
    const reply = JSON.stringify({ choices: [{ message: { content: "Extracted text" } }] });
    receive({ v: 1, type: "oai_response", id: request.id, seq: 0, last: true, status: 200, contentType: "application/json", data: btoa(reply) });
    await expect(response).resolves.toMatchObject({ status: 200, body: reply });
    expect(chat).not.toHaveBeenCalled();
    expect(sent().some(msg => msg?.type === "llm_request")).toBe(false);
  });

  it("keeps HTTP task effort and streaming deltas without temperature", async () => {
    const local = loadProviderSettings();
    local.tasks.worker.ref = { providerId: "http", model: "raw-model" };
    saveProviderSettings(local);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    const { requestChatCompletion } = await import("./llm");
    await expect(requestChatCompletion("worker", messages, { onDelta })).resolves.toBe("Hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://upstream.test/v1/chat/completions");
    expect(JSON.parse(init!.body as string)).toEqual({ model: "raw-model", messages, stream: true, reasoning_effort: "max" });
    expect(onDelta.mock.calls).toEqual([["Hello", "Hello"], [" world", "Hello world"]]);
  });
});

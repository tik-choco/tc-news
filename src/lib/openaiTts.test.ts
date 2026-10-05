import { afterEach, expect, it, vi } from "vitest";
import { emptyLlmConfig, resolveVoice } from "./llmConfig";
import { synthesizeSpeech } from "./openaiTts";

vi.mock("./network", () => ({ rooms: { requestRoomTts: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const config = emptyLlmConfig();
config.providers = [{ id: "http", label: "HTTP", baseUrl: "https://example.test/v1", apiKey: "" }];
config.tts = { providerId: "http", model: "speech-model", voice: "alloy", speed: 1.75 };

it("HTTP speech uses resolved shared speed and trusts the real response MIME", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("audio", { headers: { "Content-Type": "audio/wav" } }));
  vi.stubGlobal("fetch", fetcher);
  const blob = await synthesizeSpeech("Hello", resolveVoice(config, "tts")!);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.speed).toBe(1.75);
  expect(body.response_format).toBe("mp3");
  expect(blob.type).toBe("audio/wav");
});

it("HTTP speech omits absent and invalid speed hints", async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response("audio"));
  vi.stubGlobal("fetch", fetcher);
  const target = resolveVoice(config, "tts")!;
  for (const speed of [undefined, NaN, Infinity, 0.24, 4.01]) {
    await synthesizeSpeech("Hello", { ...target, speed });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).not.toHaveProperty("speed");
  }
  for (const speed of [0.25, 4]) {
    await synthesizeSpeech("Hello", { ...target, speed });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).speed).toBe(speed);
  }
});

it("room speech leaves shared speed resolution to mistai", async () => {
  const { rooms } = await import("./network");
  await synthesizeSpeech("Hello", { ...resolveVoice(config, "tts")!, baseUrl: "mist-network://team" });
  expect(rooms.requestRoomTts).toHaveBeenCalledWith("team", {
    text: "Hello", model: "speech-model", voice: "alloy",
  });
});

import { useEffect, useState } from "preact/hooks";
import { fetchVoices as mistaiFetchVoices, OPENAI_TTS_VOICES, type FetchFn, type ConsumerStatus } from "@tik-choco/mistai";
import { isNetworkProviderBaseUrl, roomIdFromBaseUrl } from "./llmConfig";
import { rooms } from "./network";
export { OPENAI_TTS_VOICES };

export async function fetchVoices(config: { baseUrl: string; apiKey: string }, fetchFn: FetchFn = fetch): Promise<string[]> {
  if (isNetworkProviderBaseUrl(config.baseUrl)) {
    const client = rooms.roomConsumer(roomIdFromBaseUrl(config.baseUrl));
    return client.status.phase === "connected" ? client.status.voices ?? [] : [];
  }
  return mistaiFetchVoices(config.baseUrl, config.apiKey, fetchFn);
}

// The program player follows the selected HTTP endpoint or that room's live voices.
export function useVoiceOptions(baseUrl: string, apiKey: string) {
  const [state, setState] = useState<{ options: string[]; status: "idle" | "loading" | "done" }>({ options: [], status: "idle" });
  useEffect(() => {
    if (!baseUrl) { setState({ options: [], status: "idle" }); return; }
    if (isNetworkProviderBaseUrl(baseUrl)) {
      const client = rooms.roomConsumer(roomIdFromBaseUrl(baseUrl));
      const sync = (status: ConsumerStatus) => setState({ options: status.phase === "connected" ? status.voices ?? [] : [], status: status.phase === "connected" ? "done" : "loading" });
      sync(client.status);
      return client.onStatusChange(sync);
    }
    let cancelled = false;
    setState({ options: [], status: "loading" });
    void mistaiFetchVoices(baseUrl, apiKey).then(options => { if (!cancelled) setState({ options, status: "done" }); });
    return () => { cancelled = true; };
  }, [baseUrl, apiKey]);
  return state;
}

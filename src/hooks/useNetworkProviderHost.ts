import { useEffect, useState } from "preact/hooks";
import { useLlmConfig, useRoomProviders } from "@tik-choco/mistai/preact";
import { rooms } from "../lib/network";
import { loadProviderSettings, subscribeProviderSettings } from "../lib/llmSettings";

// Mounted in the shell: every providing room survives navigation away from settings.
export function useNetworkProviderHost(settingsOpen: boolean): void {
  const [local, setLocal] = useState(loadProviderSettings);
  const { config } = useLlmConfig();
  useEffect(() => subscribeProviderSettings(setLocal), []);
  useRoomProviders({
    config, consumers: rooms, roomProvide: local.roomProvide,
    taskRefs: Object.values(local.tasks).map(task => task.ref),
    reasoningEffort: local.tasks.default.reasoningEffort,
    settingsOpen,
  });
}

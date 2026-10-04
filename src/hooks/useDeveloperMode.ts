import { useEffect, useState } from "preact/hooks";
import { safeSetItem } from "../lib/safeStorage";

const KEY = "tc-news:developer-mode";
const CHANGE = "tc-news:developer-mode-change";
let enabled = false;
let observed: string | null | undefined;

function loadDeveloperMode(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== observed) { observed = raw; enabled = raw === "1"; }
  } catch { /* Keep the session preference when storage is unavailable. */ }
  return enabled;
}

/** App-specific diagnostics preference; never changes the selected engine. */
export function setDeveloperMode(value: boolean): void {
  loadDeveloperMode();
  enabled = value;
  safeSetItem(KEY, value ? "1" : "0");
  try { observed = localStorage.getItem(KEY); } catch { /* session only */ }
  window.dispatchEvent(new Event(CHANGE));
}

export function useDeveloperMode(): boolean {
  const [value, setValue] = useState(loadDeveloperMode);
  useEffect(() => {
    const update = () => setValue(loadDeveloperMode());
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) update();
    };
    window.addEventListener(CHANGE, update);
    window.addEventListener("storage", onStorage);
    update();
    return () => {
      window.removeEventListener(CHANGE, update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return value;
}

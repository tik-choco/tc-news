// updateLlmConfig's quota-recovery path is simulated the same way as
// safeStorage.test.ts: spying on localStorage.setItem and throwing a real
// QuotaExceededError DOMException. The spy is restored in afterEach.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_CONFIG_KEY, emptyLlmConfig, loadLlmConfig, saveLlmConfig } from "./llmConfig";
import { isLlmConfigCorrupted, subscribeLlmConfigStore, updateLlmConfig } from "./llmConfigStore";

function quotaError(): DOMException {
  return new DOMException("quota exceeded", "QuotaExceededError");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("updateLlmConfig", () => {
  it("always re-reads storage before merging, instead of trusting a stale in-memory snapshot", () => {
    // Simulate a write that lands "between" the caller deciding to update and
    // updateLlmConfig() actually reading storage — e.g. another tab, or (the
    // bug this fixes) another same-tab caller holding a stale React/preact
    // state snapshot. updateLlmConfig() must pick this up rather than
    // clobbering it.
    const otherWriterCfg = emptyLlmConfig();
    otherWriterCfg.providers.push({ id: "p-other", label: "Other", baseUrl: "http://other", apiKey: "k" });
    saveLlmConfig(otherWriterCfg);

    const result = updateLlmConfig((cfg) => {
      cfg.providers.push({ id: "p-new", label: "New", baseUrl: "http://new", apiKey: "k2" });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const ids = result.config.providers.map((p) => p.id).sort();
    expect(ids).toEqual(["p-new", "p-other"]);

    // And the persisted record matches, not some overwritten-to-just-p-new state.
    const reloaded = loadLlmConfig();
    expect(reloaded?.providers.map((p) => p.id).sort()).toEqual(["p-new", "p-other"]);
  });

  it("refuses to save over a corrupted record, leaving the raw data untouched", () => {
    const corruptedRaw = JSON.stringify({ v: 2, providers: "not-an-array" });
    localStorage.setItem(LLM_CONFIG_KEY, corruptedRaw);
    expect(isLlmConfigCorrupted()).toBe(true);

    let mutateCalled = false;
    const result = updateLlmConfig(() => {
      mutateCalled = true;
    });

    expect(mutateCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("corrupted");

    // The original (still-corrupted) raw record survives untouched.
    expect(localStorage.getItem(LLM_CONFIG_KEY)).toBe(corruptedRaw);
  });

  it("reports write-failed when the write is silently dropped by a full quota", () => {
    const initial = emptyLlmConfig();
    initial.providers.push({ id: "p1", label: "One", baseUrl: "http://one", apiKey: "k" });
    saveLlmConfig(initial);
    const rawBefore = localStorage.getItem(LLM_CONFIG_KEY);

    // happy-dom's `localStorage` is backed by a Proxy where plain property
    // assignment (`localStorage.setItem = fn`) is a silent no-op (it's
    // interpreted as the storage-key setter, not a method override), and
    // vi.spyOn + vi.restoreAllMocks() has been observed to leave a stale
    // override behind for later tests. Object.defineProperty is the one
    // mechanism that both actually overrides the method here and reliably
    // un-overrides it again afterwards, so do the swap by hand.
    const originalSetItem = localStorage.setItem;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result: ReturnType<typeof updateLlmConfig>;
    try {
      Object.defineProperty(localStorage, "setItem", {
        value: () => {
          throw quotaError();
        },
        writable: true,
        configurable: true,
      });
      result = updateLlmConfig((cfg) => {
        cfg.providers.push({ id: "p2", label: "Two", baseUrl: "http://two", apiKey: "k2" });
      });
    } finally {
      Object.defineProperty(localStorage, "setItem", { value: originalSetItem, writable: true, configurable: true });
    }

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("write-failed");
    expect(warnSpy).toHaveBeenCalled();

    // The stored record is unchanged from before the failed write.
    expect(localStorage.getItem(LLM_CONFIG_KEY)).toBe(rawBefore);
  });

  it("notifies same-tab subscribers on a successful update", () => {
    const received: Array<ReturnType<typeof loadLlmConfig>> = [];
    const unsubscribe = subscribeLlmConfigStore((cfg) => received.push(cfg));

    const result = updateLlmConfig((cfg) => {
      cfg.network.roomId = "room-1";
    });
    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.network.roomId).toBe("room-1");

    unsubscribe();
    updateLlmConfig((cfg) => {
      cfg.network.roomId = "room-2";
    });
    // No further notification after unsubscribing.
    expect(received).toHaveLength(1);
  });

  it("does not notify subscribers when the update fails", () => {
    const corruptedRaw = JSON.stringify({ v: 2 });
    localStorage.setItem(LLM_CONFIG_KEY, corruptedRaw);

    const received: unknown[] = [];
    const unsubscribe = subscribeLlmConfigStore((cfg) => received.push(cfg));

    const result = updateLlmConfig(() => {});
    expect(result.ok).toBe(false);
    expect(received).toHaveLength(0);

    unsubscribe();
  });
});

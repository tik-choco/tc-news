import { beforeEach, describe, expect, it, vi } from "vitest";

// storage_kv_* fake: a plain Map standing in for the OPFS-backed mist KV.
// vi.hoisted so the factories below (which vi.mock hoists above the imports)
// can close over it.
const { kvMap, storageKvSet, storageKvGet, storageKvDelete } = vi.hoisted(() => {
  const map = new Map<string, Uint8Array>();
  return {
    kvMap: map,
    storageKvSet: vi.fn(async (key: string, bytes: Uint8Array) => {
      map.set(key, bytes);
    }),
    storageKvGet: vi.fn(async (key: string) => map.get(key)),
    storageKvDelete: vi.fn(async (key: string) => {
      map.delete(key);
    }),
  };
});

vi.mock("../vendor/mistlib/wrappers/web/index.js", () => ({
  storage_kv_set: storageKvSet,
  storage_kv_get: storageKvGet,
  storage_kv_delete: storageKvDelete,
}));

// getNode() just needs to resolve for initKvStore to proceed past the "wait
// for the mist node" step — kvStore.ts doesn't use the resolved value itself.
vi.mock("./mistClient", () => ({
  getNode: vi.fn(async () => ({})),
}));

import {
  initKvStore,
  isKvHydrated,
  kvDeleteSync,
  kvGetSync,
  kvSetSync,
  resetKvStoreForTests,
  subscribeKvHydrated,
} from "./kvStore";

const KEY = "tc-news:articles";
const OTHER_KEY = "tc-news:programs";

beforeEach(() => {
  localStorage.clear();
  kvMap.clear();
  storageKvSet.mockClear();
  storageKvGet.mockClear();
  storageKvDelete.mockClear();
  resetKvStoreForTests();
});

describe("fallback mode (before initKvStore/hydration)", () => {
  it("kvSetSync writes through to localStorage and kvGetSync reads it back", () => {
    kvSetSync(KEY, "hello");
    expect(localStorage.getItem(KEY)).toBe("hello");
    expect(kvGetSync(KEY)).toBe("hello");
    // Backend isn't ready yet — no KV write should have been attempted.
    expect(storageKvSet).not.toHaveBeenCalled();
  });

  it("kvDeleteSync removes the localStorage entry", () => {
    kvSetSync(KEY, "hello");
    kvDeleteSync(KEY);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(kvGetSync(KEY)).toBeNull();
  });
});

describe("initKvStore migration", () => {
  it("migrates a legacy localStorage value into the KV and removes it from localStorage", async () => {
    localStorage.setItem(KEY, "legacy-value");

    await initKvStore();

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(storageKvSet).toHaveBeenCalledWith(KEY, expect.any(Uint8Array));
    const stored = kvMap.get(KEY);
    expect(stored && new TextDecoder().decode(stored)).toBe("legacy-value");
    expect(kvGetSync(KEY)).toBe("legacy-value");
  });

  it("leaves a key alone (no KV write, nothing to remove) when neither localStorage nor the KV has it", async () => {
    await initKvStore();
    expect(kvGetSync(KEY)).toBeNull();
  });
});

describe("hydration priority: session write > localStorage > KV", () => {
  it("prefers a same-session write over both localStorage and the KV", async () => {
    kvMap.set(OTHER_KEY, new TextEncoder().encode("kv-value"));
    localStorage.setItem(OTHER_KEY, "ls-value");
    kvSetSync(OTHER_KEY, "session-value");

    await initKvStore();

    expect(kvGetSync(OTHER_KEY)).toBe("session-value");
  });

  it("prefers localStorage over the KV when there is no session write", async () => {
    kvMap.set(OTHER_KEY, new TextEncoder().encode("kv-value"));
    localStorage.setItem(OTHER_KEY, "ls-value");

    await initKvStore();

    expect(kvGetSync(OTHER_KEY)).toBe("ls-value");
    expect(localStorage.getItem(OTHER_KEY)).toBeNull();
  });

  it("falls back to the KV when there is neither a session write nor a localStorage value", async () => {
    kvMap.set(OTHER_KEY, new TextEncoder().encode("kv-value"));

    await initKvStore();

    expect(kvGetSync(OTHER_KEY)).toBe("kv-value");
  });
});

describe("post-hydration reads", () => {
  it("hydration replaces the mirror as authoritative — localStorage is no longer consulted", async () => {
    await initKvStore();
    expect(isKvHydrated()).toBe(true);

    // Nothing was in the mirror for this key at hydration time, so a read
    // stays null even though something (e.g. a stray write by other code)
    // shows up in localStorage afterwards.
    localStorage.setItem(KEY, "post-hydration-localStorage-value");
    expect(kvGetSync(KEY)).toBeNull();

    kvSetSync(KEY, "mirror-value");
    // A later, unrelated localStorage write must not shadow the mirror.
    localStorage.setItem(KEY, "different-localStorage-value");
    expect(kvGetSync(KEY)).toBe("mirror-value");
  });
});

describe("subscribeKvHydrated", () => {
  it("fires once hydration completes", async () => {
    const listener = vi.fn();
    subscribeKvHydrated(listener);
    expect(listener).not.toHaveBeenCalled();

    await initKvStore();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires immediately for a subscriber that arrives after hydration already completed", async () => {
    await initKvStore();

    const listener = vi.fn();
    const unsubscribe = subscribeKvHydrated(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("returns an unsubscribe function that prevents a later call", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKvHydrated(listener);
    unsubscribe();

    await initKvStore();

    expect(listener).not.toHaveBeenCalled();
  });
});

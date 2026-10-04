import { beforeEach, describe, expect, it } from "vitest";
import { loadKvRecords, persistKvRecords } from "./kvRecordStore";
import { KV_VALUE_SOFT_LIMIT_BYTES, kvGetSync, kvSetSync, resetKvStoreForTests, utf8ByteLength } from "./kvStore";

const KEY = "tc-news:test-records";

beforeEach(() => {
  localStorage.clear();
  resetKvStoreForTests();
});

describe("loadKvRecords", () => {
  it.each(["{broken", "[]", "null", "42"])("ignores invalid record maps: %s", (raw) => {
    kvSetSync(KEY, raw);
    expect(loadKvRecords(KEY, (value) => value)).toEqual({});
  });

  it("retains valid siblings and applies the store's legacy defaults", () => {
    kvSetSync(KEY, JSON.stringify({ good: { title: "Hello" }, bad: 42 }));
    expect(loadKvRecords(KEY, (value) => {
      if (!value || typeof value !== "object" || !("title" in value)) return null;
      return { title: value.title, excerpt: "" };
    })).toEqual({ good: { title: "Hello", excerpt: "" } });
  });
});

describe("persistKvRecords", () => {
  it("preserves insertion order when no eviction is needed", () => {
    const records = { old: { time: 1 }, recent: { time: 2 } };
    persistKvRecords(KEY, records, (record) => record.time);
    expect(kvGetSync(KEY)).toBe(JSON.stringify(records));
  });

  it("evicts oldest first using UTF-8 bytes, without mutating the input", () => {
    const text = "あ".repeat(Math.floor(KV_VALUE_SOFT_LIMIT_BYTES / 6));
    const records = { recent: { time: 3, text }, old: { time: 1, text }, middle: { time: 2, text } };
    persistKvRecords(KEY, records, (record) => record.time);
    const raw = kvGetSync(KEY)!;
    expect(utf8ByteLength(raw)).toBeLessThanOrEqual(KV_VALUE_SOFT_LIMIT_BYTES);
    expect(JSON.parse(raw)).toEqual({ recent: records.recent });
    expect(Object.keys(records)).toEqual(["recent", "old", "middle"]);
  });

  it("persists an empty map if a single record exceeds the limit", () => {
    persistKvRecords(KEY, { huge: { time: 1, text: "x".repeat(KV_VALUE_SOFT_LIMIT_BYTES) } }, (record) => record.time);
    expect(kvGetSync(KEY)).toBe("{}");
  });
});

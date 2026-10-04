import { KV_VALUE_SOFT_LIMIT_BYTES, kvGetSync, kvSetSync, utf8ByteLength } from "./kvStore";

/** Load a record map, leaving validation and legacy defaults to each store. */
export function loadKvRecords<T>(key: string, coerce: (value: unknown) => T | null): Record<string, T> {
  try {
    const raw = kvGetSync(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const records: Record<string, T> = {};
    for (const [entryKey, value] of Object.entries(parsed)) {
      const record = coerce(value);
      if (record) records[entryKey] = record;
    }
    return records;
  } catch {
    return {};
  }
}

/** Trim oldest records until the serialized UTF-8 payload fits the KV limit. */
export function persistKvRecords<T>(
  key: string,
  records: Record<string, T>,
  timestamp: (record: T) => number,
): void {
  let entries = Object.entries(records);
  let serialized = JSON.stringify(Object.fromEntries(entries));
  while (entries.length > 0 && utf8ByteLength(serialized) > KV_VALUE_SOFT_LIMIT_BYTES) {
    entries = entries.sort((a, b) => timestamp(b[1]) - timestamp(a[1])).slice(0, -1);
    serialized = JSON.stringify(Object.fromEntries(entries));
  }
  kvSetSync(key, serialized);
}

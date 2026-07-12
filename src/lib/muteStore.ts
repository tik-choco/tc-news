// Local per-DID mute list for the Shared views. Muting never affects P2P
// receipt (wires are still verified and stored) — it only hides an author's
// articles from the UI by default (see SharedView's collapsed-row toggle).
// Same defensive-parsing shape as the rest of tc-news's localStorage modules.

import { safeSetItem } from "./safeStorage";

const MUTED_DIDS_KEY = "tc-news:muted-dids"; // string[](DID)
const MAX_MUTED_DIDS = 200;

function persist(dids: string[]): void {
  safeSetItem(MUTED_DIDS_KEY, JSON.stringify(dids));
}

/** ミュート中のDID一覧を返す。壊れたstorageは空配列扱い。 */
export function loadMutedDids(): string[] {
  try {
    const raw = localStorage.getItem(MUTED_DIDS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === "string" && d.length > 0);
  } catch {
    return [];
  }
}

/** didをミュートに追加する(重複追加しない)。上限200件、超過時は古いもの(先頭)から捨てる。 */
export function muteDid(did: string): void {
  if (!did) return;
  const existing = loadMutedDids();
  if (existing.includes(did)) return;
  const next = [...existing, did];
  const trimmed = next.length > MAX_MUTED_DIDS ? next.slice(next.length - MAX_MUTED_DIDS) : next;
  persist(trimmed);
}

/** didのミュートを解除する。 */
export function unmuteDid(did: string): void {
  const existing = loadMutedDids();
  const next = existing.filter((d) => d !== did);
  if (next.length === existing.length) return; // not muted, nothing to do
  persist(next);
}

/** didがミュート中か判定する。呼び出し側が既にloadMutedDids()を持っていれば渡して再読込を避けられる。 */
export function isMuted(did: string, muted?: string[]): boolean {
  if (!did) return false;
  const list = muted ?? loadMutedDids();
  return list.includes(did);
}

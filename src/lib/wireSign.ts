// Shared signing helpers for P2P wire messages (chat messages, project
// posts, ...), built on the ported tc-storage DID identity (see
// src/crypto/didIdentity.ts) plus @tik-choco/mistai/identity's DID
// delegation chain (root -> leaf) support — see
// protocol/docs/data-contracts/docs/did-delegation.md. A wire's `fromId`
// *is* the sender's origin-local (leaf) did:key, and `signature` covers
// every other field including an optional `delegation`, so a receiver can
// reject impersonated/tampered wires before they ever reach UI state or
// localStorage.
//
// The actual signing/verification/delegation-resolution logic now lives in
// @tik-choco/mistai/identity (the canonical shared implementation named by
// did-delegation.md) — this file no longer carries its own copy of
// stableStringify/signingPayload. tc-news's own DidIdentity (crypto/
// didIdentity.ts) is structurally identical to mistai's, so it can be passed
// straight through without conversion.
import { ensureDidIdentity } from "../crypto/didIdentity";
import {
  loadDelegationFor,
  resolveWireSender,
  signWireWithDelegation,
  verifyWire as verifyWireImpl,
  type ResolvedSender,
} from "@tik-choco/mistai/identity";

export type { ResolvedSender };

/**
 * Signs every field of `unsigned` with the local DID identity, automatically
 * attaching this leaf's current delegation (if any) BEFORE signing — see
 * did-delegation.md's "送信側": `signature` covers `delegation` too, so a
 * third party can't strip or swap it. Returns the COMPLETE wire object
 * (including `signature` and, when delegated, `delegation`) — unlike the
 * old signWireFields(), callers don't need to spread a signature string into
 * a wire literal themselves; the whole wire comes back ready to send.
 */
export async function signWire<T extends Record<string, unknown> & { fromId: string }>(
  unsigned: T,
): Promise<T & { signature: string }> {
  const identity = await ensureDidIdentity();
  const delegation = await loadDelegationFor(identity.did);
  const wire = await signWireWithDelegation(unsigned, identity, delegation);
  return wire as T & { signature: string };
}

/**
 * Verifies `wire.signature` against every other field (including
 * `delegation`, if present), keyed by `wire.fromId`. Delegates to
 * @tik-choco/mistai/identity's verifyWire — same behavior as this file's own
 * former implementation, since a delegation-unaware verifier just sees one
 * more opaque field to include in the signing payload.
 */
export const verifyWire = verifyWireImpl;

/**
 * Full receive-side resolution (did-delegation.md's "受信側"): verifies the
 * wire, then — if a valid `delegation` for `wire.fromId` (as leaf) is
 * attached — resolves the sender to the delegation's `root` instead of the
 * leaf. Returns null only when the wire's own signature fails; a broken/
 * expired/leaf-mismatched delegation degrades to the leaf identity rather
 * than invalidating the message.
 *
 * Use `.id` (root when delegated, else leaf) for same-person comparisons —
 * dedup keys like "has this person already reacted/viewed X". Use `.leaf`
 * (always === wire.fromId) for signature attribution/display — author name,
 * avatar, authorDid/translatorDid cross-checks — since that's the key that
 * actually signed this wire, not the person it may be delegated from.
 */
export const resolveSender = resolveWireSender;

/**
 * このブラウザの「人としてのID」— 有効な委譲があれば root、無ければ leaf
 * (自分の did:key)。`resolveSender(wire).id` が自分のワイヤに対して返す値と
 * 常に一致する。
 *
 * 送信側で人単位のデデュープ記録(reactionStore / viewStore)を書くときは
 * `identity.did` ではなく必ずこれを使うこと。受信側が root 基準で記録する
 * のに送信側が leaf 基準で書くと、他ピア経由で戻ってきた自分のワイヤが
 * 別人扱いになり、自分のリアクション/閲覧が二重に数えられる。
 *
 * ワイヤの `fromId` は署名鍵そのものなので **leaf のまま**であることに注意
 * (署名の帰属と人の同一性は別concept)。
 */
export async function localSenderId(): Promise<string> {
  const identity = await ensureDidIdentity();
  const delegation = await loadDelegationFor(identity.did);
  return delegation?.root ?? identity.did;
}

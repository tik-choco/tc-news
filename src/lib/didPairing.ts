// Browser side of did-delegation.md's "経路A: ペアリング" for tc-news:
// exchanges a human-typed pairing code (shown by `mistl key pair`) for a
// DelegationV1 signed by a mistl-held root identity, then persists it to the
// shared tc-shared-did-delegation-v1 key so every tc-* app on this origin
// picks it up (see @tik-choco/mistai/identity's saveDelegation/
// subscribeDelegation).
//
// Reuses lib/network.ts's createMistNode — the adapter already built there
// to hand @tik-choco/mistai APIs a MistNodeLike backed by tc-news's single
// shared MistNode (lib/mistClient.ts) instead of opening a second one
// (mistlib-wasm allows only one active node per page). Pairing joins its own
// throwaway room (derived from the code, see @tik-choco/mistai/identity's
// requestDelegation) alongside whatever news rooms are already joined, which
// createMistNode already supports via its per-room ref-counted join/leave —
// no pairing-specific node handling was needed here.
import { requestDelegation, saveDelegation, type DelegationV1 } from "@tik-choco/mistai/identity";
import { createMistNode } from "./network";

const PAIRING_APP_NAME = "tc-news";

/**
 * Runs one pairing session and, on success, persists the resulting
 * delegation. Throws MistaiError on failure (invalid code, timeout,
 * rejected, ...) — callers localize via
 * formatMistaiError(err, MESSAGES_JA/MESSAGES_EN) (see @tik-choco/mistai).
 */
export async function pairDidDelegation(code: string, leaf: string): Promise<DelegationV1> {
  const delegation = await requestDelegation({
    code,
    leaf,
    app: PAIRING_APP_NAME,
    createNode: createMistNode,
  });
  saveDelegation(delegation);
  return delegation;
}

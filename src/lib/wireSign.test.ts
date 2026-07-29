// @vitest-environment happy-dom
//
// Covers the DID delegation chain pilot (protocol/docs/data-contracts/docs/
// did-delegation.md): signWire attaches the local leaf's delegation (if any)
// before signing, verifyWire stays a plain signature check that a legacy
// (delegation-unaware) verifier can still run unmodified, and resolveSender
// resolves a delegated wire's sender to root while degrading a broken/
// expired/mismatched delegation to the leaf rather than discarding the wire.
import { beforeEach, describe, expect, it } from "vitest";
import { localSenderId, resolveSender, signWire, verifyWire } from "./wireSign";
import { ensureDidIdentity } from "../crypto/didIdentity";
import { createDidIdentity, signDelegation, signWireWithDelegation, type DidIdentity } from "@tik-choco/mistai/identity";

beforeEach(() => {
  localStorage.clear();
});

describe("signWire", () => {
  it("returns a complete, verifiable wire with no delegation field when the leaf has no delegation", async () => {
    const identity = await ensureDidIdentity();
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: identity.did, timestamp: 1 };
    const wire = await signWire(unsigned);

    expect(wire.signature).toEqual(expect.any(String));
    expect("delegation" in wire).toBe(false);
    expect(await verifyWire(wire)).toBe(true);
  });

  it("attaches a valid stored delegation and signs it as part of the wire", async () => {
    const identity = await ensureDidIdentity();
    const root = await createDidIdentity();
    const delegation = await signDelegation(root, identity.did);
    localStorage.setItem("tc-shared-did-delegation-v1", JSON.stringify(delegation));

    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: identity.did, timestamp: 1 };
    const wire = await signWire(unsigned);

    expect((wire as Record<string, unknown>).delegation).toEqual(delegation);
    expect(await verifyWire(wire)).toBe(true);
  });

  it("ignores a stored delegation for a different leaf (foreign-leaf value left alone per did-delegation.md)", async () => {
    const identity = await ensureDidIdentity();
    const root = await createDidIdentity();
    const otherLeaf = await createDidIdentity();
    const foreignDelegation = await signDelegation(root, otherLeaf.did);
    localStorage.setItem("tc-shared-did-delegation-v1", JSON.stringify(foreignDelegation));

    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: identity.did, timestamp: 1 };
    const wire = await signWire(unsigned);

    expect("delegation" in wire).toBe(false);
  });
});

describe("verifyWire (delegation-unaware legacy verification path)", () => {
  it("accepts a delegated wire exactly like a legacy verifier that has never heard of delegation — the signing payload just gains one more opaque field", async () => {
    const identity = await ensureDidIdentity();
    const root = await createDidIdentity();
    const delegation = await signDelegation(root, identity.did);
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: identity.did, timestamp: 1 };
    const wire = await signWire({ ...unsigned, delegation });

    expect(await verifyWire(wire)).toBe(true);
  });

  it("rejects a wire whose delegation was tampered with after signing (signature covers delegation too)", async () => {
    const identity = await ensureDidIdentity();
    const root = await createDidIdentity();
    const delegation = await signDelegation(root, identity.did);
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: identity.did, timestamp: 1 };
    const wire = await signWire({ ...unsigned, delegation });

    const tampered = { ...wire, delegation: { ...delegation, exp: "2099-01-01T00:00:00.000Z" } };
    expect(await verifyWire(tampered)).toBe(false);
  });

  it("rejects a wire with an invalid signature", async () => {
    const identity = await ensureDidIdentity();
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: identity.did, timestamp: 1 };
    const wire = await signWire(unsigned);
    expect(await verifyWire({ ...wire, signature: "bogus" })).toBe(false);
  });
});

// 送信側が人単位のデデュープ記録(reactionStore / viewStore)を書くときの
// キーと、受信側が同じワイヤから解決するキーが一致していないと、他ピア経由で
// 戻ってきた自分のワイヤが別人扱いになって二重計上される。両者が常に等しい
// ことをここで固定する。
describe("localSenderId は自分のワイヤに対する resolveSender().id と一致する", () => {
  it("委譲が無いときは leaf(自分の did)", async () => {
    const identity = await ensureDidIdentity();
    const wire = await signWire({ type: "tc-news:view" as const, id: "v1", fromId: identity.did, timestamp: 1 });

    expect(await localSenderId()).toBe(identity.did);
    expect((await resolveSender(wire))?.id).toBe(await localSenderId());
  });

  it("有効な委譲があるときは root", async () => {
    const identity = await ensureDidIdentity();
    const root = await createDidIdentity();
    const delegation = await signDelegation(root, identity.did);
    localStorage.setItem("tc-shared-did-delegation-v1", JSON.stringify(delegation));

    const wire = await signWire({ type: "tc-news:view" as const, id: "v1", fromId: identity.did, timestamp: 1 });

    expect(await localSenderId()).toBe(root.did);
    expect((await resolveSender(wire))?.id).toBe(await localSenderId());
  });

  it("委譲が期限切れなら leaf に縮退する(受信側の縮退と揃う)", async () => {
    const identity = await ensureDidIdentity();
    const root = await createDidIdentity();
    const past = new Date("2020-01-01T00:00:00.000Z");
    const expired = await signDelegation(root, identity.did, { now: past, ttlMs: 60 * 24 * 60 * 60 * 1000 });
    localStorage.setItem("tc-shared-did-delegation-v1", JSON.stringify(expired));

    const wire = await signWire({ type: "tc-news:view" as const, id: "v1", fromId: identity.did, timestamp: 1 });

    expect(await localSenderId()).toBe(identity.did);
    expect((await resolveSender(wire))?.id).toBe(await localSenderId());
  });
});

describe("resolveSender", () => {
  async function makeRootAndLeaf(): Promise<{ root: DidIdentity; leaf: DidIdentity }> {
    const [root, leaf] = await Promise.all([createDidIdentity(), createDidIdentity()]);
    return { root, leaf };
  }

  it("returns null for a wire with an invalid signature", async () => {
    const identity = await ensureDidIdentity();
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: identity.did, timestamp: 1 };
    const wire = await signWire(unsigned);
    expect(await resolveSender({ ...wire, signature: "bogus" })).toBeNull();
  });

  it("resolves to the leaf when there is no delegation", async () => {
    const identity = await ensureDidIdentity();
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: identity.did, timestamp: 1 };
    const wire = await signWire(unsigned);
    expect(await resolveSender(wire)).toEqual({ id: identity.did, leaf: identity.did, delegated: false });
  });

  // These three tests exercise resolveSender for an arbitrary (non-local)
  // leaf identity, so they sign directly via mistai's signWireWithDelegation
  // rather than this app's signWire() — signWire() always signs as *this
  // origin's* local identity (ensureDidIdentity()) and would reject a
  // fromId belonging to a different, freshly-generated leaf.
  it("resolves to root when a valid delegation is attached", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const delegation = await signDelegation(root, leaf.did);
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: leaf.did, timestamp: 1 };
    const wire = await signWireWithDelegation(unsigned, leaf, delegation);

    const resolved = await resolveSender(wire);
    expect(resolved).toEqual({ id: root.did, leaf: leaf.did, root: root.did, delegated: true });
  });

  it("degrades to the leaf (not null) when the attached delegation is expired — the wire's own signature already proved authenticity", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const past = new Date("2020-01-01T00:00:00.000Z");
    const delegation = await signDelegation(root, leaf.did, { now: past, ttlMs: 60 * 24 * 60 * 60 * 1000 });
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: leaf.did, timestamp: 1 };
    const wire = await signWireWithDelegation(unsigned, leaf, delegation);

    const resolved = await resolveSender(wire);
    expect(resolved).toEqual({ id: leaf.did, leaf: leaf.did, delegated: false });
  });

  it("degrades to the leaf when the delegation's leaf does not match wire.fromId", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const otherLeaf = await createDidIdentity();
    const delegation = await signDelegation(root, otherLeaf.did);
    const unsigned = { type: "tc-news:article" as const, id: "a1", fromId: leaf.did, timestamp: 1 };
    const wire = await signWireWithDelegation(unsigned, leaf, delegation);

    const resolved = await resolveSender(wire);
    expect(resolved).toEqual({ id: leaf.did, leaf: leaf.did, delegated: false });
  });
});

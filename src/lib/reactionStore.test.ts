// @vitest-environment happy-dom
//
// reactionStore keeps an in-memory cache keyed by the raw localStorage
// string it was built from (see the module's readAll()), so a bare
// `localStorage.clear()` in beforeEach is enough to make the cache
// self-invalidate on the next read — no need for vi.resetModules() or an
// exported test-only reset hook.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addReaction, countsFor, hasReacted, loadReactions, subscribeReactions } from "./reactionStore";
import type { ReactionRecord } from "./reactionStore";

function record(overrides: Partial<ReactionRecord> = {}): ReactionRecord {
  return {
    targetId: "article-1",
    targetType: "article",
    kind: "like",
    fromId: "did:key:alice",
    fromName: "Alice",
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("addReaction / loadReactions", () => {
  it("persists a new reaction and returns true", () => {
    const r = record();
    expect(addReaction(r)).toBe(true);
    expect(loadReactions()).toHaveLength(1);
    expect(loadReactions()[0]).toEqual(r);
  });

  it("dedups by (targetId, kind, fromId): a duplicate returns false and doesn't add a second record", () => {
    expect(addReaction(record())).toBe(true);
    expect(addReaction(record())).toBe(false);
    expect(loadReactions()).toHaveLength(1);
  });

  it("allows the same person to react with a different kind on the same target", () => {
    expect(addReaction(record({ kind: "like" }))).toBe(true);
    expect(addReaction(record({ kind: "fire" }))).toBe(true);
    expect(loadReactions()).toHaveLength(2);
  });

  it("allows different people to react with the same kind on the same target", () => {
    expect(addReaction(record({ fromId: "did:key:alice" }))).toBe(true);
    expect(addReaction(record({ fromId: "did:key:bob" }))).toBe(true);
    expect(loadReactions()).toHaveLength(2);
  });

  it("drops records with a kind outside REACTION_KINDS when loading", () => {
    localStorage.setItem(
      "tc-news:reactions",
      JSON.stringify([record({ kind: "like" }), { ...record({ fromId: "did:key:bob" }), kind: "bogus" }]),
    );
    const loaded = loadReactions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].kind).toBe("like");
  });

  it("drops malformed records (missing required fields) when loading", () => {
    localStorage.setItem("tc-news:reactions", JSON.stringify([{ targetId: "a" }, record()]));
    expect(loadReactions()).toHaveLength(1);
  });

  it("re-reads correctly after localStorage.clear() (cache self-invalidates)", () => {
    addReaction(record());
    expect(loadReactions()).toHaveLength(1);
    localStorage.clear();
    expect(loadReactions()).toHaveLength(0);
  });
});

describe("hasReacted", () => {
  it("is false before reacting and true after", () => {
    expect(hasReacted("article-1", "like", "did:key:alice")).toBe(false);
    addReaction(record());
    expect(hasReacted("article-1", "like", "did:key:alice")).toBe(true);
  });

  it("is scoped to the exact (targetId, kind, fromId) triple", () => {
    addReaction(record({ targetId: "article-1", kind: "like", fromId: "did:key:alice" }));
    expect(hasReacted("article-1", "fire", "did:key:alice")).toBe(false);
    expect(hasReacted("article-2", "like", "did:key:alice")).toBe(false);
    expect(hasReacted("article-1", "like", "did:key:bob")).toBe(false);
  });
});

describe("countsFor", () => {
  it("returns zero-filled counts for a target with no reactions", () => {
    expect(countsFor("nonexistent")).toEqual({ like: 0, fire: 0, clap: 0, laugh: 0 });
  });

  it("counts reactions per kind for the given target only", () => {
    addReaction(record({ targetId: "a", kind: "like", fromId: "did:key:alice" }));
    addReaction(record({ targetId: "a", kind: "like", fromId: "did:key:bob" }));
    addReaction(record({ targetId: "a", kind: "fire", fromId: "did:key:alice" }));
    addReaction(record({ targetId: "b", kind: "clap", fromId: "did:key:alice" }));

    expect(countsFor("a")).toEqual({ like: 2, fire: 1, clap: 0, laugh: 0 });
    expect(countsFor("b")).toEqual({ like: 0, fire: 0, clap: 1, laugh: 0 });
  });
});

describe("subscribeReactions", () => {
  it("notifies listeners when a new reaction is added", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReactions(listener);
    addReaction(record());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not notify listeners on a duplicate (no-op) add", () => {
    addReaction(record());
    const listener = vi.fn();
    const unsubscribe = subscribeReactions(listener);
    addReaction(record());
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReactions(listener);
    unsubscribe();
    addReaction(record());
    expect(listener).not.toHaveBeenCalled();
  });
});

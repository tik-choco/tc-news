import { act, cleanup, renderHook, waitFor } from "@testing-library/preact";
import { DELIVERY_RELIABLE } from "@tik-choco/mistlib-web";
import { afterEach, expect, it, vi } from "vitest";
import { useNewsRoom } from "./useNewsRoom";

const transport = vi.hoisted(() => ({
  event: undefined as undefined | ((type: number, from: string, payload: unknown, room: string) => void),
  join: vi.fn().mockResolvedValue(undefined),
  leave: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../lib/mistClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/mistClient")>(),
  getNode: () => Promise.resolve({ joinRoomAsync: transport.join, leaveRoom: transport.leave, sendMessage: transport.send }),
  subscribeEvent: (handler: typeof transport.event) => { transport.event = handler; return () => { transport.event = undefined; }; },
}));
vi.mock("../crypto/didIdentity", async (importOriginal) => ({
  ...await importOriginal<typeof import("../crypto/didIdentity")>(),
  ensureDidIdentity: () => Promise.resolve({ did: "did:test:local" }),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

it("counts peer events and ignores AOI events with fixed UTF-8 payloads", async () => {
  const { result } = renderHook(() => useNewsRoom("news", "reader"));
  await waitFor(() => expect(result.current.connected).toBe(true));
  const bytes = (value: string) => new TextEncoder().encode(value);

  // Use WASM event codes directly to catch incorrect constant mappings.
  act(() => { transport.event!(5, "peer", bytes("entered"), ""); });
  expect(result.current.peers).toBe(0);
  act(() => { transport.event!(2, "peer", bytes("joined"), ""); });
  expect(result.current.peers).toBe(1);
  await waitFor(() => expect(transport.send).toHaveBeenCalledWith(
    "peer", expect.objectContaining({ type: "tc-news:history-request" }), DELIVERY_RELIABLE, "news",
  ));
  act(() => { transport.event!(6, "peer", bytes("left"), ""); });
  expect(result.current.peers).toBe(1);
  act(() => { transport.event!(3, "peer", bytes("left"), ""); });
  expect(result.current.peers).toBe(0);
});

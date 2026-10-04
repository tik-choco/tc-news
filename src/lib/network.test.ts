import { beforeEach, describe, expect, it, vi } from "vitest";
import { encode, EVENT_RAW } from "@tik-choco/mistai";
const transport = vi.hoisted(() => ({
  join: vi.fn<(...args: unknown[]) => Promise<void>>(), leave: vi.fn(), send: vi.fn(),
  event: undefined as undefined | ((type: number, from: string, payload: unknown, room?: string) => void),
  get: vi.fn(),
}));
vi.mock("./mistClient", () => ({
  NODE_ID_STORAGE_KEY: "test-news-node", getNode: transport.get,
  subscribeEvent: (handler: typeof transport.event) => { transport.event = handler; return () => {}; },
}));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
  transport.join.mockResolvedValue(undefined);
  transport.get.mockResolvedValue({ joinRoomAsync: transport.join, leaveRoom: transport.leave, sendMessage: transport.send });
});
describe("news multi-room adapter", () => {
  it("shares one news node while isolating events, sends, leaves and rejoining", async () => {
    const { rooms } = await import("./network");
    const first = rooms.roomConsumer("first"), second = rooms.roomConsumer("second");
    expect(first).not.toBe(second);
    await Promise.all([first.connect("first"), second.connect("second")]);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(transport.join.mock.calls.map(c => c[0]).sort()).toEqual(["first", "second"]);
    const hello = encode({ v: 1, type: "provider_hello", services: ["chat"], models: ["raw-model"] });
    transport.event!(EVENT_RAW, "peer-first", hello, "first");
    expect(first.status.phase).toBe("connected"); expect(second.status.phase).toBe("searching");
    transport.event!(EVENT_RAW, "peer-second", hello, "second");
    expect(second.status.phase).toBe("connected");
    expect(transport.send.mock.calls.every(call => ["first", "second"].includes(call[3]))).toBe(true);
    rooms.disconnectRoom("first"); expect(transport.leave).toHaveBeenCalledExactlyOnceWith("first"); expect(second.status.phase).toBe("connected");
    rooms.disconnectRoom("second");
    await first.connect("first");
    transport.event!(EVENT_RAW, "peer-again", hello, "first"); expect(first.status.phase).toBe("connected");
    expect(transport.get).toHaveBeenCalledTimes(1); rooms.disconnectRoom("first");
  });
  it("keeps a providing or pairing handle's room alive when a consumer disconnects", async () => {
    const { rooms, createMistNode } = await import("./network");
    const provider = createMistNode("same-node"); await provider.init(); await provider.joinRoom("team");
    await rooms.roomConsumer("team").connect("team"); rooms.disconnectRoom("team");
    expect(transport.leave).not.toHaveBeenCalled(); provider.leaveRoom("team"); expect(transport.leave).toHaveBeenCalledExactlyOnceWith("team");
  });
});

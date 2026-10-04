import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(), buildInfo: vi.fn(), construct: vi.fn(),
}));
vi.mock("@tik-choco/mistlib", () => ({ get_build_info: mocks.buildInfo }));
vi.mock("../vendor/mistlib/wrappers/web/index.js", () => ({
  MistNode: class {
    constructor() { mocks.construct(); }
    init = mocks.init;
    onEvent = vi.fn();
    onMediaEvent = vi.fn();
  },
  EVENT_RAW: 1, EVENT_NEIGHBORS: 2, EVENT_PEER_CONNECTED: 3, EVENT_PEER_DISCONNECTED: 4,
  MEDIA_EVENT_TRACK_ADDED: 5, MEDIA_EVENT_TRACK_REMOVED: 6, DELIVERY_RELIABLE: 1, DELIVERY_UNRELIABLE: 0,
  storage_add: vi.fn(), storage_get: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  mocks.init.mockResolvedValue(undefined);
  mocks.buildInfo.mockReturnValue(JSON.stringify({
    version: "0.6.2", commit: "abc1234", dirty: false, profile: "release", target: "wasm32-unknown-unknown",
  }));
});

it("reads the initialized engine once without creating a diagnostic node", async () => {
  const client = await import("./mistClient");
  const diagnostics = await import("./mistBuildInfo");
  expect(mocks.construct).not.toHaveBeenCalled();
  expect(mocks.buildInfo).not.toHaveBeenCalled();
  expect(diagnostics.getMistBuildSnapshot().state).toBe("waiting");
  const [first, second] = await Promise.all([client.getNode(), client.getNode()]);
  expect(first).toBe(second);
  expect(mocks.construct).toHaveBeenCalledTimes(1);
  expect(mocks.init).toHaveBeenCalledTimes(1);
  expect(mocks.buildInfo).toHaveBeenCalledTimes(1);
  expect(mocks.init.mock.invocationCallOrder[0]).toBeLessThan(mocks.buildInfo.mock.invocationCallOrder[0]!);
  expect(diagnostics.getMistBuildSnapshot()).toMatchObject({ state: "reported", info: { version: "0.6.2" } });
});

it("retains normal initialization when runtime information is unavailable", async () => {
  mocks.buildInfo.mockImplementation(() => { throw new Error("unsupported"); });
  const client = await import("./mistClient");
  const diagnostics = await import("./mistBuildInfo");
  await expect(client.getNode()).resolves.toBeDefined();
  expect(diagnostics.getMistBuildSnapshot()).toMatchObject({ state: "unverified", info: null });
});

it("reports existing node initialization failures without reading an uninitialized engine", async () => {
  mocks.init.mockRejectedValue(new Error("initialization failed"));
  const client = await import("./mistClient");
  const diagnostics = await import("./mistBuildInfo");
  await expect(client.getNode()).rejects.toThrow("initialization failed");
  expect(mocks.buildInfo).not.toHaveBeenCalled();
  expect(diagnostics.getMistBuildSnapshot()).toMatchObject({ state: "load-error", info: null });
});

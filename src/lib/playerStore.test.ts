// Same module-singleton reset idiom as jobQueue.test.ts: the store keeps
// mutable module state (current program/handle/generation), so each test
// gets a fresh module instance via vi.resetModules() + dynamic import.
//
// Every test injects a fake playback factory (see __setPlaybackFactory) and
// always passes explicit voice/openaiVoice, so playProgram() never touches
// real speechSynthesis, network TTS, or localStorage-backed llmConfig —
// only the store's own state machine is under test here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { RadioProgram } from "../types";

type PlayerModule = typeof import("./playerStore");

let playProgram: PlayerModule["playProgram"];
let pausePlayer: PlayerModule["pausePlayer"];
let resumePlayer: PlayerModule["resumePlayer"];
let stopPlayer: PlayerModule["stopPlayer"];
let getPlayerState: PlayerModule["getPlayerState"];
let subscribePlayer: PlayerModule["subscribePlayer"];
let __setPlaybackFactory: PlayerModule["__setPlaybackFactory"];

interface FakeHandle {
  pause: Mock;
  resume: Mock;
  stop: Mock;
}

type Callbacks = { onSegment: (i: number) => void; onEnd: () => void; onError: (err: unknown) => void };

function program(overrides: Partial<RadioProgram> = {}): RadioProgram {
  return {
    id: "p1",
    title: "Test Program",
    segments: [{ text: "one" }, { text: "two" }],
    createdAt: Date.now(),
    ...overrides,
  };
}

// Records every handle it creates (and the callbacks it was wired with) so
// tests can both assert on stop()/pause()/resume() calls and manually fire
// onSegment/onEnd/onError as if real playback were progressing.
function makeFakeFactory() {
  const handles: FakeHandle[] = [];
  const callbacks: Callbacks[] = [];
  const factory = (_program: RadioProgram, _opts: unknown, cb: Callbacks): FakeHandle => {
    const handle: FakeHandle = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    handles.push(handle);
    callbacks.push(cb);
    return handle;
  };
  return { factory, handles, callbacks };
}

const OPTS = { voice: null, openaiVoice: "test-voice", rate: 1 };

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./playerStore");
  playProgram = mod.playProgram;
  pausePlayer = mod.pausePlayer;
  resumePlayer = mod.resumePlayer;
  stopPlayer = mod.stopPlayer;
  getPlayerState = mod.getPlayerState;
  subscribePlayer = mod.subscribePlayer;
  __setPlaybackFactory = mod.__setPlaybackFactory;
});

describe("playProgram", () => {
  it("sets state to playing with the program on the resolved handle", async () => {
    const { factory } = makeFakeFactory();
    __setPlaybackFactory(factory);
    const p = program();

    await playProgram(p, OPTS);

    const state = getPlayerState();
    expect(state.program).toBe(p);
    expect(state.playState).toBe("playing");
    expect(state.currentIndex).toBe(0);
    expect(state.error).toBeNull();
  });

  it("stops the previous handle when a new program starts", async () => {
    const { factory, handles } = makeFakeFactory();
    __setPlaybackFactory(factory);

    await playProgram(program({ id: "p1" }), OPTS);
    await playProgram(program({ id: "p2" }), OPTS);

    expect(handles).toHaveLength(2);
    expect(handles[0].stop).toHaveBeenCalledTimes(1);
    expect(getPlayerState().program?.id).toBe("p2");
  });
});

describe("pausePlayer / resumePlayer", () => {
  it("pause moves state to paused and calls the handle's pause()", async () => {
    const { factory, handles } = makeFakeFactory();
    __setPlaybackFactory(factory);
    await playProgram(program(), OPTS);

    pausePlayer();

    expect(getPlayerState().playState).toBe("paused");
    expect(handles[0].pause).toHaveBeenCalledTimes(1);
  });

  it("resume moves state back to playing and calls the handle's resume()", async () => {
    const { factory, handles } = makeFakeFactory();
    __setPlaybackFactory(factory);
    await playProgram(program(), OPTS);
    pausePlayer();

    resumePlayer();

    expect(getPlayerState().playState).toBe("playing");
    expect(handles[0].resume).toHaveBeenCalledTimes(1);
  });

  it("pause is a no-op when nothing is playing", () => {
    pausePlayer();
    expect(getPlayerState().playState).toBe("idle");
  });
});

describe("stopPlayer", () => {
  it("stops the handle and resets state to idle with no program", async () => {
    const { factory, handles } = makeFakeFactory();
    __setPlaybackFactory(factory);
    await playProgram(program(), OPTS);

    stopPlayer();

    expect(handles[0].stop).toHaveBeenCalledTimes(1);
    const state = getPlayerState();
    expect(state.playState).toBe("idle");
    expect(state.program).toBeNull();
    expect(state.currentIndex).toBe(0);
    expect(state.error).toBeNull();
  });
});

describe("playback callbacks", () => {
  it("onSegment updates currentIndex", async () => {
    const { factory, callbacks } = makeFakeFactory();
    __setPlaybackFactory(factory);
    await playProgram(program(), OPTS);

    callbacks[0].onSegment(1);

    expect(getPlayerState().currentIndex).toBe(1);
  });

  it("onEnd resets playback to idle without clobbering into an error state", async () => {
    const { factory, callbacks } = makeFakeFactory();
    __setPlaybackFactory(factory);
    await playProgram(program(), OPTS);
    callbacks[0].onSegment(1);

    callbacks[0].onEnd();

    const state = getPlayerState();
    expect(state.playState).toBe("idle");
    expect(state.currentIndex).toBe(0);
    expect(state.error).toBeNull();
  });

  it("onError captures the error message and resets playback to idle", async () => {
    const { factory, callbacks } = makeFakeFactory();
    __setPlaybackFactory(factory);
    await playProgram(program(), OPTS);

    callbacks[0].onError(new Error("boom"));

    const state = getPlayerState();
    expect(state.playState).toBe("idle");
    expect(state.error).toBe("boom");
  });

  it("stringifies non-Error error values", async () => {
    const { factory, callbacks } = makeFakeFactory();
    __setPlaybackFactory(factory);
    await playProgram(program(), OPTS);

    callbacks[0].onError("network down");

    expect(getPlayerState().error).toBe("network down");
  });
});

describe("subscribePlayer", () => {
  it("notifies listeners on every state change and stops after unsubscribe", async () => {
    const { factory } = makeFakeFactory();
    __setPlaybackFactory(factory);
    const listener = vi.fn();
    const unsubscribe = subscribePlayer(listener);

    await playProgram(program(), OPTS);
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    unsubscribe();
    pausePlayer();
    expect(listener).not.toHaveBeenCalled();
  });
});

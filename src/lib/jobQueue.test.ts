// The queue keeps mutable module-singleton state (registry, listeners,
// job counter), so each test gets a fresh module instance via
// vi.resetModules() + dynamic import — cheaper and more robust than trying
// to fully drain/reset the previous test's jobs by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobMeta } from "./jobQueue";

type QueueModule = typeof import("./jobQueue");

let enqueueJob: QueueModule["enqueueJob"];
let cancelJob: QueueModule["cancelJob"];
let getJobs: QueueModule["getJobs"];
let subscribeJobQueue: QueueModule["subscribeJobQueue"];
let findPendingJob: QueueModule["findPendingJob"];
let isCancelError: QueueModule["isCancelError"];

function meta(overrides: Partial<JobMeta> = {}): JobMeta {
  return { kind: "article", targetId: "article-1", label: "Article One", lang: "ja", ...overrides };
}

beforeEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  const mod = await import("./jobQueue");
  enqueueJob = mod.enqueueJob;
  cancelJob = mod.cancelJob;
  getJobs = mod.getJobs;
  subscribeJobQueue = mod.subscribeJobQueue;
  findPendingJob = mod.findPendingJob;
  isCancelError = mod.isCancelError;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enqueueJob: sequential FIFO execution", () => {
  it("does not start the second job until the first settles", async () => {
    const order: string[] = [];
    let resolveFirst!: (value: string) => void;

    const first = enqueueJob(meta({ targetId: "a" }), () => {
      order.push("start-a");
      return new Promise<string>((resolve) => {
        resolveFirst = () => {
          order.push("end-a");
          resolve("A");
        };
      });
    });

    const second = enqueueJob(meta({ targetId: "b" }), () => {
      order.push("start-b");
      return Promise.resolve("B");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-a"]);

    resolveFirst("A");
    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
    expect(order).toEqual(["start-a", "end-a", "start-b"]);
  });
});

describe("enqueueJob: resolve/reject pass-through", () => {
  it("resolves the returned promise with run's result", async () => {
    const p = enqueueJob(meta(), () => Promise.resolve("translated"));
    await expect(p).resolves.toBe("translated");
    expect(getJobs().find((j) => j.targetId === "article-1")?.status).toBe("complete");
  });

  it("rejects the returned promise with run's error and records it on the job", async () => {
    const p = enqueueJob(meta(), () => Promise.reject(new Error("boom")));
    await expect(p).rejects.toThrow("boom");
    const job = getJobs().find((j) => j.targetId === "article-1");
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("boom");
  });
});

describe("enqueueJob: dedup", () => {
  it("returns the existing pending job's promise for the same kind+targetId+lang, and allows a new job once settled", async () => {
    let resolveJob!: (value: string) => void;
    const run1 = vi.fn(() => new Promise<string>((resolve) => { resolveJob = resolve; }));
    const run2 = vi.fn(() => Promise.resolve("should-not-run"));

    const p1 = enqueueJob(meta(), run1);
    const p2 = enqueueJob(meta(), run2);

    expect(p2).toBe(p1);
    expect(run2).not.toHaveBeenCalled();

    resolveJob("done");
    await expect(p1).resolves.toBe("done");

    const run3 = vi.fn(() => Promise.resolve("again"));
    const p3 = enqueueJob(meta(), run3);
    expect(p3).not.toBe(p1);
    expect(run3).toHaveBeenCalledTimes(1);
    await expect(p3).resolves.toBe("again");
  });

  it("dedupes lang-less generation jobs by kind+targetId (lang normalized to '')", async () => {
    const run1 = vi.fn(() => new Promise(() => {}));
    const run2 = vi.fn(() => Promise.resolve("should-not-run"));

    const p1 = enqueueJob({ kind: "generate", targetId: "briefing-1", label: "Briefing" }, run1);
    p1.catch(() => {});
    const p2 = enqueueJob({ kind: "generate", targetId: "briefing-1", label: "Briefing" }, run2);
    p2.catch(() => {});

    expect(p2).toBe(p1);
    expect(run2).not.toHaveBeenCalled();

    const job = getJobs().find((j) => j.targetId === "briefing-1");
    expect(job?.lang).toBe("");
  });

  it("does not dedupe across different kinds sharing the same targetId", async () => {
    const run1 = vi.fn(() => new Promise(() => {}));
    const run2 = vi.fn(() => new Promise(() => {}));

    const p1 = enqueueJob({ kind: "program", targetId: "same-id", label: "Program" }, run1);
    p1.catch(() => {});
    const p2 = enqueueJob({ kind: "programAudio", targetId: "same-id", label: "Program Audio" }, run2);
    p2.catch(() => {});

    expect(p2).not.toBe(p1);
    expect(run1).toHaveBeenCalledTimes(1);
    // First job is running; the second (different kind) queues up behind it
    // rather than being deduped away.
    const jobs = getJobs().filter((j) => j.targetId === "same-id");
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.kind).sort()).toEqual(["program", "programAudio"]);
  });
});

describe("cancelJob: queued job", () => {
  it("rejects with an AbortError and never invokes run", async () => {
    // Occupy the active slot so the second job stays queued.
    const blocker = enqueueJob(meta({ targetId: "blocker" }), () => new Promise(() => {}));
    blocker.catch(() => {});

    const run = vi.fn(() => Promise.resolve("x"));
    const queuedPromise = enqueueJob(meta({ targetId: "queued-target" }), run);
    queuedPromise.catch(() => {});

    const info = findPendingJob("article", "queued-target", "ja");
    expect(info?.status).toBe("queued");

    cancelJob(info!.id);

    await expect(queuedPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
    const after = getJobs().find((j) => j.targetId === "queued-target");
    expect(after?.status).toBe("cancelled");
  });
});

describe("cancelJob: running job", () => {
  it("aborts the signal and settles as cancelled once run rejects with AbortError", async () => {
    let capturedSignal: AbortSignal | undefined;
    let rejectRun!: (err: unknown) => void;

    const run = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        rejectRun = reject;
      });
    });

    const p = enqueueJob(meta(), run);
    p.catch(() => {});

    const running = getJobs().find((j) => j.targetId === "article-1");
    expect(running?.status).toBe("running");

    cancelJob(running!.id);
    expect(getJobs().find((j) => j.id === running!.id)?.status).toBe("cancelling");
    expect(capturedSignal?.aborted).toBe(true);

    const abortErr = new Error("Request cancelled.");
    abortErr.name = "AbortError";
    rejectRun(abortErr);

    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(getJobs().find((j) => j.id === running!.id)?.status).toBe("cancelled");
  });

  it("still settles as cancelled (and rejects with AbortError) if run resolves anyway after abort", async () => {
    let resolveRun!: (value: string) => void;
    const run = vi.fn(() => new Promise<string>((resolve) => { resolveRun = resolve; }));

    const p = enqueueJob(meta(), run);
    p.catch(() => {});

    const running = getJobs().find((j) => j.targetId === "article-1");
    cancelJob(running!.id);

    resolveRun("ignored-because-cancelled");

    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(getJobs().find((j) => j.id === running!.id)?.status).toBe("cancelled");
  });
});

describe("retention", () => {
  it("removes finished jobs from the list 8s after they settle", async () => {
    vi.useFakeTimers();

    const p = enqueueJob(meta(), () => Promise.resolve("done"));
    await p;
    expect(getJobs().some((j) => j.targetId === "article-1" && j.status === "complete")).toBe(true);

    await vi.advanceTimersByTimeAsync(8000);
    expect(getJobs().some((j) => j.targetId === "article-1")).toBe(false);
  });
});

describe("subscribeJobQueue", () => {
  it("notifies subscribers on state transitions and stops after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeJobQueue(listener);

    const p = enqueueJob(meta(), () => Promise.resolve("v"));
    await p;
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2); // queued->running, running->complete

    unsubscribe();
    listener.mockClear();

    const p2 = enqueueJob(meta({ targetId: "other" }), () => Promise.resolve("y"));
    await p2;
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("getJobs reference stability", () => {
  it("returns the same array reference until state actually changes", () => {
    const first = getJobs();
    const second = getJobs();
    expect(second).toBe(first);

    const pending = enqueueJob(meta(), () => new Promise(() => {}));
    pending.catch(() => {});
    const third = getJobs();
    expect(third).not.toBe(first);
    expect(getJobs()).toBe(third);
  });
});

describe("isCancelError", () => {
  it("is true for an AbortError-named error", () => {
    const err = new Error("cancelled");
    err.name = "AbortError";
    expect(isCancelError(err)).toBe(true);
  });

  it("is false for a regular error and for non-error values", () => {
    expect(isCancelError(new Error("boom"))).toBe(false);
    expect(isCancelError("AbortError")).toBe(false);
    expect(isCancelError(null)).toBe(false);
    expect(isCancelError(undefined)).toBe(false);
    expect(isCancelError({})).toBe(false);
  });
});

describe("progress reporting", () => {
  it("reflects report() calls made while the job is running", async () => {
    let capturedReport!: (progress: string) => void;
    let resolveRun!: (value: string) => void;

    const p = enqueueJob(meta(), (_signal, report) => {
      capturedReport = report;
      return new Promise<string>((resolve) => {
        resolveRun = resolve;
      });
    });
    p.catch(() => {});

    expect(getJobs().find((j) => j.targetId === "article-1")?.progress).toBe("");

    capturedReport("1/5");
    expect(getJobs().find((j) => j.targetId === "article-1")?.progress).toBe("1/5");

    capturedReport("2/5");
    expect(getJobs().find((j) => j.targetId === "article-1")?.progress).toBe("2/5");

    resolveRun("done");
    await p;
  });

  it("ignores report() calls once the job is no longer running (settled or cancelling)", async () => {
    let capturedReport!: (progress: string) => void;
    let resolveRun!: (value: string) => void;

    const p = enqueueJob(meta(), (_signal, report) => {
      capturedReport = report;
      return new Promise<string>((resolve) => {
        resolveRun = resolve;
      });
    });
    p.catch(() => {});

    resolveRun("done");
    await p;

    // Job is now "complete"; a late report() call must not resurrect progress.
    capturedReport("late-update");
    expect(getJobs().find((j) => j.targetId === "article-1")?.progress).toBe("");
  });

  it("ignores report() calls once cancellation has begun", async () => {
    let capturedReport!: (progress: string) => void;

    const p = enqueueJob(meta(), (_signal, report) => {
      capturedReport = report;
      return new Promise(() => {});
    });
    p.catch(() => {});

    const running = getJobs().find((j) => j.targetId === "article-1");
    cancelJob(running!.id);
    expect(getJobs().find((j) => j.id === running!.id)?.status).toBe("cancelling");

    capturedReport("should-be-ignored");
    expect(getJobs().find((j) => j.id === running!.id)?.progress).toBe("");
  });
});

// Framework-agnostic, module-singleton sequential job queue for LLM-backed
// jobs — translation (feed items and articles) as well as generation
// (article generation, editorial/briefing generation, program generation,
// program audio rendering). Modeled on tc-pdf-viewer's AI job queue (see
// tc-pdf-viewer/src/App.jsx: aiJobs / processAiQueue / enqueueAiJob /
// cancelAiJob), but extracted here as a plain TypeScript module — no Preact
// dependency — because tc-news drives these jobs from several surfaces
// (FeedItemModal, app.tsx article translation, generation views, a
// queue/toast component) that all need the same dedup, cancel, and
// retention semantics. A separate hook layers subscribe/getSnapshot on top
// for Preact consumers (useSyncExternalStore-style).
//
// Sequential by design: the target LLM endpoint is often a local model,
// where concurrent requests just queue up behind each other or fail
// outright, so running one job at a time avoids wasted/conflicting calls.
// That applies just as much to generation jobs (article/program/briefing
// generation, audio rendering) as it does to translation, so they all
// share this one queue rather than each surface managing its own
// concurrency.
//
// Cancel semantics (mirrors tc-pdf-viewer):
// - Cancelling a queued job settles it immediately: status -> "cancelled",
//   its promise rejects with an AbortError-named Error, and `run` is never
//   invoked.
// - Cancelling a running job aborts its AbortSignal and flips status to
//   "cancelling"; the `run` callback decides when it actually stops. If it
//   rejects (whether with an AbortError or not, once cancelling), the job
//   settles as "cancelled". If it resolves anyway (a run that doesn't
//   check the signal), the job is *still* forced to "cancelled" and its
//   promise still rejects with an AbortError — callers can always treat a
//   cancelled job uniformly, regardless of whether `run` cooperated.

export type JobStatus = "queued" | "running" | "cancelling" | "complete" | "failed" | "cancelled";

export type JobKind = "feed" | "article" | "generate" | "orchestrate" | "program" | "programAudio";

export interface JobMeta {
  kind: JobKind;
  targetId: string; // FeedItem.id / NewsArticle.id / program id / etc.
  label: string; // display title for the queue toast
  lang?: string; // target UI locale (lib/i18n Locale value); translation-only, omitted for generation jobs
}

export interface JobInfo {
  id: string;
  kind: JobKind;
  targetId: string;
  label: string;
  lang: string;
  status: JobStatus;
  error: string; // failure message when status === "failed", else ""
  progress: string; // free-text progress (e.g. "2/5"); only meaningful while status === "running"
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

// Reports free-text progress while a job is running. Calls made once the
// job has left "running" (settled, or moved to "cancelling") are ignored —
// a report callback can fire after its job's promise chain has already
// moved on (e.g. a stray microtask from an aborted fetch), and letting that
// mutate a settled/removed job's display would show stale progress on a
// toast entry the user thinks is done.
export type JobReporter = (progress: string) => void;

const RETENTION_MS = 8_000;

type ResolveFn = (value: unknown) => void;
type RejectFn = (err: unknown) => void;

interface InternalJob {
  id: string;
  kind: JobKind;
  targetId: string;
  label: string;
  lang: string;
  status: JobStatus;
  error: string;
  progress: string;
  createdAt: number;
  updatedAt: number;
  controller: AbortController;
  run: (signal: AbortSignal, report: JobReporter) => Promise<unknown>;
  resolve: ResolveFn;
  reject: RejectFn;
  promise: Promise<unknown>;
}

// registry preserves insertion order (Map iteration order), which is what
// gives us FIFO job selection for free.
const registry = new Map<string, InternalJob>();
const listeners = new Set<() => void>();

let jobs: JobInfo[] = [];
let nextJobId = 1;
let activeJobId: string | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function isPendingStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running" || status === "cancelling";
}

function toPublicInfo(job: InternalJob): JobInfo {
  return {
    id: job.id,
    kind: job.kind,
    targetId: job.targetId,
    label: job.label,
    lang: job.lang,
    status: job.status,
    error: job.error,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// Rebuilds the cached snapshot array and notifies subscribers. Only call
// this after an actual mutation so getJobs() keeps a stable reference
// (useSyncExternalStore-style contract) when nothing changed.
function syncSnapshot(): void {
  jobs = Array.from(registry.values()).map(toPublicInfo);
  notify();
}

function updateJob(job: InternalJob, patch: Partial<Pick<InternalJob, "status" | "error" | "progress">>): void {
  if (patch.status !== undefined) job.status = patch.status;
  if (patch.error !== undefined) job.error = patch.error;
  if (patch.progress !== undefined) job.progress = patch.progress;
  job.updatedAt = Date.now();
  syncSnapshot();
}

function abortError(): Error {
  const err = new Error("Request cancelled.");
  err.name = "AbortError";
  return err;
}

export function isCancelError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: unknown }).name === "AbortError";
}

function findExistingPending(kind: JobKind, targetId: string, lang: string): InternalJob | null {
  for (const job of registry.values()) {
    if (job.kind === kind && job.targetId === targetId && job.lang === lang && isPendingStatus(job.status)) {
      return job;
    }
  }
  return null;
}

function findFirstQueued(): InternalJob | undefined {
  for (const job of registry.values()) {
    if (job.status === "queued") return job;
  }
  return undefined;
}

function scheduleRemoval(jobId: string): void {
  setTimeout(() => {
    const job = registry.get(jobId);
    if (!job || isPendingStatus(job.status)) return; // safety net; should already be settled
    registry.delete(jobId);
    syncSnapshot();
  }, RETENTION_MS);
}

// Forces a job to its terminal "cancelled" state and rejects its
// caller-facing promise with an AbortError, regardless of how `run`
// itself settled (see cancel semantics in the module header).
function settleAsCancelled(job: InternalJob, err?: unknown): void {
  updateJob(job, { status: "cancelled", error: "" });
  job.reject(isCancelError(err) ? err : abortError());
}

function processQueue(): void {
  if (activeJobId) return;
  const next = findFirstQueued();
  if (!next) return;

  activeJobId = next.id;
  updateJob(next, { status: "running" });

  const report: JobReporter = (progress) => {
    // See JobReporter doc comment: only reflect progress while this job is
    // still the one actually running.
    if (next.status !== "running") return;
    updateJob(next, { progress });
  };

  next.run(next.controller.signal, report)
    .then((result) => {
      if (next.status === "cancelling") {
        settleAsCancelled(next);
        return;
      }
      updateJob(next, { status: "complete", error: "" });
      next.resolve(result);
    })
    .catch((err: unknown) => {
      if (next.status === "cancelling" || isCancelError(err)) {
        settleAsCancelled(next, err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      updateJob(next, { status: "failed", error: message });
      next.reject(err);
    })
    // The queue attaches its own bookkeeping here so a rejection never
    // becomes an unhandled rejection inside this module; the promise
    // handed back from enqueueJob still rejects normally for the caller,
    // who is expected to handle it.
    .finally(() => {
      activeJobId = null;
      scheduleRemoval(next.id);
      processQueue();
    });
}

/**
 * Enqueues a job, or — if a pending (queued/running/cancelling) job with
 * the same kind+targetId+lang already exists — returns that job's existing
 * promise instead of starting a duplicate. `lang` is only meaningful for
 * translation jobs; generation jobs omit it and it's normalized to "" for
 * dedup purposes.
 */
export function enqueueJob<T>(
  meta: JobMeta,
  run: (signal: AbortSignal, report: JobReporter) => Promise<T>,
): Promise<T> {
  const lang = meta.lang ?? "";
  const existing = findExistingPending(meta.kind, meta.targetId, lang);
  if (existing) return existing.promise as Promise<T>;

  const id = `job-${nextJobId}`;
  nextJobId += 1;
  const now = Date.now();

  let resolve!: ResolveFn;
  let reject!: RejectFn;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const job: InternalJob = {
    id,
    kind: meta.kind,
    targetId: meta.targetId,
    label: meta.label,
    lang,
    status: "queued",
    error: "",
    progress: "",
    createdAt: now,
    updatedAt: now,
    controller: new AbortController(),
    run,
    resolve,
    reject,
    promise,
  };

  registry.set(id, job);
  syncSnapshot();
  processQueue();
  return promise as Promise<T>;
}

export function cancelJob(jobId: string): void {
  const job = registry.get(jobId);
  if (!job || !isPendingStatus(job.status)) return;

  if (job.status === "queued") {
    updateJob(job, { status: "cancelled", error: "" });
    job.reject(abortError());
    scheduleRemoval(jobId);
    return;
  }

  updateJob(job, { status: "cancelling", error: "" });
  job.controller.abort();
}

export function getJobs(): JobInfo[] {
  return jobs;
}

export function subscribeJobQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function findPendingJob(kind: JobKind, targetId: string, lang?: string): JobInfo | null {
  const job = findExistingPending(kind, targetId, lang ?? "");
  return job ? toPublicInfo(job) : null;
}

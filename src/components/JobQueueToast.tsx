// Passive progress toast for the global AI job queue. Modeled on
// tc-pdf-viewer's ai-queue-toast: translation and generation jobs alike run
// through a single sequential queue (lib/jobQueue) rather than inline
// per-view state, so a job can keep running (or fail, or wait its turn)
// after the user has closed the modal or navigated away from the view that
// started it. This toast is the only place that queue is ever visible
// again, so it renders at the app root, independent of whatever view/modal
// is currently open.
import type { JSX } from "preact";
import { Loader2, X } from "lucide-preact";
import { useT, type TFunc } from "../lib/i18n";
import { cancelJob, type JobInfo } from "../lib/jobQueue";
import { useJobQueue } from "../hooks/useJobQueue";
import "../styles/queueToast.css";

// Reference (tc-pdf-viewer App.jsx ~1237-1280) shows only the most recent
// handful of jobs so the toast can't grow unbounded while a long batch runs.
const MAX_VISIBLE_JOBS = 4;

const CANCELLABLE_STATUSES: ReadonlySet<JobInfo["status"]> = new Set([
  "queued",
  "running",
  "cancelling",
]);

// Running-status wording differs by job kind (translation vs. the various
// generation flows); everything else in the status lifecycle is shared.
function runningText(t: TFunc, kind: JobInfo["kind"]): string {
  switch (kind) {
    case "feed":
    case "article":
      return t("translate.translating");
    case "generate":
    case "orchestrate":
      return t("translate.statusGeneratingArticle");
    case "program":
      return t("translate.statusGeneratingProgram");
    case "programAudio":
      return t("translate.statusRenderingAudio");
    default:
      return t("translate.translating");
  }
}

function statusText(t: TFunc, job: JobInfo): string {
  switch (job.status) {
    case "queued":
      return t("translate.statusQueued");
    case "running": {
      const base = runningText(t, job.kind);
      return job.progress ? `${base} ${job.progress}` : base;
    }
    case "cancelling":
      return t("translate.statusCancelling");
    case "cancelled":
      return t("translate.statusCancelled");
    case "complete":
      return t("translate.statusDone");
    case "failed":
      return t("translate.statusFailed", { detail: job.error });
    default:
      return job.status;
  }
}

export function JobQueueToast(): JSX.Element | null {
  const t = useT();
  const jobs = useJobQueue();

  if (jobs.length === 0) return null;

  const queuedCount = jobs.filter((job) => job.status === "queued").length;
  const visibleJobs = jobs.slice(-MAX_VISIBLE_JOBS);

  return (
    <div class="tq-toast">
      <div class="tq-header">
        <span class="tq-title">{t("translate.queueTitle")}</span>
        {queuedCount > 0 && (
          <span class="tq-count">{t("translate.queueCount", { count: String(queuedCount) })}</span>
        )}
      </div>
      <div class="tq-list">
        {visibleJobs.map((job) => (
          <div key={job.id} class={`tq-item tq-item--${job.status}`}>
            <div class="tq-item-main">
              <div class="tq-label" title={job.label}>
                {job.label}
              </div>
              <div class="tq-status">
                {job.status === "running" && <Loader2 size={12} class="spin" />}
                <span>{statusText(t, job)}</span>
              </div>
            </div>
            {CANCELLABLE_STATUSES.has(job.status) && (
              <button
                type="button"
                class="tq-cancel"
                aria-label={t("common.cancel")}
                onClick={() => cancelJob(job.id)}
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useRef } from "preact/hooks";
import { beginReading, updateReading } from "../lib/interestStore";
import type { RecommendationCandidate } from "../lib/recommendationTypes";

export type ReadingContentState = "loading" | "full" | "summary" | "error";

const FLUSH_INTERVAL_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_READING_MS = 120_000;
const MAX_SUMMARY_MS = 10_000;

/** Measure visible reading, independently from network/translation waiting.
 * Session tokens let the store reject late writes after pause or reset. */
export function useReadingInterest(
  candidate: RecommendationCandidate | null,
  contentState: ReadingContentState,
): void {
  const control = useRef<{ transition: (state: ReadingContentState) => void } | null>(null);
  const latest = useRef({ candidate, contentState });
  latest.current = { candidate, contentState };

  useEffect(() => {
    const current = latest.current.candidate;
    if (!current) return;
    const sessionId = beginReading(current);
    if (!sessionId) return;

    let state = latest.current.contentState;
    let focused = document.hasFocus();
    let visible = document.visibilityState !== "hidden";
    let checkpoint = performance.now();
    let lastActivity = checkpoint;
    let fullMs = 0;
    let summaryMs = 0;
    let lastFullSent = 0;
    let lastSummarySent = 0;

    function accrue() {
      const now = performance.now();
      if (visible && focused && (state === "full" || state === "summary")) {
        const elapsed = Math.max(0, Math.min(now, lastActivity + IDLE_TIMEOUT_MS) - checkpoint);
        const remaining = Math.max(0, MAX_READING_MS - fullMs - summaryMs);
        if (state === "full") fullMs += Math.min(elapsed, remaining);
        else summaryMs += Math.min(elapsed, remaining, MAX_SUMMARY_MS - summaryMs);
      }
      checkpoint = now;
    }

    function flush() {
      accrue();
      if (summaryMs > lastSummarySent) {
        updateReading(current!, sessionId!, summaryMs, "summary");
        lastSummarySent = summaryMs;
      }
      if (fullMs > lastFullSent) {
        updateReading(current!, sessionId!, fullMs, "full");
        lastFullSent = fullMs;
      }
    }

    function transition(next: ReadingContentState) {
      flush();
      if (next !== state) lastActivity = performance.now();
      state = next;
    }

    function onFocus() {
      accrue();
      focused = true;
      lastActivity = performance.now();
    }
    function onBlur() {
      flush();
      focused = false;
    }
    function onVisibilityChange() {
      flush();
      visible = document.visibilityState !== "hidden";
      if (visible) lastActivity = performance.now();
    }
    function onActivity() {
      accrue();
      if (visible && focused) lastActivity = performance.now();
    }

    control.current = { transition };
    const interval = window.setInterval(flush, FLUSH_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const activityEvents = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const name of activityEvents) document.addEventListener(name, onActivity, { capture: true, passive: true });
    return () => {
      flush();
      control.current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const name of activityEvents) document.removeEventListener(name, onActivity, true);
    };
    // Candidate object churn (P2P refreshes, translations) is not a new open.
  }, [candidate?.key]);

  useEffect(() => {
    control.current?.transition(contentState);
  }, [contentState]);
}

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { recordImpression } from "../lib/interestStore";
import { RECOMMENDATION_VERSION } from "../lib/recommendation";
import { useT } from "../lib/i18n";
import type { RankedRecommendation } from "../lib/recommendationTypes";
import { RecommendationFeedback } from "./RecommendationFeedback";
import { useDeveloperMode } from "../hooks/useDeveloperMode";

/** Only visible, foreground cards count as exposures; mounting below the fold
 * is not feedback. A modal can explicitly suspend the underlying list. */
export function RecommendationItem({ entry, position, sessionId, enabled, personalized, children }: {
  entry: RankedRecommendation; position: number; sessionId: string;
  enabled: boolean; personalized: boolean; children: ComponentChildren;
}) {
  const t = useT();
  const developerMode = useDeveloperMode();
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ entry, position });
  latest.current = { entry, position };
  useEffect(() => {
    if (!enabled || !root.current || typeof IntersectionObserver === "undefined") return;
    let visible = false;
    let done = false;
    let focused = document.hasFocus();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const candidateKey = entry.candidate.key;
    function eligible() {
      return !done && visible && focused && document.visibilityState === "visible"
        && latest.current.entry.candidate.key === candidateKey;
    }
    function update() {
      if (!eligible()) {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      // Repeated observer notifications above the threshold are one continuous
      // exposure; they must not restart its one-second timer.
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!eligible()) return;
        done = true;
        recordImpression(latest.current.entry.candidate, latest.current.position, RECOMMENDATION_VERSION, sessionId);
      }, 1000);
    }
    function onFocus() {
      focused = true;
      update();
    }
    function onBlur() {
      // hasFocus() can still report true while the blur event is dispatched.
      focused = false;
      update();
    }
    const observer = new IntersectionObserver((entries) => {
      for (const item of entries) {
        if (item.target === root.current) visible = item.isIntersecting && item.intersectionRatio >= 0.5;
      }
      update();
    }, { threshold: 0.5 });
    observer.observe(root.current);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      done = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [entry.candidate.key, sessionId, enabled]);
  return (
    <div ref={root} class="recommendation-item">
      {children}
      <div class="recommendation-item-footer">
        {developerMode && personalized ? <p class="recommendation-reason">{t(`recommendation.${entry.reason}`)}</p> : <span />}
        <RecommendationFeedback candidate={entry.candidate} compact />
      </div>
    </div>
  );
}

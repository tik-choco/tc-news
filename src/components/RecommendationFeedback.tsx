import { useInterests } from "../hooks/useInterests";
import { setInterestFeedback } from "../lib/interestStore";
import { useT } from "../lib/i18n";
import type { RecommendationCandidate } from "../lib/recommendationTypes";
import "../styles/recommendation.css";

export function RecommendationFeedback({ candidate, compact = false }: {
  candidate: RecommendationCandidate; compact?: boolean;
}) {
  const state = useInterests();
  const t = useT();
  if (!state.enabled) return null;
  const current = state.records.find((r) => r.candidate.key === candidate.key)?.feedback;
  const actions = (
    <div class="recommendation-feedback" role="group" aria-label={t("recommendation.options")}>
      <button type="button" class="btn btn-ghost btn-small" aria-pressed={current === "more"}
        onClick={() => setInterestFeedback(candidate, current === "more" ? null : "more")}>
        {t("recommendation.more")}
      </button>
      <button type="button" class="btn btn-ghost btn-small" aria-pressed={current === "less"}
        onClick={() => setInterestFeedback(candidate, current === "less" ? null : "less")}>
        {t(current === "less" ? "recommendation.undo" : "recommendation.less")}
      </button>
    </div>
  );
  return compact ? (
    <details class="recommendation-options">
      <summary aria-label={t("recommendation.options")} title={t("recommendation.options")}>···</summary>
      {actions}
    </details>
  ) : actions;
}

// Card-style panel that shows one LLM-judge evaluation result: overall score,
// the 5 rubric axes as horizontal bars, the evaluator's notes and
// suggestions, and a close button. Meant to be slotted above ArticleReader
// (see ArticlesView) — self-contained, no data fetching of its own.
import type { JSX } from "preact";
import { X } from "lucide-preact";
import { ARTICLE_AXES, type ArticleEvaluationRecord } from "../lib/articleEvaluation";
import { useT } from "../lib/i18n";
import "../styles/components.css";

export function EvaluationPanel(props: {
  record: ArticleEvaluationRecord;
  onClose: () => void;
}): JSX.Element {
  const { record, onClose } = props;
  const t = useT();

  return (
    <section class="evaluation-panel">
      <header class="evaluation-panel-header">
        <div class="evaluation-panel-overall">
          <span class="evaluation-panel-overall-value">{Math.round(record.overallScore)}</span>
          <span class="evaluation-panel-overall-label">{t("articles.evalOverall")}</span>
        </div>
        <button
          type="button"
          class="icon-btn"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>

      <ul class="evaluation-panel-axes">
        {ARTICLE_AXES.map((axis) => {
          const score = record.scores[axis.key] ?? 0;
          return (
            <li key={axis.key} class="evaluation-panel-axis">
              <div class="evaluation-panel-axis-label">
                <span>{t(`articles.axis_${axis.key}`)}</span>
                <span class="evaluation-panel-axis-score">{score}/5</span>
              </div>
              <div class="evaluation-panel-axis-bar">
                <div
                  class="evaluation-panel-axis-bar-fill"
                  style={{ width: `${Math.max(0, Math.min(5, score)) * 20}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {record.notes ? (
        <div class="evaluation-panel-notes">
          <h3>{t("articles.evalNotes")}</h3>
          <p>{record.notes}</p>
        </div>
      ) : null}

      {record.suggestions.length > 0 ? (
        <div class="evaluation-panel-suggestions">
          <h3>{t("articles.evalSuggestions")}</h3>
          <ul>
            {record.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

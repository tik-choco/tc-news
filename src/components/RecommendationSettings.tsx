import { useState } from "preact/hooks";
import { useInterests } from "../hooks/useInterests";
import { resetInterests, setInterestEnabled, setInterestFeedback, setRecommendationMode } from "../lib/interestStore";
import { useT } from "../lib/i18n";
import "../styles/recommendation.css";

export function RecommendationSettings() {
  const state = useInterests();
  const t = useT();
  const [resetDone, setResetDone] = useState(false);
  const hidden = state.records.filter((record) => record.feedback === "less");
  return (
    <section class="recommendation-settings" aria-labelledby="recommendation-settings-heading">
      <h2 id="recommendation-settings-heading" class="settings-heading">{t("recommendation.settings")}</h2>
      <p class="field-hint">{t("recommendation.hint")}</p>
      <label class="checkbox-field">
        <input type="checkbox" checked={state.enabled}
          onChange={(e) => { setInterestEnabled(e.currentTarget.checked); setResetDone(false); }} />
        <span>{t("recommendation.enabled")}<span class="field-hint">{t("recommendation.privacy")}</span></span>
      </label>
      {!state.enabled ? <p class="field-hint">{t("recommendation.paused")}</p> : null}
      <label class="field">
        <span>{t("recommendation.order")}</span>
        <select value={state.enabled ? state.mode : "latest"} disabled={!state.enabled}
          onChange={(e) => { setRecommendationMode(e.currentTarget.value === "latest" ? "latest" : "recommended"); setResetDone(false); }}>
          <option value="recommended">{t("recommendation.recommended")}</option>
          <option value="latest">{t("recommendation.latest")}</option>
        </select>
      </label>
      <div>
        <button type="button" class="btn btn-ghost btn-small" onClick={() => {
          resetInterests(); setResetDone(true);
        }}>{t("recommendation.reset")}</button>
        {resetDone ? <p class="field-hint" role="status">{t("recommendation.resetDone")}</p> : null}
      </div>
      {hidden.length > 0 ? (
        <details class="recommendation-hidden">
          <summary>{t("recommendation.hidden", { count: hidden.length })}</summary>
          <ul>{hidden.map(({ candidate }) => (
            <li key={candidate.key}><span>{candidate.title}</span>
              <button type="button" class="btn btn-ghost btn-small" onClick={() => setInterestFeedback(candidate, null)}>
                {t("recommendation.restore")}
              </button>
            </li>
          ))}</ul>
        </details>
      ) : null}
    </section>
  );
}

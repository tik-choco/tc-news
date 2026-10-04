import { setDeveloperMode, useDeveloperMode } from "../hooks/useDeveloperMode";
import { useT } from "../lib/i18n";

export function DeveloperSettings() {
  const enabled = useDeveloperMode();
  const t = useT();
  return <label class="checkbox-field">
    <input type="checkbox" checked={enabled} onChange={(event) => setDeveloperMode(event.currentTarget.checked)} />
    <span>{t("settings.developerMode")}<span class="field-hint">{t("settings.developerModeHint")}</span></span>
  </label>;
}

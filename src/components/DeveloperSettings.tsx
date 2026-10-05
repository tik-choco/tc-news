import { setDeveloperMode, useDeveloperMode } from "../hooks/useDeveloperMode";
import { useT } from "../lib/i18n";
import { Switch } from "@tik-choco/mistai/preact";
import "@tik-choco/mistai/ui.css";

export function DeveloperSettings() {
  const enabled = useDeveloperMode();
  const t = useT();
  return <div class="checkbox-field">
    <Switch label={t("settings.developerMode")} checked={enabled} onChange={setDeveloperMode} />
    <span>{t("settings.developerMode")}<span class="field-hint">{t("settings.developerModeHint")}</span></span>
  </div>;
}

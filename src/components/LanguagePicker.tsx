// Compact target-language selector for reader toolbars (article reader,
// feed item modal, program script pane): a globe icon + native <select>
// over LOCALES. Native select rather than a custom dropdown — free
// keyboard/screen-reader behavior and no outside-click plumbing, matching
// the app's lean-dependency style.
//
// Selecting the content's own source language is allowed on purpose: every
// consumer treats "targetLang === source lang" as "no translation needed"
// (their translate affordance simply hides), so the picker doubles as the
// way back to the original without a separate reset control.
import type { JSX } from "preact";
import { Globe } from "lucide-preact";
import { LOCALES, LOCALE_LABELS, isLocale, useT, type Locale } from "../lib/i18n";
import "../styles/languagePicker.css";

export function LanguagePicker(props: {
  value: Locale;
  onChange: (lang: Locale) => void;
  disabled?: boolean;
}): JSX.Element {
  const t = useT();
  return (
    <label class="lang-picker" title={t("translate.targetLanguage")}>
      <Globe size={14} aria-hidden="true" />
      <select
        class="lang-picker-select"
        aria-label={t("translate.targetLanguage")}
        disabled={props.disabled}
        value={props.value}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          if (isLocale(v)) props.onChange(v);
        }}
      >
        {LOCALES.map((loc) => (
          <option key={loc} value={loc}>
            {LOCALE_LABELS[loc]}
          </option>
        ))}
      </select>
    </label>
  );
}

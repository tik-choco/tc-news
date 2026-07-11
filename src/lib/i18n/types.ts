/** The languages tc-news ships with, so anyone in the world can use it. */
export const LOCALES = ["ja", "en", "zh", "ko", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * The language every t() key is *authored* in and the ultimate fallback: if a
 * translation is missing a key, we show the Japanese source rather than a raw
 * key. It's also what useT() returns with no provider, so unit tests that
 * render components bare keep seeing Japanese text (no test churn).
 */
export const SOURCE_LOCALE: Locale = "ja";

/** Native, self-referential names for the language switcher (endonyms). */
export const LOCALE_LABELS: Record<Locale, string> = {
  ja: "日本語",
  en: "English",
  zh: "简体中文",
  ko: "한국어",
  es: "Español",
  fr: "Français",
};

export function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v);
}

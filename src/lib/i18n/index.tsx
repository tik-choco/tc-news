import { createContext } from "preact";
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import { LOCALES, SOURCE_LOCALE, isLocale, type Locale } from "./types";
export { isLocale };
import { ja, en, type Messages } from "./messages";
import { zh } from "./locales/zh";
import { ko } from "./locales/ko";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { safeSetItem } from "../safeStorage";

export { LOCALES, LOCALE_LABELS, SOURCE_LOCALE, type Locale } from "./types";
export type { Messages } from "./messages";

const CATALOGS: Record<Locale, Messages> = { ja, en, zh, ko, es, fr };

const STORAGE_KEY = "tc-news:locale";

/** Interpolation params for a message template's `{name}` placeholders. */
export type TParams = Record<string, string | number>;
export type TFunc = (key: string, params?: TParams) => string;

function interpolate(tpl: string, params?: TParams): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (whole, k: string) =>
    k in params ? String(params[k]) : whole,
  );
}

/** Walk a dotted key path ("feed.refresh") into a catalog; undefined if absent. */
function resolve(msgs: Messages, key: string): string | undefined {
  const value = key
    .split(".")
    .reduce<unknown>(
      (obj, part) =>
        obj && typeof obj === "object" ? (obj as Record<string, unknown>)[part] : undefined,
      msgs,
    );
  return typeof value === "string" ? value : undefined;
}

/**
 * Translate a key in a specific locale. Missing keys fall back to the source
 * (ja) language, then to the raw key — so the UI degrades to readable text, not
 * blanks, no matter which translations have landed.
 */
export function translate(locale: Locale, key: string, params?: TParams): string {
  const raw = resolve(CATALOGS[locale], key) ?? resolve(CATALOGS[SOURCE_LOCALE], key) ?? key;
  return interpolate(raw, params);
}

/** Best-effort language pick from the browser; unknown languages get English. */
function detectLocale(): Locale {
  const prefs =
    typeof navigator !== "undefined"
      ? navigator.languages ?? (navigator.language ? [navigator.language] : [])
      : [];
  for (const pref of prefs) {
    const base = pref.toLowerCase().split("-")[0];
    const match = LOCALES.find((l) => l === base);
    if (match) return match;
  }
  return "en";
}

/** Persisted choice wins; otherwise detect from the browser. */
export function getInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && isLocale(saved)) return saved;
  } catch {
    // localStorage unavailable (private mode / SSR) — fall through to detection.
  }
  return detectLocale();
}

/**
 * Non-reactive current locale, for the rare non-component caller (e.g. seeding a
 * default room name). Components should use useLocale()/useT() so they re-render
 * on change.
 */
export function getLocale(): Locale {
  return getInitialLocale();
}

/**
 * Translate outside of a component tree — for hook-free lib code (rss.ts,
 * llm.ts, generate.ts error paths) that can't call useT(). Resolves the
 * current locale the same way the provider seeds itself (persisted choice,
 * else browser detection) and translates against it. Not reactive: it reads
 * localStorage fresh on every call, so it always reflects the latest choice
 * even though it isn't tied to a re-render.
 */
export function tGlobal(key: string, params?: TParams): string {
  return translate(getInitialLocale(), key, params);
}

type I18nContextValue = { locale: Locale; setLocale: (l: Locale) => void; t: TFunc };

const I18nContext = createContext<I18nContextValue | null>(null);

export function LocaleProvider(props: { children: ComponentChildren }) {
  const [locale, setLocaleState] = useState<Locale>(() => getInitialLocale());

  useEffect(() => {
    // Keep <html lang> in sync for accessibility / correct hyphenation.
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: (l: Locale) => {
        // Persistence is best-effort; the in-memory switch still applies
        // even if safeSetItem drops the write.
        safeSetItem(STORAGE_KEY, l);
        setLocaleState(l);
      },
      t: (key, params) => translate(locale, key, params),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

/**
 * The translator for the current locale. With no provider (e.g. a component
 * rendered bare in a unit test) it falls back to the source language, so tests
 * keep seeing Japanese without wrapping every render.
 */
export function useT(): TFunc {
  const ctx = useContext(I18nContext);
  return ctx ? ctx.t : (key, params) => translate(SOURCE_LOCALE, key, params);
}

/** Current locale + setter for the language switcher. */
export function useLocale(): { locale: Locale; setLocale: (l: Locale) => void } {
  const ctx = useContext(I18nContext);
  if (ctx) return { locale: ctx.locale, setLocale: ctx.setLocale };
  return { locale: SOURCE_LOCALE, setLocale: () => {} };
}

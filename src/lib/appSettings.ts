// General app preferences (theme, display name, room, RSS refresh policy),
// persisted to localStorage. JSON in localStorage is parsed defensively
// (never trust stored content — fields are type-coerced, invalid entries
// fall back to defaults), following tc-town's lib/appSettings.ts pattern.

import type { AppSettings, MainTab } from "../types";

const SETTINGS_KEY = "tc-news:app-settings";

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "light",
  userName: "",
  roomId: "tc-news",
  corsProxy: "https://corsproxy.io/?url=",
  refreshIntervalMin: 30,
  autoGenerate: false,
  globalShare: true,
  showMediaPreviews: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTheme(value: unknown): value is AppSettings["theme"] {
  return value === "light" || value === "dark";
}

/** Coerces a parsed record into a valid AppSettings, falling back field-by-field to the defaults. */
function sanitizeAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return { ...DEFAULT_APP_SETTINGS };
  const refreshIntervalMin =
    typeof value.refreshIntervalMin === "number" && Number.isFinite(value.refreshIntervalMin)
      ? Math.max(0, value.refreshIntervalMin)
      : DEFAULT_APP_SETTINGS.refreshIntervalMin;
  return {
    theme: isTheme(value.theme) ? value.theme : DEFAULT_APP_SETTINGS.theme,
    userName: typeof value.userName === "string" ? value.userName : DEFAULT_APP_SETTINGS.userName,
    roomId: typeof value.roomId === "string" && value.roomId ? value.roomId : DEFAULT_APP_SETTINGS.roomId,
    corsProxy: typeof value.corsProxy === "string" ? value.corsProxy : DEFAULT_APP_SETTINGS.corsProxy,
    refreshIntervalMin,
    autoGenerate: value.autoGenerate === true,
    // 既存ユーザー(キー無し)はtrue扱い — グローバル配信は既定オン。
    globalShare: value.globalShare !== false,
    showMediaPreviews: typeof value.showMediaPreviews === "boolean" ? value.showMediaPreviews : true,
  };
}

export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    return sanitizeAppSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("tc-news: failed to persist app settings", error);
  }
}

/**
 * 起動時に最初に見せるのは常に "feed"(ホーム=ブリーフィング+フィード)。
 * 以前は "shared"(みんな)着地だったが、4タブ再編でfeedタブが
 * 記事の閲覧・評価・翻訳・共有まで一通りこなす完成品になったため、
 * 起動直後から読める状態としてホームを既定にした。
 */
export function resolveInitialTab(): MainTab {
  return "feed";
}

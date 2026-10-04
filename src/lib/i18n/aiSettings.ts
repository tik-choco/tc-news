import type { LlmSettingsLocale } from "@tik-choco/mistai/preact";
export const AI_SETTINGS_MESSAGES = {
  en: { ai: "AI", default: "General tasks", defaultTip: "Used for generation, evaluation, translation and programs.", orchestrator: "Editorial: planning", orchestratorTip: "Plans the editorial team's articles.", worker: "Editorial: writing", workerTip: "Writes each article in the editorial plan." },
  ja: { ai: "AI", default: "一般タスク", defaultTip: "記事生成・評価・翻訳・番組に使用します。", orchestrator: "編集部: 計画", orchestratorTip: "編集部の記事構成を計画します。", worker: "編集部: 執筆", workerTip: "編集部の計画に沿って各記事を執筆します。" },
  "zh-CN": { ai: "AI", default: "常规任务", defaultTip: "用于生成、评估、翻译和节目。", orchestrator: "编辑部：规划", orchestratorTip: "规划编辑部的文章。", worker: "编辑部：撰写", workerTip: "按编辑计划撰写各篇文章。" },
  "zh-TW": { ai: "AI", default: "一般任務", defaultTip: "用於生成、評估、翻譯和節目。", orchestrator: "編輯部：規劃", orchestratorTip: "規劃編輯部的文章。", worker: "編輯部：撰寫", workerTip: "依照編輯計畫撰寫各篇文章。" },
};
export function aiSettingsLocale(locale: string): LlmSettingsLocale {
  if (locale === "ja" || locale === "zh-CN" || locale === "zh-TW") return locale;
  if (locale === "zh") return /(?:TW|HK|Hant)/i.test(navigator.language) ? "zh-TW" : "zh-CN";
  return "en";
}

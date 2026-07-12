// Lib-layer error/fallback wording — used from hook-free code (rss.ts,
// llm.ts, models.ts, generate.ts, chatShare.ts) via tGlobal("errors.xxx")
// since that code runs outside any component tree and can't call useT().
//
// Pattern for every catalog file: author `ja` (the source), then `en` typed as
// `typeof ja` so TypeScript flags any key present in one but missing in the
// other. Additional languages live in ../locales/<lang>.ts.
const ja = {
  feedFetchFailed: "フィードの取得に失敗しました({label}): {detail}",
  feedFetchNoCorsProxy:
    "「{label}」をブラウザから直接取得できません(CORS)。設定画面でCORSプロキシを設定してください。",
  llmNotConfigured: "LLMが設定されていません。設定画面でプロバイダーとプリセットを追加してください。",
  llmEmptyResponse: "プロバイダーが空の応答を返しました。",
  llmCallFailed: "LLM呼び出しに失敗しました。",
  modelListFailed: "モデル一覧の取得に失敗しました。",
  voiceListFailed: "ボイス一覧の取得に失敗しました。",
  sourceLinksHeading: "出典リンク一覧",
  evalFailed: "記事の評価に失敗しました: {detail}",
  translateFailed: "記事の翻訳に失敗しました: {detail}",
};

const en: typeof ja = {
  feedFetchFailed: "Failed to fetch feed ({label}): {detail}",
  feedFetchNoCorsProxy:
    'Cannot fetch "{label}" directly from the browser (CORS). Set a CORS proxy in Settings to fix this.',
  llmNotConfigured: "No LLM is configured. Add a provider and a preset in Settings.",
  llmEmptyResponse: "The provider returned an empty response.",
  llmCallFailed: "The LLM request failed.",
  modelListFailed: "Failed to load the model list.",
  voiceListFailed: "Failed to load the voice list.",
  sourceLinksHeading: "Source Links",
  evalFailed: "Failed to evaluate the article: {detail}",
  translateFailed: "Failed to translate the article: {detail}",
};

export const errors = { ja, en };

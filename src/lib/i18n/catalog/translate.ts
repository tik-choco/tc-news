// Translate-on-demand strings: the reader-toolbar button in ArticlesView and
// SharedView, the original/translated toggle, and the "translated" badge.
//
// Pattern for every catalog file: author `ja` (the source), then `en` typed as
// `typeof ja` so TypeScript flags any key present in one but missing in the
// other. Additional languages live in ../locales/<lang>.ts.
const ja = {
  translate: "翻訳",
  translating: "翻訳中...",
  translatingProgress: "翻訳中... {done}/{total}",
  resume: "翻訳を再開",
  showOriginal: "原文を表示",
  showTranslated: "翻訳を表示",
  translatedBadge: "翻訳済み({lang})",
  truncatedNote: "長文のため一部のみ翻訳しています。",
  targetLanguage: "翻訳先言語",
  programAudioOriginalNote: "音声は原語のままです。",
  queueTitle: "AIキュー",
  queueCount: "{count}件待機中",
  statusQueued: "待機中",
  statusCancelling: "キャンセル中...",
  statusCancelled: "キャンセルしました",
  statusDone: "完了",
  statusFailed: "失敗: {detail}",
  statusGeneratingArticle: "記事を生成中…",
  statusGeneratingProgram: "番組を生成中…",
  statusRenderingAudio: "音声を作成中…",
};

const en: typeof ja = {
  translate: "Translate",
  translating: "Translating...",
  translatingProgress: "Translating... {done}/{total}",
  resume: "Resume translation",
  showOriginal: "Show original",
  showTranslated: "Show translation",
  translatedBadge: "Translated ({lang})",
  truncatedNote: "Only part of this long article was translated.",
  targetLanguage: "Target language",
  programAudioOriginalNote: "Audio remains in the original language.",
  queueTitle: "AI queue",
  queueCount: "{count} queued",
  statusQueued: "Queued",
  statusCancelling: "Cancelling...",
  statusCancelled: "Cancelled",
  statusDone: "Done",
  statusFailed: "Failed: {detail}",
  statusGeneratingArticle: "Generating article…",
  statusGeneratingProgram: "Generating program…",
  statusRenderingAudio: "Rendering audio…",
};

export const translate = { ja, en };

// First-run onboarding wizard strings (components/Onboarding.tsx) plus the
// re-open entry shown in the settings screen. Follows the catalog pattern:
// `ja` is the source of truth, `en` is typed as `typeof ja` so a missing key
// is a compile error. Other languages live in ../locales/<lang>.ts.
const ja = {
  // Settings screen re-open entry
  reopenTitle: "はじめに",
  reopenHint: "初回セットアップ(LLM接続・ニックネーム)のガイドをもう一度開けます。",
  reopenButton: "セットアップガイドを開く",

  // Wizard chrome
  dialogAria: "はじめてのセットアップ",
  close: "閉じる",
  back: "戻る",
  next: "次へ",
  start: "はじめる",
  saveAndNext: "保存して次へ",
  finish: "完了",

  // Step 0: welcome
  welcomeTitle: "TC News へようこそ!",
  welcomeBody1:
    "TC News は、RSSフィードのニュースをもとにAIが記事を書き、P2Pルームでみんなと共有できるニュースアプリです。",
  welcomeBody2:
    "まずは2つだけ準備しましょう:LLMの接続設定と、共有で使うニックネームです。どちらもあとから設定画面でいつでも変更できます。",

  // Step 1: LLM connection
  llmTitle: "LLMの接続設定",
  llmIntro:
    "記事の生成・評価・翻訳に使う LLM を設定します。OpenAI 互換の API ならどれでも使えます(OpenAI、LM Studio、Ollama など)。",
  baseUrlLabel: "ベースURL",
  baseUrlPlaceholder: "例: https://api.openai.com/v1 / http://localhost:1234/v1",
  apiKeyLabel: "APIキー(不要なら空欄)",
  modelLabel: "モデル",
  testButton: "接続テスト",
  testBusy: "接続中...",
  testOk: "接続できました!",
  testError: "接続に失敗しました: {message}",
  testMessage: "接続テストです。「OK」とだけ返してください。",

  // Step 2: nickname
  nameTitle: "ニックネームを設定",
  nameIntro:
    "記事を共有したときに表示される名前です。空欄のままなら「匿名」と表示されます。あとから設定画面で変更できます。",
  nameLabel: "ニックネーム",
  namePlaceholder: "例: ふくろう",

  // Step 3: feature tour
  tourTitle: "準備完了です!",
  tourIntro: "TC News でできること:",
  tourFeedTitle: "フィード",
  tourFeedDesc: "RSSフィードを登録し、気になる見出しからAIが記事を生成します",
  tourArticlesTitle: "記事",
  tourArticlesDesc: "生成した記事の編集・品質評価・翻訳・共有ができます",
  tourSharedTitle: "共有",
  tourSharedDesc: "P2Pルームとグローバル配信で、みんなの記事をリアルタイムに読めます",
  tourSettingsTitle: "設定",
  tourSettingsDesc: "LLM設定、AIネットワーク、言語やテーマを変更できます",
  tourOutro: "設定はすべて自動保存されます。それでは、楽しんでください!",
};

const en: typeof ja = {
  reopenTitle: "Getting started",
  reopenHint: "Re-open the first-run setup guide (LLM connection and nickname).",
  reopenButton: "Open the setup guide",

  dialogAria: "First-time setup",
  close: "Close",
  back: "Back",
  next: "Next",
  start: "Get started",
  saveAndNext: "Save and continue",
  finish: "Done",

  welcomeTitle: "Welcome to TC News!",
  welcomeBody1:
    "TC News is a news app where AI writes articles from your RSS feeds and you share them with everyone over P2P rooms.",
  welcomeBody2:
    "Let's set up just two things: your LLM connection and the nickname used when sharing. You can change both anytime in Settings.",

  llmTitle: "Connect an LLM",
  llmIntro:
    "Set up the LLM used to generate, evaluate, and translate articles. Any OpenAI-compatible API works (OpenAI, LM Studio, Ollama, and more).",
  baseUrlLabel: "Base URL",
  baseUrlPlaceholder: "e.g. https://api.openai.com/v1 / http://localhost:1234/v1",
  apiKeyLabel: "API key (leave empty if not needed)",
  modelLabel: "Model",
  testButton: "Test connection",
  testBusy: "Connecting...",
  testOk: "Connected!",
  testError: "Connection failed: {message}",
  testMessage: 'This is a connection test. Reply with just "OK".',

  nameTitle: "Choose a nickname",
  nameIntro:
    "This name is shown when you share articles. Leave it empty to appear as \"Anonymous\". You can change it anytime in Settings.",
  nameLabel: "Nickname",
  namePlaceholder: "e.g. Owl",

  tourTitle: "You're all set!",
  tourIntro: "What you can do in TC News:",
  tourFeedTitle: "Feed",
  tourFeedDesc: "Register RSS feeds and let AI generate articles from the headlines you pick",
  tourArticlesTitle: "Articles",
  tourArticlesDesc: "Edit, evaluate, translate, and share the articles you generated",
  tourSharedTitle: "Shared",
  tourSharedDesc: "Read everyone's articles in real time via P2P rooms and the global feed",
  tourSettingsTitle: "Settings",
  tourSettingsDesc: "Manage LLM settings, the AI network, language, and theme",
  tourOutro: "Everything is saved automatically. Enjoy!",
};

export const onboarding = { ja, en };

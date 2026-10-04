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
  start: "ニュースを読む",
  setupCreation: "記事作成を設定",
  saveAndNext: "保存して次へ",
  finish: "完了",

  // Step 0: welcome
  welcomeTitle: "TC News へようこそ!",
  welcomeBody1:
    "みんなが共有したニュースを読んだり、RSSフィードからAIで記事を作成したりできるアプリです。",
  welcomeBody2:
    "読むだけなら、LLMの接続設定やAPIキーは不要です。まずはニュースを読んでみましょう。記事を作成したくなったら、設定画面からいつでも準備できます。",

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
  saveErrorCorrupted: "設定データが壊れているため保存できませんでした。設定画面で確認してください。",
  saveErrorWriteFailed: "保存に失敗しました(ストレージの空き容量が不足している可能性があります)。",

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
  tourShareTitle: "記事の共有",
  tourShareDesc:
    "公開先や、手動・自動の共有方法は設定画面で選べます。共有する前に、記事の内容と共有設定を確認しましょう。",
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
  start: "Read news",
  setupCreation: "Set up article creation",
  saveAndNext: "Save and continue",
  finish: "Done",

  welcomeTitle: "Welcome to TC News!",
  welcomeBody1:
    "Read news shared by others, or create your own articles with AI from RSS feeds.",
  welcomeBody2:
    "Reading needs no LLM connection or API key. Start with the news, and set up article creation anytime in Settings.",

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
  saveErrorCorrupted: "Couldn't save: the stored LLM configuration looks corrupted. Please check it in Settings.",
  saveErrorWriteFailed: "Couldn't save (you may be out of storage space).",

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
  tourShareTitle: "Article sharing",
  tourShareDesc:
    "Choose where to publish and whether to share manually or automatically in Settings. Review your article and sharing settings before publishing.",
  tourOutro: "Everything is saved automatically. Enjoy!",
};

export const onboarding = { ja, en };

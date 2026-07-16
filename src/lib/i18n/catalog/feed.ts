// FeedView strings: feed sidebar (add/list/remove), new-item grid, and the
// generation bar at the bottom.
//
// Pattern for every catalog file: author `ja` (the source), then `en` typed as
// `typeof ja` so TypeScript flags any key present in one but missing in the
// other. Additional languages live in ../locales/<lang>.ts.
const ja = {
  tabLabel: "ホーム",
  sidebarTitle: "フィード",
  // Collapsible feed-management sidebar (demoted from a permanent fixture so
  // the home tab reads as "a place to read", not an RSS admin screen)
  sidebarCollapse: "フィード管理を折りたたむ",
  sidebarExpand: "フィード管理を開く",
  refreshNow: "今すぐ更新",
  lastRefreshed: "最終更新: {time}",
  neverRefreshed: "まだ更新していません",
  urlPlaceholder: "フィードURL(https://...)",
  labelPlaceholder: "表示名(空欄で自動取得)",
  addFeed: "追加",
  noFeeds: "フィードが登録されていません",
  removeFeedAria: "{name}を削除",
  editFeedAria: "{name}を編集",
  emptyTitle: "新着記事がまだありません",
  emptyDescription: "左のフォームからフィードを追加すると、新着の見出しがここに並びます。",
  untitledItem: "(無題)",
  selectedCount: "{count}件選択中",
  // 生成バー内の選択トレイ(選択済みアイテムのチップ列)
  selectionTrayAria: "選択中のアイテム一覧",
  selectionRemoveAria: "「{title}」を選択から外す",
  instructionPlaceholder: "追加の指示(任意): 例「初心者にもやさしい言葉で」",
  generating: "生成中...",
  generateArticle: "記事を生成",
  generatingPlaceholder: "生成を開始しています...",
  orchestrateArticle: "編集部生成",
  orchestrateHint: "orchestratorが選択アイテムを複数記事に振り分け、workerが並列生成します",
  orchestratePlanning: "記事の割り当てを計画中...",
  orchestrateGenerating: "記事を並列生成中 ({done}/{total})",
  // Item detail modal
  itemDialogAria: "フィードアイテムの詳細",
  readOriginal: "元記事を読む",
  fullTextLoading: "全文を読み込み中...",
  fullTextFailed: "全文を取得できませんでした。元記事をご覧ください。",
  addToSelection: "生成対象に選択",
  removeFromSelection: "選択を解除",
  // Home tab: "your articles" section (merged from the former articles tab)
  homeArticlesHeading: "あなたの記事",
  homeArticlesEmpty:
    "まだ記事がありません。下の新着からアイテムを選んで生成するか、「今日のブリーフィングを生成」を試してみましょう。",
  briefingGenerate: "今日のブリーフィングを生成",
  briefingGenerateHint: "最新の新着アイテムをAI編集部が複数の記事にまとめます",
  // Home tab: "everyone's news" section (articles received from the global
  // room). Named after the shared tab ("みんな") so users connect the two.
  globalHeading: "みんなのニュース",
  globalSeeAll: "すべて見る",
  globalConnecting: "みんなのニュースを受信しています...",
  globalEmpty: "まだみんなの記事が届いていません。誰かが共有すると、ここに表示されます。",
  // Home tab: article grids show a few cards, with a toggle for the rest
  homeShowAll: "すべて表示 ({count})",
  homeShowLess: "表示を減らす",
  // Home tab: the new-items "inbox" section (formerly the dominant grid,
  // now a collapsible secondary section below the article grids)
  inboxHeading: "新着アイテム",
  inboxHint: "アイテムを選ぶとAI記事にまとめられます",
  inboxCollapseAria: "新着アイテムを折りたたむ",
  inboxExpandAria: "新着アイテムを展開",
  inboxSelectAll: "すべて選択",
  inboxClearSelection: "選択解除",
  // 明示的な選択モードのトグル(長押しでも入れる)
  inboxSelectMode: "選択",
  inboxSelectModeExit: "完了",
  // ほぼ同内容のアイテム(複数ソースが同じ話題を配信)をまとめた際のバッジ
  inboxDupAria: "似た内容のアイテムが他に{count}件あります",
  // 新着アイテムグリッドの段階的展開(最大500件を一度に描画しないため)
  inboxLoadMore: "さらに{count}件を表示",
  // Home tab: content-type filter chips above the main column (unified feed —
  // 番組もホームで再生できるようになったので、記事だけ/音声だけに絞れる)
  filterAll: "すべて",
  filterArticles: "記事",
  filterAudio: "音声",
  // Home tab: programs section between "あなたの記事" and the inbox
  programsHeading: "番組",
  // 番組カードの著者表示: 共有前の自分の番組にはauthorNameがまだ無いため、
  // 匿名ではなく「自分」であることを示すためのフォールバック
  ownAuthorLabel: "自分",
  // Home tab: programs grid shows a few cards, with a toggle for the rest
  // (same convention as homeShowAll/homeShowLess above)
  programsShowAll: "すべて表示 ({count})",
  programsShowLess: "表示を減らす",
};

const en: typeof ja = {
  tabLabel: "Home",
  sidebarTitle: "Feeds",
  sidebarCollapse: "Collapse feed manager",
  sidebarExpand: "Open feed manager",
  refreshNow: "Refresh now",
  lastRefreshed: "Last refreshed: {time}",
  neverRefreshed: "Not refreshed yet",
  urlPlaceholder: "Feed URL (https://...)",
  labelPlaceholder: "Display name (auto-detected if left blank)",
  addFeed: "Add",
  noFeeds: "No feeds registered",
  removeFeedAria: "Remove {name}",
  editFeedAria: "Edit {name}",
  emptyTitle: "No new articles yet",
  emptyDescription: "Add a feed using the form on the left, and new headlines will appear here.",
  untitledItem: "(Untitled)",
  selectedCount: "{count} selected",
  selectionTrayAria: "Selected items",
  selectionRemoveAria: 'Remove "{title}" from selection',
  instructionPlaceholder: 'Additional instructions (optional): e.g. "Use beginner-friendly language"',
  generating: "Generating...",
  generateArticle: "Generate Article",
  generatingPlaceholder: "Starting generation...",
  orchestrateArticle: "Newsroom Generate",
  orchestrateHint: "An orchestrator splits the selected items into multiple articles and workers generate them in parallel",
  orchestratePlanning: "Planning article assignments...",
  orchestrateGenerating: "Generating articles in parallel ({done}/{total})",
  itemDialogAria: "Feed item details",
  readOriginal: "Read the original",
  fullTextLoading: "Loading full text...",
  fullTextFailed: "Couldn't load the full text. Please open the original article.",
  addToSelection: "Select for generation",
  removeFromSelection: "Unselect",
  homeArticlesHeading: "Your articles",
  homeArticlesEmpty:
    'No articles yet — select items below to generate one, or try "Generate today\'s briefing".',
  briefingGenerate: "Generate today's briefing",
  briefingGenerateHint: "The AI newsroom turns the latest items into articles",
  globalHeading: "Everyone's news",
  globalSeeAll: "See all",
  globalConnecting: "Receiving everyone's news...",
  globalEmpty: "No articles from others yet. When someone shares one, it will appear here.",
  homeShowAll: "Show all ({count})",
  homeShowLess: "Show fewer",
  inboxHeading: "Incoming items",
  inboxHint: "Select items to turn them into AI articles",
  inboxCollapseAria: "Collapse incoming items",
  inboxExpandAria: "Expand incoming items",
  inboxSelectAll: "Select all",
  inboxClearSelection: "Clear selection",
  inboxSelectMode: "Select",
  inboxSelectModeExit: "Done",
  inboxDupAria: "{count} more similar items from other sources",
  inboxLoadMore: "Show {count} more",
  filterAll: "All",
  filterArticles: "Articles",
  filterAudio: "Audio",
  programsHeading: "Programs",
  ownAuthorLabel: "You",
  programsShowAll: "Show all ({count})",
  programsShowLess: "Show fewer",
};

export const feed = { ja, en };

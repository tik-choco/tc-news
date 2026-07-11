// ArticlesView + shared article-display component strings (ArticleCard,
// ArticleReader, EmptyState instances used by the "own articles" flow).
// General wording reused by other article-list views (e.g. SharedView) also
// lives here per the i18n contract.
//
// Pattern for every catalog file: author `ja` (the source), then `en` typed as
// `typeof ja` so TypeScript flags any key present in one but missing in the
// other. Additional languages live in ../locales/<lang>.ts.
const ja = {
  tabLabel: "記事",
  untitledArticle: "無題の記事",
  thisArticle: "この記事",
  deleteConfirm: "「{title}」を削除します。この操作は元に戻せません。よろしいですか?",
  sharedBadge: "共有済み",
  shareToRoom: "ルームへ共有",
  shareToChat: "tc-chatへ送る",
  backToList: "一覧へ戻る",
  emptyTitle: "生成した記事がありません",
  emptyDescription: "「フィード」タブで見出しを選んで、記事を生成してみましょう。",
  selectTitle: "記事を選択してください",
  selectDescription: "左の一覧から記事を選ぶと、ここに全文が表示されます。",
  sourcesTitle: "出典",
  justNow: "たった今",
  openInChatLink: "tc-chatで見る",
  sentToChat: "tc-chatに送信しました",
  evaluate: "記事を評価",
  evaluating: "評価中...",
  evalOverall: "総合スコア",
  evalNotes: "総評",
  evalSuggestions: "改善提案",
  evalCategoryApplied: "カテゴリーを「{category}」に設定しました",
  axis_accuracy_score: "事実の忠実さ",
  axis_clarity_score: "読みやすさ",
  axis_coverage_score: "情報量",
  axis_headline_score: "見出しの質",
  axis_neutrality_score: "中立性",
};

const en: typeof ja = {
  tabLabel: "Articles",
  untitledArticle: "Untitled Article",
  thisArticle: "this article",
  deleteConfirm: 'Delete "{title}"? This action cannot be undone.',
  sharedBadge: "Shared",
  shareToRoom: "Share to room",
  shareToChat: "Send to tc-chat",
  backToList: "Back to list",
  emptyTitle: "No articles generated yet",
  emptyDescription: 'Select headlines in the "Feed" tab and generate an article.',
  selectTitle: "Select an article",
  selectDescription: "Choose an article from the list on the left to read the full text here.",
  sourcesTitle: "Sources",
  justNow: "just now",
  openInChatLink: "View in tc-chat",
  sentToChat: "Sent to tc-chat",
  evaluate: "Evaluate article",
  evaluating: "Evaluating...",
  evalOverall: "Overall score",
  evalNotes: "Summary",
  evalSuggestions: "Suggestions",
  evalCategoryApplied: 'Category set to "{category}"',
  axis_accuracy_score: "Factual fidelity",
  axis_clarity_score: "Clarity",
  axis_coverage_score: "Coverage",
  axis_headline_score: "Headline quality",
  axis_neutrality_score: "Neutrality",
};

export const articles = { ja, en };

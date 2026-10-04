const ja = {
  recommended: "おすすめ", latest: "新着順", order: "記事の並び順",
  hint: "記事の閲覧や読んだ時間をもとに、おすすめを自動で調整します。",
  settings: "おすすめの設定", enabled: "閲覧からおすすめを学習する",
  privacy: "推薦用の閲覧履歴はこの端末に保存され、共有されません。",
  paused: "学習を停止中です。新着順で表示しています。",
  reset: "おすすめの履歴をリセット", resetDone: "履歴を消去し、新着順に戻しました。",
  more: "この話題をもっと見る", less: "この記事に興味なし", undo: "取り消す",
  options: "おすすめを調整", hidden: "非表示の記事（{count}件）", restore: "表示に戻す",
  related: "読んだ記事に近い話題", category: "よく読むカテゴリ", explore: "新しい話題を発見", recent: "新着の記事",
  empty: "表示できる記事がありません。設定の「全般」→「おすすめの設定」から非表示を解除できます。",
};
const en: typeof ja = {
  recommended: "For you", latest: "Latest", order: "Article order",
  hint: "Recommendations adjust automatically based on the articles you open and time spent reading.",
  settings: "Recommendation settings", enabled: "Learn from my reading",
  privacy: "Recommendation reading history stays on this device and is not shared.",
  paused: "Learning is paused. Showing the latest articles.", reset: "Reset recommendation history",
  resetDone: "History cleared. Showing the latest articles.", more: "More on this topic", less: "Not interested in this article",
  undo: "Undo", options: "Adjust recommendations", hidden: "Hidden articles ({count})", restore: "Show again",
  related: "Similar to articles you read", category: "A category you often read", explore: "Discover a new topic", recent: "A recent article",
  empty: "No articles to show. You can restore hidden articles in Settings → General → Recommendation settings.",
};
const zh: typeof ja = {
  recommended: "为你推荐", latest: "最新", order: "文章排序", hint: "推荐会根据你阅读的文章和阅读时间自动调整。",
  settings: "推荐设置", enabled: "根据阅读记录学习", privacy: "推荐所用的阅读记录仅保存在此设备，不会共享。",
  paused: "学习已暂停，按最新排序。", reset: "重置推荐记录", resetDone: "记录已清除，按最新排序。", more: "更多此类话题", less: "对此文章不感兴趣",
  undo: "撤销", options: "调整推荐", hidden: "已隐藏的文章（{count}篇）", restore: "恢复显示",
  related: "与你读过的文章相近", category: "你常读的分类", explore: "发现新话题", recent: "最新文章", empty: "没有可显示的文章。可在推荐设置中恢复已隐藏的文章。",
};
const ko: typeof ja = {
  recommended: "추천", latest: "최신순", order: "기사 정렬", hint: "읽은 기사와 읽기 시간을 바탕으로 추천을 자동으로 조정합니다.",
  settings: "추천 설정", enabled: "읽기 기록으로 학습", privacy: "추천용 읽기 기록은 이 기기에만 저장되며 공유되지 않습니다.",
  paused: "학습을 멈췄습니다. 최신순으로 표시합니다.", reset: "추천 기록 초기화", resetDone: "기록을 지웠습니다. 최신순으로 표시합니다.", more: "이 주제 더 보기", less: "이 기사에 관심 없음",
  undo: "취소", options: "추천 조정", hidden: "숨긴 기사 ({count}개)", restore: "다시 표시",
  related: "읽은 기사와 비슷한 주제", category: "자주 읽는 분야", explore: "새로운 주제 발견", recent: "최신 기사", empty: "표시할 기사가 없습니다. 추천 설정에서 숨긴 기사를 복원할 수 있습니다.",
};
const es: typeof ja = {
  recommended: "Para ti", latest: "Recientes", order: "Orden de los artículos", hint: "Las recomendaciones se ajustan automáticamente según los artículos que abres y el tiempo de lectura.",
  settings: "Ajustes de recomendaciones", enabled: "Aprender de mis lecturas", privacy: "El historial de recomendaciones se guarda en este dispositivo y no se comparte.",
  paused: "Aprendizaje en pausa. Se muestran los artículos más recientes.", reset: "Borrar historial de recomendaciones", resetDone: "Historial borrado. Se muestran los artículos más recientes.", more: "Más sobre este tema", less: "No me interesa este artículo",
  undo: "Deshacer", options: "Ajustar recomendaciones", hidden: "Artículos ocultos ({count})", restore: "Volver a mostrar",
  related: "Similar a tus lecturas", category: "Una categoría que sueles leer", explore: "Descubre un tema nuevo", recent: "Artículo reciente", empty: "No hay artículos para mostrar. Puedes restaurarlos en los ajustes de recomendaciones.",
};
const fr: typeof ja = {
  recommended: "Pour vous", latest: "Récents", order: "Ordre des articles", hint: "Les recommandations s’ajustent automatiquement selon les articles ouverts et le temps de lecture.",
  settings: "Réglages des recommandations", enabled: "Apprendre de mes lectures", privacy: "L’historique des recommandations reste sur cet appareil et n’est pas partagé.",
  paused: "Apprentissage en pause. Les articles récents sont affichés.", reset: "Effacer l’historique des recommandations", resetDone: "Historique effacé. Les articles récents sont affichés.", more: "Plus sur ce sujet", less: "Cet article ne m’intéresse pas",
  undo: "Annuler", options: "Ajuster les recommandations", hidden: "Articles masqués ({count})", restore: "Afficher à nouveau",
  related: "Proche de vos lectures", category: "Une catégorie que vous lisez souvent", explore: "Découvrir un autre sujet", recent: "Article récent", empty: "Aucun article à afficher. Vous pouvez restaurer les articles masqués dans les réglages.",
};
export const recommendation = { ja, en, zh, ko, es, fr };

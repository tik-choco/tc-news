// Shared, cross-feature strings — actions and chrome reused everywhere. Domain
// catalogs (feed/articles/shared/settings/errors) should reuse these keys
// (t("common.save")) instead of re-defining "保存" etc., so wording stays
// consistent app-wide. Keys here are fixed by the i18n contract — do not add
// more; put domain-specific wording in the owning domain's catalog instead.
//
// Pattern for every catalog file: author `ja` (the source), then `en` typed as
// `typeof ja` so TypeScript flags any key present in one but missing in the
// other. Additional languages live in ../locales/<lang>.ts.
const ja = {
  cancel: "キャンセル",
  save: "保存",
  delete: "削除",
  close: "閉じる",
  loading: "読み込み中…",
  refresh: "更新",
  error: "エラー",
  share: "共有",
  generate: "生成",
  anonymous: "匿名",
  openInChat: "tc-chatで話す",
  appLinkChat: "tc-chatを開く",
  appLinkHome: "tc-homeを開く",
  categoryAll: "すべて",
  categoryTech: "テック",
  categoryBusiness: "ビジネス",
  categorySociety: "社会",
  categoryScience: "科学",
  categoryCulture: "カルチャー",
  categorySports: "スポーツ",
  categoryLife: "暮らし",
  categoryOther: "その他",
};

const en: typeof ja = {
  cancel: "Cancel",
  save: "Save",
  delete: "Delete",
  close: "Close",
  loading: "Loading…",
  refresh: "Refresh",
  error: "Error",
  share: "Share",
  generate: "Generate",
  anonymous: "Anonymous",
  openInChat: "Discuss in tc-chat",
  appLinkChat: "Open tc-chat",
  appLinkHome: "Open tc-home",
  categoryAll: "All",
  categoryTech: "Tech",
  categoryBusiness: "Business",
  categorySociety: "Society",
  categoryScience: "Science",
  categoryCulture: "Culture",
  categorySports: "Sports",
  categoryLife: "Life",
  categoryOther: "Other",
};

export const common = { ja, en };

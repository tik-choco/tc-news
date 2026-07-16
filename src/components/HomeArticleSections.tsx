// ホーム: 自分の記事(縦グリッド+もっと見るトグル)とグローバルニュース
// (縦グリッド、先頭6件+「すべて見る」でみんなタブへ)の2セクション。
// 元はFeedViewの中の横スクロールレール(.feed-home-rail)だったが、home tab
// article-first化に伴い、記事本体をメインコンテンツにする縦グリッドへ変更。
import { useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Globe, Network } from "lucide-preact";
import type { NewsArticle } from "../types";
import { ArticleCard } from "./ArticleCard";
import { getLatestArticleEvaluations } from "../lib/articleEvaluation";
import { useT } from "../lib/i18n";
import "../styles/homeSections.css";

/** デフォルトで表示する「あなたの記事」の件数。超えたらトグルで全件表示。 */
const DEFAULT_VISIBLE_COUNT = 6;

/** グローバルニュース側は常に先頭6件のみ表示(「すべて見る」でみんなタブへ)。 */
const GLOBAL_VISIBLE_COUNT = 6;

export function HomeArticleSections(props: {
  /** 自分の記事、新しい順。 */
  articles: NewsArticle[];
  onOpenArticle: (id: string) => void;
  briefingDisabled: boolean;
  onBriefingClick: () => void;
  /** グローバル記事(ミュート済み著者は除外済み)、新しい順。 */
  globalArticles: NewsArticle[];
  globalConnected: boolean;
  /** idありなら該当記事のリーダーへ、nullならグローバル一覧へ。 */
  onOpenGlobal: (id: string | null) => void;
}): JSX.Element {
  const { articles, onOpenArticle, briefingDisabled, onBriefingClick, globalArticles, globalConnected, onOpenGlobal } =
    props;
  const t = useT();
  const [showAll, setShowAll] = useState(false);

  const visibleArticles = showAll ? articles : articles.slice(0, DEFAULT_VISIBLE_COUNT);
  const visibleGlobalArticles = globalArticles.slice(0, GLOBAL_VISIBLE_COUNT);

  // Batch-load evaluation scores for all visible cards in one pass instead
  // of re-parsing the whole evaluations blob per card on every render (see
  // articleEvaluation.ts's getLatestArticleEvaluations).
  const evaluationsById = useMemo(
    () => getLatestArticleEvaluations(visibleArticles.map((a) => a.id)),
    [visibleArticles],
  );

  return (
    <>
      <div class="feed-home-section">
        <div class="feed-home-header">
          <h2 class="feed-home-heading">{t("feed.homeArticlesHeading")}</h2>
          <button
            type="button"
            class="btn btn-primary"
            onClick={onBriefingClick}
            disabled={briefingDisabled}
            title={t("feed.briefingGenerateHint")}
          >
            <Network size={15} />
            {t("feed.briefingGenerate")}
          </button>
        </div>
        {articles.length === 0 ? (
          <p class="feed-home-empty">{t("feed.homeArticlesEmpty")}</p>
        ) : (
          <>
            <div class="home-articles-grid">
              {visibleArticles.map((article) => (
                <ArticleCard
                  key={article.id}
                  article={article}
                  onClick={onOpenArticle}
                  evaluationScore={evaluationsById.get(article.id)?.overallScore ?? null}
                />
              ))}
            </div>
            {articles.length > DEFAULT_VISIBLE_COUNT ? (
              <div class="home-show-toggle">
                <button type="button" class="btn btn-ghost btn-small" onClick={() => setShowAll((prev) => !prev)}>
                  {showAll ? t("feed.homeShowLess") : t("feed.homeShowAll", { count: articles.length })}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* グローバル記事ルーム(tc-global-articles)からP2Pで受信済みの記事を
          表示するセクション。新規インストール直後で「あなたの記事」が空でも
          ホームが寂しくならないよう、他ユーザーがすでに共有した記事を見せる。
          カードクリックは「みんな」タブの該当リーダーへ遷移する。 */}
      <div class="feed-global-section">
        <div class="feed-home-header">
          <h2 class="feed-home-heading">
            <Globe size={16} /> {t("feed.globalHeading")}
          </h2>
          <button type="button" class="btn btn-ghost btn-small" onClick={() => onOpenGlobal(null)}>
            {t("feed.globalSeeAll")}
          </button>
        </div>
        {visibleGlobalArticles.length === 0 ? (
          <p class="feed-home-empty">{globalConnected ? t("feed.globalEmpty") : t("feed.globalConnecting")}</p>
        ) : (
          <div class="home-articles-grid">
            {visibleGlobalArticles.map((article) => (
              <ArticleCard key={article.id} article={article} onClick={onOpenGlobal} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

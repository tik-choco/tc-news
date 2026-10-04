// ホーム: 自分の記事(縦グリッド+もっと見るトグル)とグローバルニュース
// (縦グリッド、先頭6件+「すべて見る」でみんなタブへ)の2セクション。
// 元はFeedViewの中の横スクロールレール(.feed-home-rail)だったが、home tab
// article-first化に伴い、記事本体をメインコンテンツにする縦グリッドへ変更。
import { useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Globe, Network, Rss } from "lucide-preact";
import type { NewsArticle } from "../types";
import { ArticleCard } from "./ArticleCard";
import { getLatestArticleEvaluations } from "../lib/articleEvaluation";
import { useT } from "../lib/i18n";
import type { InterestState } from "../lib/recommendationTypes";
import { articleCandidate } from "../lib/recommendationCandidates";
import { useRankedCandidates } from "../hooks/useRecommendations";
import { RecommendationItem } from "./RecommendationItem";
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
  hasFeedItems: boolean;
  onBriefingClick: () => void;
  onManageFeeds: () => void;
  /** グローバル記事(ミュート済み著者は除外済み)、新しい順。 */
  globalArticles: NewsArticle[];
  globalConnected: boolean;
  /** idありなら該当記事のリーダーへ、nullならグローバル一覧へ。 */
  onOpenGlobal: (id: string | null) => void;
  recommendationState?: InterestState;
  trackImpressions?: boolean;
}): JSX.Element {
  const {
    articles,
    onOpenArticle,
    briefingDisabled,
    hasFeedItems,
    onBriefingClick,
    onManageFeeds,
    globalArticles,
    globalConnected,
    onOpenGlobal,
  } = props;
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const hasOwnArticles = articles.length > 0;

  const visibleArticles = showAll ? articles : articles.slice(0, DEFAULT_VISIBLE_COUNT);
  const candidates = useMemo(() => globalArticles.map(articleCandidate), [globalArticles]);
  const ranked = useRankedCandidates(candidates, props.recommendationState);
  const globalById = useMemo(() => new Map(globalArticles.map((a) => [a.id, a])), [globalArticles]);
  const visibleGlobalArticles = props.recommendationState
    ? ranked.slice(0, GLOBAL_VISIBLE_COUNT).map((r) => globalById.get(r.candidate.id)!)
    : globalArticles.slice(0, GLOBAL_VISIBLE_COUNT);
  const rankedById = new Map(ranked.map((r) => [r.candidate.id, r]));
  const impressionSession = useMemo(() => crypto.randomUUID(), [props.recommendationState]);

  // Evaluation records can change without changing the articles. Read once per
  // render so closing the evaluator also refreshes cards in the expanded list.
  const evaluationsById = getLatestArticleEvaluations(visibleArticles.map((a) => a.id));

  const ownSection = (
    <div key="own" class="feed-home-section">
      <div class="feed-home-header">
        <h2 class="feed-home-heading">{t("feed.homeArticlesHeading")}</h2>
        {hasFeedItems ? (
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
        ) : (
          <button type="button" class="btn btn-ghost" onClick={onManageFeeds}>
            <Rss size={15} /> {t("feed.manageFeeds")}
          </button>
        )}
      </div>
      {!hasOwnArticles ? (
        <p class="feed-home-empty">
          {t(hasFeedItems ? "feed.briefingGenerateHint" : "feed.homeArticlesEmpty")}
        </p>
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
  );

  const globalSection = (
    <div key="global" class="feed-global-section">
      <div class="feed-home-header">
        <h2 class="feed-home-heading">
          <Globe size={16} /> {t("feed.globalHeading")}
        </h2>
        <button type="button" class="btn btn-ghost btn-small" onClick={() => onOpenGlobal(null)}>
          {t("feed.globalSeeAll")}
        </button>
      </div>
      {!hasOwnArticles && visibleGlobalArticles.length > 0 ? (
        <p class="feed-home-intro">{t("feed.homeStartReading")}</p>
      ) : null}
      {visibleGlobalArticles.length === 0 ? (
        <p class="feed-home-empty">{globalArticles.length > 0 ? t("recommendation.empty") : globalConnected ? t("feed.globalEmpty") : t("feed.globalConnecting")}</p>
      ) : (
        <div class="home-articles-grid">
          {visibleGlobalArticles.map((article, position) => props.recommendationState ? (
            <RecommendationItem key={article.id} entry={rankedById.get(article.id)!} position={position}
              sessionId={impressionSession} enabled={props.recommendationState.enabled && props.trackImpressions !== false}
              personalized={props.recommendationState.enabled && props.recommendationState.mode === "recommended"}>
              <ArticleCard article={article} onClick={onOpenGlobal} />
            </RecommendationItem>
          ) : <ArticleCard key={article.id} article={article} onClick={onOpenGlobal} />)}
        </div>
      )}
    </div>
  );

  // First-time readers see available news before the optional creation tools.
  return <>{hasOwnArticles ? [ownSection, globalSection] : [globalSection, ownSection]}</>;
}

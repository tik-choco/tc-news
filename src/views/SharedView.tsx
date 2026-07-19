// Received articles from two sources: the private room (settings.roomId) and
// the well-known global room (all tik-choco users). A segmented control picks
// which source's connection bar + list/reader are shown; mirrors ArticlesView's
// two-pane layout but with read-received actions (save/forward/mute/chat)
// instead of own-article share/delete.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  ArrowLeft,
  Download,
  Globe,
  Languages,
  MessagesSquare,
  Rss,
  Save,
  Send,
  Share2,
  Trophy,
  Users,
  Volume2,
  VolumeX,
} from "lucide-preact";
import { REACTION_EMOJI, REACTION_KINDS, type NewsArticle, type RadioProgram, type ReactionKind } from "../types";
import { ArticleCard } from "../components/ArticleCard";
import { ArticleReader } from "../components/ArticleReader";
import { EmptyState } from "../components/EmptyState";
import { ReactionBar } from "../components/ReactionBar";
import { LOCALE_LABELS, useLocale, useT, type Locale } from "../lib/i18n";
import { GLOBAL_ARTICLES_ROOM_ID, type FeedShareWire } from "../lib/newsWire";
import { isMuted, loadMutedDids, muteDid, unmuteDid } from "../lib/muteStore";
import { ARTICLE_CATEGORIES, categoryLabelKey, coerceCategory, type ArticleCategory } from "../lib/categories";
import { chatUrl } from "../lib/chatShare";
import { loadStoredDidIdentity } from "../crypto/didIdentity";
import { getTranslation, type ArticleTranslation } from "../lib/translationStore";
import { getPartialTranslation } from "../lib/partialTranslationStore";
import { isCancelError } from "../lib/jobQueue";
import { useTranslationProgress } from "../hooks/useTranslationProgress";
import { LanguagePicker } from "../components/LanguagePicker";
import { loadReactions, subscribeReactions } from "../lib/reactionStore";
import { computeDailyRanking, type RankingEntry } from "../lib/ranking";
import { loadMyArticles } from "../lib/articleStore";
import { loadPrograms } from "../lib/programStore";
import { loadFeeds } from "../lib/feedStore";
import { importSharedFeed, isFeedAlreadyImported } from "../lib/feedShare";
import { subscribeKvHydrated } from "../lib/kvStore";
import "../styles/components.css";
import "../styles/shared.css";
import "../styles/reactions.css";

type Source = "room" | "global";

/** デフォルトで表示する共有記事一覧の件数。超えたらトグルで全件表示。
 * HomeArticleSections.tsxのDEFAULT_VISIBLE_COUNT(カードグリッド用)と同じ
 * 考え方だが、こちらはReactionBar付きのフル行なので値は大きめにしている。 */
const DEFAULT_VISIBLE_COUNT = 20;

export function SharedView(props: {
  roomId: string;
  roomArticles: NewsArticle[];
  roomConnected: boolean;
  roomPeers: number;
  globalArticles: NewsArticle[];
  globalConnected: boolean;
  globalPeers: number;
  chatRoomId: string;
  deepLinkId?: string | null;
  onSelectionChange?: (id: string | null) => void;
  /** ランキングの番組行クリック: 番組タブへ移動してその番組を選択する。 */
  onOpenProgram: (programId: string) => void;
  /** 外部(ホームの「すべて見る」等)からの初期ソース指定。呼び出しごとに新しい
   * オブジェクトを渡すこと — 参照が変わったときだけ反映するので、同じsource値の
   * 連続指定でも毎回切り替わる。 */
  sourceHint?: { source: "room" | "global" } | null;
  onSaveToArticles: (article: NewsArticle, originRoomId: string) => boolean;
  onForwardToGlobal: (articleId: string, fromRoomId: string) => Promise<boolean>;
  onTranslate: (article: NewsArticle, lang: Locale, source: Source) => Promise<ArticleTranslation>;
  /** Own DID — reaction ownership highlight + "your day" ranking summary. */
  myDid: string;
  /** Room + global shared programs merged, for ranking target lookups. */
  sharedPrograms: RadioProgram[];
  onReact: (
    targetId: string,
    targetType: "article" | "program",
    kind: ReactionKind,
    source: Source,
  ) => Promise<void>;
  /** フィード共有ワイヤ一覧(ソースごと)。hooks/useNewsRoom.tsのsharedFeeds
   * をroom/globalそれぞれから受け取る — articles/programsと同じ二系統構成。 */
  roomSharedFeeds: FeedShareWire[];
  globalSharedFeeds: FeedShareWire[];
  /** 自分のフィードをroom/globalいずれかへ共有する(hooks/useNewsRoom.tsの
   * shareFeed)。source引数で送り先を切り替える点はonReactと同じ。 */
  onShareFeed: (url: string, label: string, source: Source) => Promise<void>;
}): JSX.Element {
  const {
    roomId,
    roomArticles,
    roomConnected,
    roomPeers,
    globalArticles,
    globalConnected,
    globalPeers,
    chatRoomId,
    deepLinkId,
    onSelectionChange,
    onOpenProgram,
    sourceHint,
    onSaveToArticles,
    onForwardToGlobal,
    onTranslate,
    myDid,
    sharedPrograms,
    onReact,
    roomSharedFeeds,
    globalSharedFeeds,
    onShareFeed,
  } = props;
  const t = useT();
  const { locale } = useLocale();

  const [source, setSource] = useState<Source>("room");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mutedDids, setMutedDids] = useState<string[]>(() => loadMutedDids());
  const [showMuted, setShowMuted] = useState(false);
  const [showAllArticles, setShowAllArticles] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<ArticleCategory | null>(null);
  const [forwardBusyId, setForwardBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const [translatingId, setTranslatingId] = useState<string | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [showTranslated, setShowTranslated] = useState(false);
  // Translate target language, independent of the UI locale — defaults to it
  // whenever the active article changes (see selectArticle below) but the
  // reader-toolbar LanguagePicker lets the user pick any of LOCALES for this
  // article specifically.
  const [targetLang, setTargetLang] = useState<Locale>(locale);
  // Own DID, for hiding the mute toggle on the reader's own authored articles
  // (see W7 contract). Read once from the identity already persisted by
  // app.tsx's ensureDidIdentity() on mount; not reactive since a DID never
  // changes after creation within a session.
  const ownDid = useMemo(() => loadStoredDidIdentity()?.did ?? "", []);
  // Tracks the last deepLinkId we've already reacted to, so re-renders caused
  // by fresh P2P article arrays (roomArticles/globalArticles identity churn)
  // don't repeatedly clobber a selection the user has since changed locally.
  const lastDeepLinkRef = useRef<string | null | undefined>(undefined);
  // A third mode alongside room/global, toggled by its own chip in the
  // source switch. Orthogonal to `source` (which still tracks which
  // article set save/forward/translate/reaction-source apply to) — entering
  // ranking mode swaps the list+reader panes for the ranking pane without
  // losing the underlying room/global selection.
  const [rankingActive, setRankingActive] = useState(false);
  // Reactions live in localStorage (reactionStore), not props — bump on every
  // store write (any ReactionBar anywhere) to re-read it for the ranking pane.
  const [reactionsTick, bumpReactionsTick] = useState(0);
  useEffect(() => subscribeReactions(() => bumpReactionsTick((n) => n + 1)), []);
  // rankingArticlesById/rankingProgramsById below call loadMyArticles()/
  // loadPrograms() (mist KV-backed, lib/kvStore.ts) inside a useMemo keyed on
  // the live room/global props — if hydration finishes without those props
  // changing, the memo would keep the stale pre-hydration (possibly empty)
  // read. Bump this on hydration so the memos below re-derive.
  const [kvHydratedTick, bumpKvHydratedTick] = useState(0);
  useEffect(() => subscribeKvHydrated(() => bumpKvHydratedTick((n) => n + 1)), []);

  // 自分のフィード一覧(共有フォームのプルダウン用)+ 取り込み済みバッジの
  // 判定に使う。useFeeds()には依存せず(FeedManageSidebar/useFeeds.tsは並列
  // ワーカーが編集中で触れない)、feedStore.tsを直読みする。他所での追加
  // (自分でフィード管理画面から追加/このビューでの取り込み)はどちらも
  // "tc-news:feeds-updated" をdispatchする契約なので、それを購読して
  // 再読み込みする(useFeeds.ts自身の購読と同じパターン)。
  const [feedsTick, bumpFeedsTick] = useState(0);
  useEffect(() => {
    function handleFeedsUpdated() {
      bumpFeedsTick((n) => n + 1);
    }
    window.addEventListener("tc-news:feeds-updated", handleFeedsUpdated);
    return () => window.removeEventListener("tc-news:feeds-updated", handleFeedsUpdated);
  }, []);
  const myFeeds = useMemo(() => loadFeeds(), [feedsTick]);

  // 共有フィードのフォーム状態: 既存の自分のフィードから選ぶか、URL+ラベルを
  // 直接入力するかの2モード。
  const [shareFeedMode, setShareFeedMode] = useState<"pick" | "url">("pick");
  const [showShareFeedForm, setShowShareFeedForm] = useState(false);
  const [pickedFeedId, setPickedFeedId] = useState("");
  const [shareFeedUrl, setShareFeedUrl] = useState("");
  const [shareFeedLabel, setShareFeedLabel] = useState("");
  const [shareFeedBusy, setShareFeedBusy] = useState(false);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (deepLinkId === lastDeepLinkRef.current) return;
    lastDeepLinkRef.current = deepLinkId ?? null;
    if (!deepLinkId) {
      setActiveId(null);
      return;
    }
    // A deep link always means "show me the reader" — the ranking pane
    // (which hides list+reader entirely) shouldn't swallow it.
    setRankingActive(false);
    if (roomArticles.some((a) => a.id === deepLinkId)) {
      setSource("room");
      setActiveId(deepLinkId);
    } else if (globalArticles.some((a) => a.id === deepLinkId)) {
      setSource("global");
      setActiveId(deepLinkId);
    } else {
      // Not loaded yet (P2P history may still be arriving) — keep the id
      // selected so the reader picks it up once the article shows up.
      setActiveId(deepLinkId);
    }
  }, [deepLinkId, roomArticles, globalArticles]);

  // Tracks the last sourceHint we've already reacted to, mirroring
  // lastDeepLinkRef above so repeated re-renders with the same hint don't
  // clobber a source the user has since switched manually.
  const lastSourceHintRef = useRef<{ source: "room" | "global" } | null | undefined>(undefined);
  useEffect(() => {
    // Identity (not value) comparison is intentional: the caller passes a
    // fresh object per navigation, so "open global" fires again even when
    // the previous hint was also "global".
    if (sourceHint === lastSourceHintRef.current) return;
    lastSourceHintRef.current = sourceHint ?? null;
    if (!sourceHint) return;
    // Mirrors switchSource's resets (ranking pane, mute filter, category
    // filter) since this is effectively an externally-triggered source
    // switch.
    setRankingActive(false);
    setSource(sourceHint.source);
    setShowMuted(false);
    setCategoryFilter(null);
    setShowAllArticles(false);
  }, [sourceHint]);

  function selectArticle(id: string | null) {
    setActiveId(id);
    lastDeepLinkRef.current = id;
    onSelectionChange?.(id);
    setShowTranslated(false);
    setTranslateError(null);
    setTargetLang(locale);
  }

  function switchSource(next: Source) {
    setRankingActive(false);
    if (next === source) return;
    setSource(next);
    setShowMuted(false);
    // Each source has its own article set, so a category selected for one
    // side may not exist (or mean the same thing) on the other — reset it
    // rather than silently carrying a stale filter across.
    setCategoryFilter(null);
    setShowAllArticles(false);
  }

  function activateRanking() {
    setRankingActive(true);
  }

  // Which room/global source an article belongs to, for reacting to it and
  // for jumping into the reader from a ranking row. undefined if the article
  // isn't in either live list (e.g. it's a local-only saved copy).
  function articleSourceOf(id: string): Source | null {
    if (roomArticles.some((a) => a.id === id)) return "room";
    if (globalArticles.some((a) => a.id === id)) return "global";
    return null;
  }

  function selectRankingArticle(id: string) {
    const found = articleSourceOf(id);
    if (!found) return;
    setRankingActive(false);
    setSource(found);
    selectArticle(id);
  }

  function showNotice(key: string, params?: Record<string, string | number>) {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    setNotice(t(key, params));
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2000);
  }

  function handleSave(article: NewsArticle) {
    const originRoomId = source === "room" ? roomId : GLOBAL_ARTICLES_ROOM_ID;
    const saved = onSaveToArticles(article, originRoomId);
    showNotice(saved ? "shared.savedToArticles" : "shared.alreadySaved");
  }

  async function handleForward(article: NewsArticle) {
    setForwardBusyId(article.id);
    try {
      const ok = await onForwardToGlobal(article.id, roomId);
      showNotice(ok ? "shared.forwarded" : "shared.forwardFailed");
    } finally {
      setForwardBusyId(null);
    }
  }

  function handleImportFeed(wire: FeedShareWire) {
    const result = importSharedFeed(wire.url, wire.label);
    // A successful import dispatches "tc-news:feeds-updated", which the
    // effect above is subscribed to — myFeeds (and therefore the imported
    // badge below) refreshes on its own, no manual bump needed here.
    showNotice(result.imported ? "shared.feedImported" : "shared.feedAlreadyImported");
  }

  async function handleShareFeed() {
    const picked = shareFeedMode === "pick" ? myFeeds.find((f) => f.id === pickedFeedId) : undefined;
    const url = (picked ? picked.url : shareFeedUrl).trim();
    const label = (picked ? picked.label : shareFeedLabel).trim();
    if (!url) return;
    setShareFeedBusy(true);
    try {
      await onShareFeed(url, label, source);
      showNotice("shared.feedShared");
      setPickedFeedId("");
      setShareFeedUrl("");
      setShareFeedLabel("");
    } catch (err) {
      console.error("failed to share feed", err);
      showNotice("shared.feedShareFailed");
    } finally {
      setShareFeedBusy(false);
    }
  }

  async function handleTranslate(article: NewsArticle) {
    if (translatingId) return; // single-flight guard
    setTranslatingId(article.id);
    setTranslateError(null);
    try {
      await onTranslate(article, targetLang, source);
      setShowTranslated(true);
    } catch (err) {
      // A queue-toast cancel rejects with an AbortError — that's a user
      // action, not a failure worth an error line.
      if (!isCancelError(err)) setTranslateError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranslatingId(null);
    }
  }

  function handleToggleMute(authorDid: string) {
    if (!authorDid) return;
    if (isMuted(authorDid, mutedDids)) {
      unmuteDid(authorDid);
    } else {
      muteDid(authorDid);
    }
    setMutedDids(loadMutedDids());
  }

  const sourceArticles = source === "room" ? roomArticles : globalArticles;
  const sourceConnected = source === "room" ? roomConnected : globalConnected;
  const sourcePeers = source === "room" ? roomPeers : globalPeers;
  const sourceSharedFeeds = source === "room" ? roomSharedFeeds : globalSharedFeeds;
  const active = sourceArticles.find((a) => a.id === activeId) ?? null;
  // Not stateful — re-read on every render, same idiom as ArticlesView's latestEval.
  const cachedTranslation = active ? getTranslation(active.id, targetLang) : null;
  const needsTranslation = active ? active.lang !== targetLang : false;
  // Live streaming progress for the active article×targetLang — same
  // module-singleton lookup as ArticleReaderModal, so a translation started
  // from *this* view, the modal, or a background resume all show up here.
  // Called unconditionally (rules-of-hooks) with "" as a never-matching
  // targetId when nothing is selected, rather than skipping the hook call.
  const liveProgress = useTranslationProgress("article", active?.id ?? "", targetLang);
  // Same re-read-every-render idiom as cachedTranslation — only used to
  // relabel the translate icon-btn below as "resume" when applicable.
  const partialTranslation = active ? getPartialTranslation(active.id, targetLang) : null;
  const displayArticle: NewsArticle | null =
    active && showTranslated && cachedTranslation
      ? { ...active, title: cachedTranslation.title, excerpt: cachedTranslation.excerpt, body: cachedTranslation.body }
      : active && liveProgress && !cachedTranslation
        ? {
            ...active,
            title: liveProgress.title ?? active.title,
            excerpt: liveProgress.subtitle ?? active.excerpt,
            body: liveProgress.body || active.body,
          }
        : active;

  // Categories present in the current source's articles, fixed taxonomy
  // order — same derivation as ArticlesView's filter row.
  const availableCategories = useMemo<ArticleCategory[]>(() => {
    const present = new Set<ArticleCategory>();
    for (const a of sourceArticles) {
      const c = coerceCategory(a.category);
      if (c) present.add(c);
    }
    return ARTICLE_CATEGORIES.filter((c) => present.has(c));
  }, [sourceArticles]);

  useEffect(() => {
    if (categoryFilter && !availableCategories.includes(categoryFilter)) {
      setCategoryFilter(null);
    }
  }, [availableCategories, categoryFilter]);

  // Category filter applies first, then the mute collapse — a muted author's
  // article in a filtered-out category shouldn't count toward the "N muted"
  // collapsed-row total.
  const categoryFilteredArticles = categoryFilter
    ? sourceArticles.filter((a) => coerceCategory(a.category) === categoryFilter)
    : sourceArticles;
  const visibleArticles = showMuted
    ? categoryFilteredArticles
    : categoryFilteredArticles.filter((a) => !isMuted(a.authorDid, mutedDids));
  const mutedHiddenCount = showMuted ? 0 : categoryFilteredArticles.length - visibleArticles.length;
  // Rendering cap on top of the category/mute filtering above: a room's
  // shared-article list can hold up to MAX_SHARED_ARTICLES entries (see
  // lib/newsWire.ts), and rendering an ArticleCard + ReactionBar per row for
  // all of them at once is wasteful for a list that's rarely scrolled past
  // the first screenful. Same "show more" convention as
  // HomeArticleSections.tsx's DEFAULT_VISIBLE_COUNT toggle.
  const renderedArticles = showAllArticles ? visibleArticles : visibleArticles.slice(0, DEFAULT_VISIBLE_COUNT);

  const emptyTitle = source === "global" ? t("shared.globalEmptyTitle") : t("shared.emptyTitle");
  const emptyDesc =
    source === "global"
      ? t("shared.globalEmptyDesc")
      : sourceConnected
        ? t("shared.emptyDescConnected")
        : t("shared.emptyDescWaiting");

  const activeIsMuted = active ? isMuted(active.authorDid, mutedDids) : false;

  // --- Daily ranking (only computed/used while the ranking chip is active;
  // cheap enough (bounded localStorage lists) to not bother gating it) ------

  // Article/program lookup maps: room+global live lists plus the user's own
  // locally-saved copies, so ranking rows can render a title/author even for
  // targets that only exist in "my articles"/"my programs" (not clickable
  // then — see articleSourceOf — but still shown in the list and counted in
  // the "your day" summary).
  const rankingArticlesById = useMemo(() => {
    const map = new Map<string, NewsArticle>();
    for (const a of [...roomArticles, ...globalArticles, ...loadMyArticles()]) {
      if (!map.has(a.id)) map.set(a.id, a);
    }
    return map;
  }, [roomArticles, globalArticles, kvHydratedTick]);

  const rankingProgramsById = useMemo(() => {
    const map = new Map<string, RadioProgram>();
    for (const p of [...sharedPrograms, ...loadPrograms()]) {
      if (!map.has(p.id)) map.set(p.id, p);
    }
    return map;
  }, [sharedPrograms, kvHydratedTick]);

  interface RankingRow {
    entry: RankingEntry;
    title: string;
    authorName: string;
    authorDid: string;
  }

  // reactionsTick is an intentional dep — it's how this recomputes when a
  // reaction is sent anywhere (see the subscribeReactions effect above).
  const rankingRows = useMemo<RankingRow[]>(() => {
    const entries = computeDailyRanking(loadReactions());
    const rows: RankingRow[] = [];
    for (const entry of entries) {
      const target =
        entry.targetType === "article" ? rankingArticlesById.get(entry.targetId) : rankingProgramsById.get(entry.targetId);
      if (!target) continue; // can't render a title — skip (see task spec)
      rows.push({
        entry,
        title: target.title,
        authorName: target.authorName ?? "",
        authorDid: target.authorDid ?? "",
      });
    }
    return rows;
  }, [reactionsTick, rankingArticlesById, rankingProgramsById]);

  // rankingRows is already sorted desc by count (computeDailyRanking's order
  // is preserved by the filter above), so the first row authored by me is
  // also my best (lowest-numbered) rank.
  const yourBestRankIndex = rankingRows.findIndex((r) => r.authorDid === myDid);
  const yourBestRank = yourBestRankIndex >= 0 ? yourBestRankIndex + 1 : null;
  const yourReceived = rankingRows
    .filter((r) => r.authorDid === myDid)
    .reduce((sum, r) => sum + r.entry.count, 0);
  const hasYourEntry = yourBestRank !== null;

  return (
    <div class={`shared-view${active ? " shared-view--reading" : ""}`}>
      <div class="shared-source-switch" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={source === "room"}
          class={`shared-source-btn${source === "room" ? " shared-source-btn--active" : ""}`}
          onClick={() => switchSource("room")}
        >
          {t("shared.sourceRoom")} ({roomId})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={source === "global"}
          class={`shared-source-btn${source === "global" ? " shared-source-btn--active" : ""}`}
          onClick={() => switchSource("global")}
        >
          {t("shared.sourceGlobal")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={rankingActive}
          class={`shared-source-btn${rankingActive ? " shared-source-btn--active" : ""}`}
          onClick={activateRanking}
        >
          <Trophy size={13} /> {t("shared.rankingTab")}
        </button>
      </div>

      <div class="shared-status-bar">
        <span
          class={`shared-status-dot${sourceConnected ? " shared-status-dot--online" : ""}`}
          aria-hidden="true"
        />
        <span class="shared-status-text">
          {sourceConnected ? t("shared.connected") : t("shared.disconnected")} ・{" "}
          {source === "room" ? t("shared.room", { roomId }) : t("shared.globalRoom")}
        </span>
        <span class="shared-status-peers">
          <Users size={14} /> {sourcePeers}
        </span>
      </div>

      {rankingActive ? (
        <div class="ranking-pane">
          <div class="ranking-heading">
            <h2 class="ranking-title">{t("shared.rankingTitle")}</h2>
            <p class="ranking-hint">{t("shared.rankingHint")}</p>
          </div>

          <div class="ranking-you-card">
            <span class="ranking-you-heading">{t("shared.rankingYouHeading")}</span>
            {hasYourEntry ? (
              <div class="ranking-you-stats">
                <span>{t("shared.rankingYouReceived", { count: yourReceived })}</span>
                <span>{t("shared.rankingYouBestRank", { rank: yourBestRank as number })}</span>
              </div>
            ) : (
              <span class="ranking-you-empty">{t("shared.rankingYouNoEntry")}</span>
            )}
          </div>

          {rankingRows.length === 0 ? (
            <EmptyState icon={Trophy} title={t("shared.rankingEmpty")} />
          ) : (
            <ul class="ranking-list">
              {rankingRows.map((row, index) => {
                const rank = index + 1;
                const rankClass = rank <= 3 ? ` ranking-rank--${rank}` : "";
                // Program rows always have a resolvable target (rows we
                // can't render a title for are already skipped when
                // building rankingRows) and jump to the program tab via
                // onOpenProgram. Article rows are only clickable when
                // articleSourceOf finds them in a live room/global list —
                // an article that exists solely as a local saved copy has
                // nowhere to jump to, so it stays a non-interactive row.
                const clickableSource =
                  row.entry.targetType === "article" ? articleSourceOf(row.entry.targetId) : null;
                const isProgram = row.entry.targetType === "program";
                const kindBreakdown = REACTION_KINDS.filter((kind) => row.entry.byKind[kind] > 0);
                const content = (
                  <>
                    <span class={`ranking-rank${rankClass}`}>{rank}</span>
                    <span class="ranking-row-main">
                      <span class="ranking-row-title">{row.title || t("articles.untitledArticle")}</span>
                      <span class="ranking-row-meta">
                        <span>{row.authorName || t("common.anonymous")}</span>
                        {row.entry.targetType === "program" ? (
                          <span class="ranking-program-badge">{t("shared.rankingProgramBadge")}</span>
                        ) : null}
                        {kindBreakdown.length > 0 ? (
                          <span class="ranking-kind-breakdown">
                            {kindBreakdown.map((kind) => (
                              <span key={kind}>
                                {REACTION_EMOJI[kind]} {row.entry.byKind[kind]}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span class="ranking-row-side">{t("shared.rankingReactions", { count: row.entry.count })}</span>
                  </>
                );
                return (
                  <li key={`${row.entry.targetType}:${row.entry.targetId}`}>
                    {isProgram ? (
                      <button
                        type="button"
                        class="ranking-row"
                        onClick={() => onOpenProgram(row.entry.targetId)}
                      >
                        {content}
                      </button>
                    ) : clickableSource ? (
                      <button
                        type="button"
                        class="ranking-row"
                        onClick={() => selectRankingArticle(row.entry.targetId)}
                      >
                        {content}
                      </button>
                    ) : (
                      <div class="ranking-row">{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <>
        <div class="shared-list-pane">
          <div class="feed-share-section">
            <div class="feed-share-header">
              <h3 class="feed-share-title">
                <Rss size={14} /> {t("shared.feedShareTitle")}
              </h3>
              <button
                type="button"
                class="link-btn"
                onClick={() => setShowShareFeedForm((v) => !v)}
              >
                <Share2 size={13} />{" "}
                {showShareFeedForm ? t("common.close") : t("shared.feedShareOpenForm")}
              </button>
            </div>

            {/* Reuses the same `notice` state as save/forward — those render
               their toast in the reader pane, which is hidden while nothing
               is selected, so feed import/share actions (which happen from
               the list pane, often with no article selected) get their own
               visible copy here. */}
            {notice ? <p class="feed-share-notice">{notice}</p> : null}

            {showShareFeedForm ? (
              <div class="feed-share-form">
                <div class="category-filter-row" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={shareFeedMode === "pick"}
                    class={`category-filter-chip${shareFeedMode === "pick" ? " category-filter-chip--active" : ""}`}
                    onClick={() => setShareFeedMode("pick")}
                  >
                    {t("shared.feedShareModePick")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={shareFeedMode === "url"}
                    class={`category-filter-chip${shareFeedMode === "url" ? " category-filter-chip--active" : ""}`}
                    onClick={() => setShareFeedMode("url")}
                  >
                    {t("shared.feedShareModeUrl")}
                  </button>
                </div>

                {shareFeedMode === "pick" ? (
                  myFeeds.length === 0 ? (
                    <p class="feed-share-empty">{t("shared.feedShareNoOwnFeeds")}</p>
                  ) : (
                    <select
                      value={pickedFeedId}
                      onChange={(e) => setPickedFeedId((e.target as HTMLSelectElement).value)}
                    >
                      <option value="">{t("shared.feedSharePickPlaceholder")}</option>
                      {myFeeds.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label || f.url}
                        </option>
                      ))}
                    </select>
                  )
                ) : (
                  <div class="feed-share-url-inputs">
                    <input
                      type="text"
                      placeholder={t("shared.feedShareUrlPlaceholder")}
                      value={shareFeedUrl}
                      onInput={(e) => setShareFeedUrl((e.target as HTMLInputElement).value)}
                    />
                    <input
                      type="text"
                      placeholder={t("shared.feedShareLabelPlaceholder")}
                      value={shareFeedLabel}
                      onInput={(e) => setShareFeedLabel((e.target as HTMLInputElement).value)}
                    />
                  </div>
                )}

                <button
                  type="button"
                  class="btn btn-primary btn-small"
                  disabled={
                    shareFeedBusy ||
                    (shareFeedMode === "pick" ? !pickedFeedId : !shareFeedUrl.trim())
                  }
                  onClick={() => void handleShareFeed()}
                >
                  <Send size={13} /> {t("shared.feedShareSubmit")}
                </button>
              </div>
            ) : null}

            {sourceSharedFeeds.length === 0 ? (
              <p class="feed-share-empty">{t("shared.feedShareEmpty")}</p>
            ) : (
              <ul class="feed-share-list">
                {sourceSharedFeeds.map((wire) => {
                  const alreadyImported = isFeedAlreadyImported(wire.url);
                  return (
                    <li key={wire.id} class="feed-share-item">
                      <div class="feed-share-item-main">
                        <span class="feed-share-item-label">{wire.label || wire.url}</span>
                        <span class="feed-share-item-url">{wire.url}</span>
                        <span class="feed-share-item-from">
                          {t("shared.feedShareFrom", { name: wire.fromName || t("common.anonymous") })}
                        </span>
                      </div>
                      {alreadyImported ? (
                        <span class="badge badge--shared">{t("shared.feedAlreadyImported")}</span>
                      ) : (
                        <button
                          type="button"
                          class="icon-btn"
                          title={t("shared.feedShareImportAction")}
                          aria-label={t("shared.feedShareImportAction")}
                          onClick={() => handleImportFeed(wire)}
                        >
                          <Download size={15} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {availableCategories.length > 0 ? (
            <div class="category-filter-row" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={categoryFilter === null}
                class={`category-filter-chip${categoryFilter === null ? " category-filter-chip--active" : ""}`}
                onClick={() => setCategoryFilter(null)}
              >
                {t("common.categoryAll")}
              </button>
              {availableCategories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  role="tab"
                  aria-selected={categoryFilter === cat}
                  class={`category-filter-chip${categoryFilter === cat ? " category-filter-chip--active" : ""}`}
                  onClick={() => setCategoryFilter(cat)}
                >
                  {t(categoryLabelKey(cat))}
                </button>
              ))}
            </div>
          ) : null}
          {sourceArticles.length === 0 ? (
            <EmptyState icon={Globe} title={emptyTitle} description={emptyDesc} />
          ) : (
            <ul class="shared-list">
              {renderedArticles.map((article) => (
                <li key={article.id}>
                  <ArticleCard
                    article={article}
                    active={article.id === activeId}
                    onClick={selectArticle}
                    actions={<ReactionBar targetId={article.id} compact />}
                  />
                </li>
              ))}
              {mutedHiddenCount > 0 ? (
                <li class="shared-muted-row">
                  <span>{t("shared.mutedCollapsed", { count: mutedHiddenCount })}</span>
                  <button type="button" class="link-btn" onClick={() => setShowMuted(true)}>
                    {t("shared.showMuted")}
                  </button>
                </li>
              ) : null}
            </ul>
          )}
          {visibleArticles.length > DEFAULT_VISIBLE_COUNT ? (
            <div class="shared-show-toggle">
              <button
                type="button"
                class="btn btn-ghost btn-small"
                onClick={() => setShowAllArticles((prev) => !prev)}
              >
                {showAllArticles ? t("shared.listShowLess") : t("shared.listShowAll", { count: visibleArticles.length })}
              </button>
            </div>
          ) : null}
        </div>

        <div class="shared-reader-pane">
          {active ? (
            <>
              <button type="button" class="shared-back-btn" onClick={() => selectArticle(null)}>
                <ArrowLeft size={15} /> {t("shared.backToList")}
              </button>

              <div class="shared-reader-actions">
                <button
                  type="button"
                  class="icon-btn"
                  title={t("shared.saveToArticles")}
                  aria-label={t("shared.saveToArticles")}
                  onClick={() => handleSave(active)}
                >
                  <Save size={15} />
                </button>
                {source === "room" ? (
                  <button
                    type="button"
                    class={`icon-btn${forwardBusyId === active.id ? " loading" : ""}`}
                    title={t("shared.forwardToGlobal")}
                    aria-label={t("shared.forwardToGlobal")}
                    disabled={forwardBusyId === active.id}
                    onClick={() => void handleForward(active)}
                  >
                    <Send size={15} />
                  </button>
                ) : null}
                {active.authorDid && active.authorDid !== ownDid ? (
                  <button
                    type="button"
                    class="icon-btn"
                    title={activeIsMuted ? t("shared.unmuteAuthor") : t("shared.muteAuthor")}
                    aria-label={activeIsMuted ? t("shared.unmuteAuthor") : t("shared.muteAuthor")}
                    onClick={() => handleToggleMute(active.authorDid)}
                  >
                    {activeIsMuted ? <Volume2 size={15} /> : <VolumeX size={15} />}
                  </button>
                ) : null}
                <LanguagePicker
                  value={targetLang}
                  onChange={(lang) => {
                    setTargetLang(lang);
                    // Switching target language jumps straight to that
                    // language's cached translation if one exists;
                    // otherwise falls back to the original (mirrors
                    // selectArticle's showTranslated reset above).
                    setShowTranslated(getTranslation(active.id, lang) !== null);
                  }}
                  disabled={translatingId === active.id || !!liveProgress}
                />
                {needsTranslation && !cachedTranslation ? (
                  <button
                    type="button"
                    class={`icon-btn${translatingId === active.id || liveProgress ? " loading" : ""}`}
                    title={
                      translatingId === active.id || liveProgress
                        ? t("translate.translating")
                        : partialTranslation
                          ? t("translate.resume")
                          : t("translate.translate")
                    }
                    aria-label={
                      translatingId === active.id || liveProgress
                        ? t("translate.translating")
                        : partialTranslation
                          ? t("translate.resume")
                          : t("translate.translate")
                    }
                    // Disabled both for this view's own in-flight request
                    // (translatingId) and for a job started elsewhere on the
                    // same article×locale (liveProgress) — see
                    // ArticleReaderModal's identical guard.
                    disabled={translatingId === active.id || !!liveProgress}
                    onClick={() => void handleTranslate(active)}
                  >
                    <Languages size={15} />
                  </button>
                ) : null}
                {liveProgress && !cachedTranslation ? (
                  <span class="badge">
                    {liveProgress.totalChunks > 0
                      ? t("translate.translatingProgress", {
                          done: String(liveProgress.doneChunks),
                          total: String(liveProgress.totalChunks),
                        })
                      : t("translate.translating")}
                  </span>
                ) : null}
                {cachedTranslation ? (
                  <button
                    type="button"
                    class="icon-btn"
                    title={showTranslated ? t("translate.showOriginal") : t("translate.showTranslated")}
                    aria-label={showTranslated ? t("translate.showOriginal") : t("translate.showTranslated")}
                    onClick={() => setShowTranslated((v) => !v)}
                  >
                    <Languages size={15} />
                  </button>
                ) : null}
                {showTranslated && cachedTranslation ? (
                  <span class="badge">{t("translate.translatedBadge", { lang: LOCALE_LABELS[targetLang] })}</span>
                ) : null}
                <a
                  class="shared-chat-link"
                  href={chatUrl(chatRoomId)}
                  target="_blank"
                  rel="noopener"
                >
                  <MessagesSquare size={15} /> {t("common.openInChat")}
                </a>
                {notice ? <span class="shared-reader-notice">{notice}</span> : null}
                {translateError ? <span class="shared-reader-notice">{translateError}</span> : null}
              </div>

              <div class="shared-reader-reactions">
                <ReactionBar
                  targetId={active.id}
                  myDid={myDid}
                  onReact={(kind) => onReact(active.id, "article", kind, source)}
                />
              </div>

              <ArticleReader article={displayArticle ?? active} />
            </>
          ) : (
            <EmptyState icon={Globe} title={t("shared.selectTitle")} description={t("shared.selectDesc")} />
          )}
        </div>
        </>
      )}
    </div>
  );
}

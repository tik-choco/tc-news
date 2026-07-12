// Received articles from two sources: the private room (settings.roomId) and
// the well-known global room (all tik-choco users). A segmented control picks
// which source's connection bar + list/reader are shown; mirrors ArticlesView's
// two-pane layout but with read-received actions (save/forward/mute/chat)
// instead of own-article share/delete.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  ArrowLeft,
  Globe,
  Languages,
  MessagesSquare,
  Save,
  Send,
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
import { GLOBAL_ARTICLES_ROOM_ID } from "../lib/newsWire";
import { isMuted, loadMutedDids, muteDid, unmuteDid } from "../lib/muteStore";
import { ARTICLE_CATEGORIES, categoryLabelKey, coerceCategory, type ArticleCategory } from "../lib/categories";
import { chatUrl } from "../lib/chatShare";
import { loadStoredDidIdentity } from "../crypto/didIdentity";
import { getTranslation, type ArticleTranslation } from "../lib/translationStore";
import { isCancelError } from "../lib/jobQueue";
import { loadReactions, subscribeReactions } from "../lib/reactionStore";
import { computeDailyRanking, type RankingEntry } from "../lib/ranking";
import { loadMyArticles } from "../lib/articleStore";
import { loadPrograms } from "../lib/programStore";
import { subscribeKvHydrated } from "../lib/kvStore";
import "../styles/components.css";
import "../styles/shared.css";
import "../styles/reactions.css";

type Source = "room" | "global";

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
  } = props;
  const t = useT();
  const { locale } = useLocale();

  const [source, setSource] = useState<Source>("room");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mutedDids, setMutedDids] = useState<string[]>(() => loadMutedDids());
  const [showMuted, setShowMuted] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<ArticleCategory | null>(null);
  const [forwardBusyId, setForwardBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const [translatingId, setTranslatingId] = useState<string | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [showTranslated, setShowTranslated] = useState(false);
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
  }, [sourceHint]);

  function selectArticle(id: string | null) {
    setActiveId(id);
    lastDeepLinkRef.current = id;
    onSelectionChange?.(id);
    setShowTranslated(false);
    setTranslateError(null);
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

  async function handleTranslate(article: NewsArticle) {
    if (translatingId) return; // single-flight guard
    setTranslatingId(article.id);
    setTranslateError(null);
    try {
      await onTranslate(article, locale, source);
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
  const active = sourceArticles.find((a) => a.id === activeId) ?? null;
  // Not stateful — re-read on every render, same idiom as ArticlesView's latestEval.
  const cachedTranslation = active ? getTranslation(active.id, locale) : null;
  const needsTranslation = active ? active.lang !== locale : false;
  const displayArticle: NewsArticle | null =
    active && showTranslated && cachedTranslation
      ? { ...active, title: cachedTranslation.title, excerpt: cachedTranslation.excerpt, body: cachedTranslation.body }
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
              {visibleArticles.map((article) => (
                <li key={article.id}>
                  <ArticleCard
                    article={article}
                    active={article.id === activeId}
                    onClick={() => selectArticle(article.id)}
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
                {needsTranslation && !cachedTranslation ? (
                  <button
                    type="button"
                    class={`icon-btn${translatingId === active.id ? " loading" : ""}`}
                    title={translatingId === active.id ? t("translate.translating") : t("translate.translate")}
                    aria-label={translatingId === active.id ? t("translate.translating") : t("translate.translate")}
                    disabled={translatingId === active.id}
                    onClick={() => void handleTranslate(active)}
                  >
                    <Languages size={15} />
                  </button>
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
                  <span class="badge">{t("translate.translatedBadge", { lang: LOCALE_LABELS[locale] })}</span>
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

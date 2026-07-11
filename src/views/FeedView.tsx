// ホーム: 記事ファーストに再設計したメインタブ。メインカラムは
// 「あなたの記事」「グローバルニュース」の縦グリッド(HomeArticleSections)が
// 主役で、旧来主役だった新着RSSグリッドは折りたたみ可能な受信箱
// (FeedInbox)に降格。フィード管理はレール化できるサイドバー
// (FeedManageSidebar)、生成バー(GenerateBar)は選択中/生成中/エラー時のみ
// 出現する。各セクションの見た目は自分のCSSを持つ — このビューが持つのは
// 状態とレイアウトグリッド(styles/feed.css)だけ。
//
// 旧「記事」タブ由来の閲覧・評価・翻訳・共有・chat送信・削除は引き続き
// ArticleReaderModal 経由でこのビューの上に開く。Owns useFeeds() internally
// (per the module contract) so the app shell only has to pass
// settings/identity through. Auto-generation watches the item list itself
// (not just the manual refresh button) so it also reacts to the hook's own
// background/interval refreshes. 「編集部生成」ボタンと自動生成は
// orchestrator→worker のfan-out経路(lib/orchestrate.ts)を使い、選択/新着の
// アイテム群を複数記事に振り分けて並列生成する。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { AppSettings, FeedItem, NewsArticle } from "../types";
import { useFeeds } from "../hooks/useFeeds";
import { generateArticle } from "../lib/generate";
import { runOrchestratedGeneration } from "../lib/orchestrate";
import { loadProviderSettings } from "../lib/llmSettings";
import { isMuted, loadMutedDids } from "../lib/muteStore";
import { groupNearDuplicateItems } from "../lib/feedDedupe";
import { enqueueJob, findPendingJob, isCancelError } from "../lib/jobQueue";
import { useJobQueue } from "../hooks/useJobQueue";
import { ArticleReaderModal } from "../components/ArticleReaderModal";
import { FeedItemModal } from "../components/FeedItemModal";
import { FeedManageSidebar } from "../components/FeedManageSidebar";
import { FeedInbox } from "../components/FeedInbox";
import { HomeArticleSections } from "../components/HomeArticleSections";
import { GenerateBar } from "../components/GenerateBar";
import { LOCALE_LABELS, useLocale, useT, type Locale } from "../lib/i18n";
import type { ArticleTranslation } from "../lib/translationStore";
import "../styles/components.css";
import "../styles/feed.css";

/** 新着がこの件数以上たまったら autoGenerate 設定時に自動生成する。 */
const AUTO_GENERATE_THRESHOLD = 3;

/** ブリーフィング生成ボタンが対象にする新着アイテムの上限件数。 */
const BRIEFING_ITEM_LIMIT = 12;

/** サイドバー折りたたみ状態の永続キー("1"=折りたたみ)。未保存なら
 * 「フィード登録済み=もう管理は済んでいる」とみなして折りたたみで始める。 */
const SIDEBAR_COLLAPSED_KEY = "tc-news:feed-sidebar-collapsed";

// AIジョブキュー(lib/jobQueue)のdedupキー。同じ選択に対する生成ジョブが
// 複数箇所(手動クリック/自動生成watcher)から重ねて投げられても同じジョブに
// 収束するよう、選択アイテムidの集合から順序非依存のidを作る。
function buildTargetId(targetItems: FeedItem[]): string {
  return targetItems
    .map((item) => item.id)
    .slice()
    .sort()
    .join("+");
}

function abortError(): Error {
  const err = new Error("Request cancelled.");
  err.name = "AbortError";
  return err;
}

export function FeedView(props: {
  settings: AppSettings;
  authorDid: string;
  authorName: string;
  /** 自分の記事、新しい順。 */
  articles: NewsArticle[];
  /** グローバル記事ルーム(tc-global-articles)から受信済みの記事、新しい順。 */
  globalArticles: NewsArticle[];
  globalConnected: boolean;
  /** idありなら「みんな」タブのそのグローバル記事のリーダーへ、nullならグローバル一覧へ移動。 */
  onOpenGlobal: (id: string | null) => void;
  onArticleGenerated: (article: NewsArticle) => void;
  onShareToRoom: (article: NewsArticle) => void | Promise<void>;
  onShareToChat: (article: NewsArticle) => void | Promise<void>;
  onDeleteArticle: (id: string) => void;
  onArticleUpdated: (article: NewsArticle) => void;
  onTranslate: (article: NewsArticle, lang: Locale) => Promise<ArticleTranslation>;
  chatRoomId: string;
  /** "#/feed/<id>" 由来の深リンク先id(旧 "#/articles/<id>" もhashRoute側で
   * feedへのエイリアスとして解決済み)。 */
  deepLinkId?: string | null;
  onSelectionChange?: (id: string | null) => void;
}): JSX.Element {
  const {
    settings,
    authorDid,
    authorName,
    articles,
    globalArticles,
    globalConnected,
    onOpenGlobal,
    onArticleGenerated,
    onShareToRoom,
    onShareToChat,
    onDeleteArticle,
    onArticleUpdated,
    onTranslate,
    chatRoomId,
    deepLinkId,
    onSelectionChange,
  } = props;
  const t = useT();
  const { locale } = useLocale();
  const { feeds, addFeed, removeFeed, toggleFeed, updateFeed, items, refreshing, refreshAll, lastRefreshedAt, errors } =
    useFeeds(settings);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [genError, setGenError] = useState<string | null>(null);
  const [orchestrateProgress, setOrchestrateProgress] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<FeedItem | null>(null);
  // Reader modal for "your articles" (旧ArticlesViewの activeId 相当)。
  const [openArticleId, setOpenArticleId] = useState<string | null>(null);

  // フィード管理サイドバーの折りたたみ。保存値があればそれを、なければ
  // 「フィードがすでにあるなら畳む」を初期値にする(初回セットアップ中の
  // ユーザーからは追加フォームを隠さない)。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (raw !== null) return raw === "1";
    } catch {
      /* storage unavailable → session-only state */
    }
    return feeds.length > 0;
  });

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* best-effort persistence */
      }
      return next;
    });
  }

  // グローバル記事ルームから受信済みの記事(ミュート著者は除外)。表示件数の
  // 制限(先頭6件+「すべて見る」)は HomeArticleSections 側が持つ。
  const visibleGlobalArticles = useMemo(() => {
    const muted = loadMutedDids();
    return globalArticles.filter((article) => !isMuted(article.authorDid, muted));
  }, [globalArticles]);

  const openArticleRecord = openArticleId ? articles.find((a) => a.id === openArticleId) ?? null : null;

  // GenerateBarのチップ表示用: 選択中アイテムをitems内の表示順で並べる。
  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  );

  // Deep link: if a "#/feed/<id>" hash (or the legacy "#/articles/<id>" alias
  // resolved by hashRoute.ts) points at an id we hold, open it — mirrors the
  // former ArticlesView's deep-link effect. Only acts when the target differs
  // from the current selection, so it doesn't fight user clicks.
  useEffect(() => {
    if (deepLinkId && deepLinkId !== openArticleId && articles.some((a) => a.id === deepLinkId)) {
      setOpenArticleId(deepLinkId);
    }
  }, [deepLinkId, articles]);

  function openArticle(id: string | null) {
    setOpenArticleId(id);
    onSelectionChange?.(id);
  }

  // 実行中/待機中の生成ジョブは、このビューを離れて戻ってきても(=ローカル
  // state が失われても)反映されるよう、キューの pending ジョブ有無も disabled
  // の判定材料にする。JobQueueToast がジョブ自体の進捗表示を担うので、ここは
  // 「ブロックすべきか」だけを見る。
  const jobs = useJobQueue();
  const generateJobPending = jobs.some(
    (job) =>
      (job.kind === "generate" || job.kind === "orchestrate") &&
      (job.status === "queued" || job.status === "running" || job.status === "cancelling"),
  );
  const isGenerating = generating || generateJobPending;

  // Multi-run guard for the auto-generate watcher below.
  const autoGenLockRef = useRef(false);
  const generatingRef = useRef(false);
  generatingRef.current = isGenerating;

  async function runGenerate(targetItems: FeedItem[], userInstruction: string | undefined) {
    const targetId = buildTargetId(targetItems);
    // すでに同じ選択の生成ジョブが進行中なら、ここで新しい呼び出し経路の
    // then/catch を重ねて付けない(= 二重の後処理を防ぐ)。enqueueJob 自体も
    // 同じ kind+targetId でデデュープするが、後処理(onArticleGenerated 等)は
    // 呼び出し側にあるため、ガードは呼び出し側で行う必要がある。
    if (findPendingJob("generate", targetId)) return;
    setGenerating(true);
    setGenError(null);
    setStreamText("");
    try {
      const article = await enqueueJob(
        { kind: "generate", targetId, label: targetItems[0]?.title || userInstruction || t("feed.generateArticle") },
        async (signal) => {
          const article = await generateArticle(targetItems, {
            profileId: "",
            instruction: userInstruction,
            authorDid,
            authorName,
            language: LOCALE_LABELS[locale],
            locale,
            onDelta: (full) => setStreamText(full),
          });
          // generateArticle自体はsignalを受け取れない単発呼び出しなので、
          // 解決した直後がキャンセルを反映できる最初のタイミング。
          if (signal.aborted) throw abortError();
          return article;
        },
      );
      onArticleGenerated(article);
      // 単発生成は1件しか出ないので、そのままリーダーを開く(旧「記事タブへ
      // 自動遷移」の代替)。orchestrated側は複数件出うるため開かない。
      openArticle(article.id);
      setSelectedIds(new Set());
      setInstruction("");
    } catch (err) {
      // キャンセルはユーザー操作の結果であってエラーではないので表示しない。
      if (!isCancelError(err)) setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
      setStreamText("");
    }
  }

  // 編集部生成: orchestratorが計画→workerが並列執筆。部分失敗を許すので、
  // 成功した記事はすべて保存しつつ失敗ぶんのエラーだけ表示する。
  async function runOrchestrated(targetItems: FeedItem[], userInstruction: string | undefined) {
    const targetId = buildTargetId(targetItems);
    if (findPendingJob("orchestrate", targetId)) return;
    const provider = loadProviderSettings();
    setGenerating(true);
    setGenError(null);
    setStreamText("");
    setOrchestrateProgress(t("feed.orchestratePlanning"));
    try {
      const { articles, errors } = await enqueueJob(
        { kind: "orchestrate", targetId, label: t("feed.briefingGenerate") },
        async (signal, report) => {
          const result = await runOrchestratedGeneration(targetItems, {
            orchestratorProfileId: provider.orchestratorPresetId,
            workerProfileId: provider.workerPresetId,
            instruction: userInstruction,
            authorDid,
            authorName,
            language: LOCALE_LABELS[locale],
            locale,
            onProgress: (done, total) => {
              setOrchestrateProgress(t("feed.orchestrateGenerating", { done, total }));
              report(`${done}/${total}`);
            },
          });
          if (signal.aborted) throw abortError();
          return result;
        },
      );
      articles.forEach(onArticleGenerated);
      if (errors.length > 0) setGenError(errors.join(" / "));
      if (articles.length > 0) {
        setSelectedIds(new Set());
        setInstruction("");
      }
    } catch (err) {
      if (!isCancelError(err)) setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
      setOrchestrateProgress(null);
    }
  }

  // Tracks which item ids we've already seen so we can detect genuinely new
  // arrivals regardless of whether they came from the manual refresh button
  // or the hook's own mount/interval refresh. The first run just seeds the
  // snapshot (nothing should look "new" on initial load).
  const seenIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const currentIds = new Set(items.map((item) => item.id));
    if (seenIdsRef.current === null) {
      seenIdsRef.current = currentIds;
      return;
    }
    const arrived = items.filter((item) => !seenIdsRef.current?.has(item.id));
    seenIdsRef.current = currentIds;

    // ほぼ同内容の新着(複数ソースの同一話題)は代表1件に畳む — 閾値判定も
    // 生成入力も「実質何話題届いたか」で数える。
    const arrivedReps = groupNearDuplicateItems(arrived).map((group) => group.item);
    if (
      settings.autoGenerate &&
      arrivedReps.length >= AUTO_GENERATE_THRESHOLD &&
      !autoGenLockRef.current &&
      !generatingRef.current
    ) {
      autoGenLockRef.current = true;
      // 新着バッチは話題が混ざりがちなので、自動生成はorchestrated経路で
      // 複数記事へ振り分ける(計画が1件に潰れれば従来の単発生成と同じ)。
      void runOrchestrated(arrivedReps, undefined).finally(() => {
        autoGenLockRef.current = false;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, settings.autoGenerate]);

  // 定期リフレッシュでアイテムが落ちた後、選択集合に幽霊idが残ると件数表示と
  // 実際の生成対象がズレるため、items から消えたidは選択からも取り除く。
  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (items.some((item) => item.id === id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items]);

  // Escで選択をすべて解除。ただしモーダルが開いている間はモーダル側がEscで
  // 閉じる責任を持つのでここでは何もせず、入力欄内でのEscも選択解除に
  // 巻き込まない(GenerateBarの指示入力などでの誤操作防止)。
  useEffect(() => {
    if (selectedIds.size === 0) return;
    if (openItem !== null || openArticleId !== null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      setSelectedIds(new Set());
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds.size, openItem, openArticleId]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // 「すべて選択」やシフトクリックの範囲選択など、受信箱側の一括操作用。
  function selectMany(ids: string[], selected: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function handleGenerateClick() {
    const targets = items.filter((item) => selectedIds.has(item.id));
    if (targets.length === 0 || isGenerating) return;
    void runGenerate(targets, instruction.trim() || undefined);
  }

  function handleOrchestrateClick() {
    const targets = items.filter((item) => selectedIds.has(item.id));
    if (targets.length === 0 || isGenerating) return;
    void runOrchestrated(targets, instruction.trim() || undefined);
  }

  // 「あなたの記事」ヘッダの一発ブリーフィング生成: 新着の先頭から最大12件を
  // orchestratorに渡し、選択操作なしで複数記事へ振り分けさせる。ほぼ同内容の
  // アイテム(複数ソースの同一話題)は代表1件に畳んでから渡す — 同じ話題の
  // 記事が2本できるのを防ぐ。
  function handleBriefingClick() {
    if (isGenerating || items.length === 0) return;
    const representatives = groupNearDuplicateItems(items).map((group) => group.item);
    void runOrchestrated(representatives.slice(0, BRIEFING_ITEM_LIMIT), undefined);
  }

  return (
    <div class={`feed-view${sidebarCollapsed ? " feed-view--rail" : ""}`}>
      <FeedManageSidebar
        feeds={feeds}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
        refreshing={refreshing}
        lastRefreshedAt={lastRefreshedAt}
        errors={errors}
        onRefreshAll={() => void refreshAll()}
        onAddFeed={addFeed}
        onRemoveFeed={removeFeed}
        onToggleFeed={toggleFeed}
        onUpdateFeed={updateFeed}
      />

      <section class="feed-main">
        <HomeArticleSections
          articles={articles}
          onOpenArticle={openArticle}
          briefingDisabled={isGenerating || items.length === 0}
          onBriefingClick={handleBriefingClick}
          globalArticles={visibleGlobalArticles}
          globalConnected={globalConnected}
          onOpenGlobal={onOpenGlobal}
        />

        <FeedInbox
          items={items}
          hasFeeds={feeds.length > 0}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectMany={selectMany}
          onOpenItem={setOpenItem}
        />
      </section>

      <GenerateBar
        selectedItems={selectedItems}
        instruction={instruction}
        onInstructionChange={setInstruction}
        disabled={isGenerating}
        showProgress={generating}
        progressText={orchestrateProgress ?? (streamText || t("feed.generatingPlaceholder"))}
        error={genError}
        onGenerate={handleGenerateClick}
        onOrchestrate={handleOrchestrateClick}
        onRemoveSelected={(id) => selectMany([id], false)}
        onClearSelection={() => setSelectedIds(new Set())}
      />

      {openItem ? (
        <FeedItemModal
          item={openItem}
          selected={selectedIds.has(openItem.id)}
          onToggleSelect={() => toggleSelect(openItem.id)}
          onClose={() => setOpenItem(null)}
        />
      ) : null}

      {openArticleRecord ? (
        <ArticleReaderModal
          article={openArticleRecord}
          chatRoomId={chatRoomId}
          onClose={() => openArticle(null)}
          onShareToRoom={onShareToRoom}
          onShareToChat={onShareToChat}
          onDelete={onDeleteArticle}
          onArticleUpdated={onArticleUpdated}
          onTranslate={onTranslate}
        />
      ) : null}
    </div>
  );
}

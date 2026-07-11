// ホームタブ下部の折りたたみ可能な「新着アイテム受信箱」。旧FeedViewが
// メインコンテンツとして表示していたRSS新着グリッド(カテゴリフィルタ込み)
// を、記事優先レイアウトへの移行に伴いここへ独立させた。開閉状態は
// localStorageに永続化し、次回訪問時も同じ表示状態を保つ。
import { useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { ChevronDown, ChevronUp, Inbox, Rss } from "lucide-preact";
import type { FeedItem } from "../types";
import { useLinkPreview } from "../hooks/useLinkPreview";
import { mediaPreviewsEnabled } from "../lib/linkPreview";
import { formatRelativeTime } from "./ArticleCard";
import { EmptyState } from "./EmptyState";
import { ARTICLE_CATEGORIES, categoryLabelKey, coerceCategory, type ArticleCategory } from "../lib/categories";
import { useLocale, useT, type Locale } from "../lib/i18n";
import { groupNearDuplicateItems } from "../lib/feedDedupe";
import "../styles/feedInbox.css";

const COLLAPSE_STORAGE_KEY = "tc-news:feed-inbox-collapsed";

// 長押し(モバイルの選択モード起動)の判定パラメータ。
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;

function readCollapsedInitial(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // storage unavailable (private mode等) — 開閉自体は動くのでそのまま無視。
  }
}

/** 新着カード1件分。プレビュー取得はカード単位のフックが必要なため、
 * ここを独立コンポーネントに切り出している(元は items.map 内のインライン
 * JSXだった)。 */
function FeedItemCard(props: {
  item: FeedItem;
  duplicates?: FeedItem[];
  index: number;
  checked: boolean;
  selectionActive: boolean;
  onToggle: () => void;
  onCheckboxInteract: (shiftKey: boolean) => void;
  onOpen: () => void;
  locale: Locale;
  untitledLabel: string;
  selectAriaLabel: string;
}): JSX.Element {
  const { item, duplicates, index, checked, selectionActive, onToggle, onCheckboxInteract, onOpen, locale, untitledLabel, selectAriaLabel } =
    props;
  const t = useT();

  // RSSがすでに画像/動画を持っていればそれを使い、なければリンク先の
  // OGP相当プレビューを(設定が有効な間だけ)取りに行く。
  const wantPreview = mediaPreviewsEnabled() && !item.imageUrl && !item.videoUrl;
  const preview = useLinkPreview(wantPreview ? item.link : null);
  const imageUrl = mediaPreviewsEnabled() ? (item.imageUrl ?? preview?.imageUrl) : undefined;
  const videoUrl = mediaPreviewsEnabled() ? (item.videoUrl ?? preview?.videoUrl) : undefined;

  // Broken/hotlink-blocked images must not leave a broken-image icon behind.
  const [imgFailed, setImgFailed] = useState(false);
  const category = coerceCategory(item.category);

  // 長押し検出(モバイルの選択モード起動)用の内部状態。再レンダーを
  // 引き起こしたくないので全てrefで持つ。
  const longPressTimerRef = useRef<number | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handleTouchStart(e: JSX.TargetedTouchEvent<HTMLDivElement>) {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      try {
        navigator.vibrate?.(15);
      } catch {
        // Vibration API未対応/権限拒否は無視して選択だけ続行。
      }
      suppressClickRef.current = true;
      onToggle();
    }, LONG_PRESS_MS);
  }

  function handleTouchMove(e: JSX.TargetedTouchEvent<HTMLDivElement>) {
    const start = touchStartRef.current;
    const touch = e.touches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_PX) {
      clearLongPressTimer();
    }
  }

  function handleTouchEnd() {
    clearLongPressTimer();
  }

  function handleClick() {
    // 長押しが発火した直後についてくるclickは無視(二重トグル防止)。
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (selectionActive) {
      onToggle();
    } else {
      onOpen();
    }
  }

  function handleKeyDown(e: JSX.TargetedKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (selectionActive) {
        onToggle();
      } else {
        onOpen();
      }
    }
  }

  return (
    <div
      class={`feed-item-card${checked ? " feed-item-card--selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={selectionActive ? checked : undefined}
      style={{ "--card-index": index }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {videoUrl ? (
        <video
          class="feed-item-media"
          src={videoUrl}
          controls
          preload="none"
          poster={imageUrl}
          playsInline
          onClick={(e) => e.stopPropagation()}
        />
      ) : imageUrl && !imgFailed ? (
        <img
          class="feed-item-media"
          src={imageUrl}
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          onError={() => setImgFailed(true)}
        />
      ) : null}
      <div class="feed-item-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => {
            // 実際の状態更新はonClick側(シフト範囲選択対応)で行うため、
            // 制御コンポーネント用の空ハンドラのみ用意しておく。
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onCheckboxInteract(e.shiftKey);
          }}
          aria-label={selectAriaLabel}
        />
        <div class="feed-item-body">
          <a
            class="feed-item-title"
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {item.title || untitledLabel}
          </a>
          <div class="feed-item-meta">
            <span>{item.feedLabel}</span>
            <span class="feed-item-dot" aria-hidden="true">
              ・
            </span>
            <span>{formatRelativeTime(item.publishedAt, locale)}</span>
            {category ? <span class="category-chip">{t(categoryLabelKey(category))}</span> : null}
            {duplicates && duplicates.length > 0 ? (
              <span
                class="feed-item-dup"
                title={duplicates.map((d) => d.feedLabel).join(" / ")}
                aria-label={t("feed.inboxDupAria", { count: duplicates.length })}
              >
                +{duplicates.length}
              </span>
            ) : null}
          </div>
          {item.summary ? <p class="feed-item-summary">{item.summary}</p> : null}
        </div>
      </div>
    </div>
  );
}

export function FeedInbox(props: {
  items: FeedItem[];
  hasFeeds: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  /** 複数idの選択状態を一括で設定(すべて選択/シフト範囲選択用)。 */
  onSelectMany: (ids: string[], selected: boolean) => void;
  onOpenItem: (item: FeedItem) => void;
}): JSX.Element {
  const { items, selectedIds, onToggleSelect, onSelectMany, onOpenItem } = props;
  const t = useT();
  const { locale } = useLocale();
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsedInitial);
  const [filterCat, setFilterCat] = useState<ArticleCategory | null>(null);

  // シフトクリックによる範囲選択の起点。直近でチェックボックスを操作した
  // 代表アイテムのidを覚えておく(選択トグルの再レンダーは挟まない)。
  const selectionAnchorRef = useRef<string | null>(null);

  // ほぼ同一ニュース(複数ソースからの同一トピック)を1カードにまとめる。
  // itemsはnewest-first前提で、各クラスタの先頭が代表として表示される。
  const groups = useMemo(() => groupNearDuplicateItems(items), [items]);

  // Categories actually present among the current group representatives,
  // in taxonomy order — the filter bar only ever offers chips a user could
  // actually use.
  const presentCategories = useMemo(() => {
    const seen = new Set<ArticleCategory>();
    for (const group of groups) {
      const cat = coerceCategory(group.item.category);
      if (cat) seen.add(cat);
    }
    return ARTICLE_CATEGORIES.filter((cat) => seen.has(cat));
  }, [groups]);

  const visibleGroups = filterCat
    ? groups.filter((group) => coerceCategory(group.item.category) === filterCat)
    : groups;
  const visibleIds = useMemo(() => visibleGroups.map((group) => group.item.id), [visibleGroups]);

  const selectionActive = selectedIds.size > 0;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }

  // チェックボックス操作の一本化: 通常クリックはトグル、shift+クリックは
  // 直前の操作対象(アンカー)から今回クリックした代表までの範囲を、
  // クリックした項目の「次の状態」で一括反映する。
  function handleCheckboxInteract(id: string, shiftKey: boolean) {
    const anchor = selectionAnchorRef.current;
    if (shiftKey && anchor && anchor !== id) {
      const anchorIdx = visibleIds.indexOf(anchor);
      const targetIdx = visibleIds.indexOf(id);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        const rangeIds = visibleIds.slice(start, end + 1);
        onSelectMany(rangeIds, !selectedIds.has(id));
        selectionAnchorRef.current = id;
        return;
      }
    }
    onToggleSelect(id);
    selectionAnchorRef.current = id;
  }

  function handleSelectAllToggle() {
    onSelectMany(visibleIds, !allVisibleSelected);
  }

  return (
    <section class="feed-inbox">
      <div class="feed-inbox-head">
        <h2 class="feed-inbox-heading">
          <Inbox size={16} /> {t("feed.inboxHeading")}
          {groups.length > 0 ? <span class="feed-inbox-count">{groups.length}</span> : null}
        </h2>
        <p class="feed-inbox-hint">{t("feed.inboxHint")}</p>
        {!collapsed && visibleGroups.length > 0 ? (
          <button type="button" class="btn btn-ghost btn-small" onClick={handleSelectAllToggle}>
            {allVisibleSelected ? t("feed.inboxClearSelection") : t("feed.inboxSelectAll")}
          </button>
        ) : null}
        <button
          type="button"
          class="icon-btn"
          onClick={toggleCollapsed}
          title={collapsed ? t("feed.inboxExpandAria") : t("feed.inboxCollapseAria")}
          aria-label={collapsed ? t("feed.inboxExpandAria") : t("feed.inboxCollapseAria")}
        >
          {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </div>

      {collapsed ? null : groups.length === 0 ? (
        <EmptyState icon={Rss} title={t("feed.emptyTitle")} description={t("feed.emptyDescription")} />
      ) : (
        <div class="feed-inbox-body">
          {presentCategories.length > 0 ? (
            <div class="feed-filter-bar">
              <button
                type="button"
                class={`feed-filter-chip${filterCat === null ? " feed-filter-chip--active" : ""}`}
                aria-pressed={filterCat === null}
                onClick={() => setFilterCat(null)}
              >
                {t("common.categoryAll")}
              </button>
              {presentCategories.map((cat) => (
                <button
                  type="button"
                  key={cat}
                  class={`feed-filter-chip${filterCat === cat ? " feed-filter-chip--active" : ""}`}
                  aria-pressed={filterCat === cat}
                  onClick={() => setFilterCat(cat)}
                >
                  {t(categoryLabelKey(cat))}
                </button>
              ))}
            </div>
          ) : null}
          <div class={`feed-items-grid${selectionActive ? " feed-items-grid--selecting" : ""}`}>
            {visibleGroups.map((group, index) => (
              <FeedItemCard
                key={group.item.id}
                item={group.item}
                duplicates={group.duplicates}
                index={index}
                checked={selectedIds.has(group.item.id)}
                selectionActive={selectionActive}
                onToggle={() => onToggleSelect(group.item.id)}
                onCheckboxInteract={(shiftKey) => handleCheckboxInteract(group.item.id, shiftKey)}
                onOpen={() => onOpenItem(group.item)}
                locale={locale}
                untitledLabel={t("feed.untitledItem")}
                selectAriaLabel={t("feed.addToSelection")}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// フィード管理サイドバー: 記事優先レイアウトに合わせて、購読フィードの
// 追加/編集/削除/更新は普段は畳んでおける折りたたみ式サイドバーに分離した。
// 中身(フォーム/一覧/インライン編集)はHEAD版FeedViewの <aside class="feed-sidebar">
// をそのまま移設したもので、挙動は変えていない。
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { PanelLeftClose, Pencil, Plus, RefreshCw, Rss, Trash2 } from "lucide-preact";
import type { FeedSource } from "../types";
import { formatRelativeTime } from "../components/ArticleCard";
import { useLocale, useT } from "../lib/i18n";
import "../styles/feedSidebar.css";

export function FeedManageSidebar(props: {
  feeds: FeedSource[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  refreshing: boolean;
  lastRefreshedAt: number | null;
  errors: Record<string, string>;
  onRefreshAll: () => void;
  onAddFeed: (url: string, label?: string) => void;
  onRemoveFeed: (id: string) => void;
  onToggleFeed: (id: string) => void;
  onUpdateFeed: (id: string, patch: { url?: string; label?: string }) => void;
}): JSX.Element {
  const {
    feeds,
    collapsed,
    onToggleCollapsed,
    refreshing,
    lastRefreshedAt,
    errors,
    onRefreshAll,
    onAddFeed,
    onRemoveFeed,
    onToggleFeed,
    onUpdateFeed,
  } = props;
  const t = useT();
  const { locale } = useLocale();

  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [editingFeedId, setEditingFeedId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftUrl, setDraftUrl] = useState("");

  function handleAddFeed(e: Event) {
    e.preventDefault();
    if (!newUrl.trim()) return;
    onAddFeed(newUrl, newLabel.trim() || undefined);
    setNewUrl("");
    setNewLabel("");
  }

  function startEditFeed(feedId: string, label: string, url: string) {
    setEditingFeedId(feedId);
    setDraftLabel(label);
    setDraftUrl(url);
  }

  function cancelEditFeed() {
    setEditingFeedId(null);
    setDraftLabel("");
    setDraftUrl("");
  }

  function saveEditFeed() {
    if (!editingFeedId || !draftUrl.trim()) return;
    onUpdateFeed(editingFeedId, { label: draftLabel, url: draftUrl });
    cancelEditFeed();
  }

  function handleEditKeyDown(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      saveEditFeed();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEditFeed();
    }
  }

  if (collapsed) {
    return (
      <aside class="feed-sidebar feed-sidebar--collapsed">
        <button
          type="button"
          class="feed-sidebar-fab"
          onClick={onToggleCollapsed}
          title={t("feed.sidebarExpand")}
          aria-label={t("feed.sidebarExpand")}
        >
          <Rss size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside class="feed-sidebar">
      <div class="feed-sidebar-head">
        <h2 class="feed-sidebar-title">
          <Rss size={16} /> {t("feed.sidebarTitle")}
        </h2>
        <button
          type="button"
          class="icon-btn"
          onClick={() => void onRefreshAll()}
          disabled={refreshing}
          title={t("feed.refreshNow")}
          aria-label={t("feed.refreshNow")}
        >
          <RefreshCw size={15} class={refreshing ? "spin" : ""} />
        </button>
        <button
          type="button"
          class="icon-btn"
          onClick={onToggleCollapsed}
          title={t("feed.sidebarCollapse")}
          aria-label={t("feed.sidebarCollapse")}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>
      <p class="feed-sidebar-status">
        {lastRefreshedAt
          ? t("feed.lastRefreshed", { time: formatRelativeTime(lastRefreshedAt, locale) })
          : t("feed.neverRefreshed")}
      </p>

      <form class="feed-add-form" onSubmit={handleAddFeed}>
        <input
          value={newUrl}
          placeholder={t("feed.urlPlaceholder")}
          onInput={(e) => setNewUrl(e.currentTarget.value)}
        />
        <input
          value={newLabel}
          placeholder={t("feed.labelPlaceholder")}
          onInput={(e) => setNewLabel(e.currentTarget.value)}
        />
        <button type="submit" class="btn btn-primary">
          <Plus size={15} /> {t("feed.addFeed")}
        </button>
      </form>

      <ul class="feed-list">
        {feeds.length === 0 ? <li class="feed-list-empty">{t("feed.noFeeds")}</li> : null}
        {feeds.map((feed) =>
          editingFeedId === feed.id ? (
            <li key={feed.id} class="feed-row feed-row--editing">
              <div class="feed-row-edit">
                <input
                  autoFocus
                  value={draftLabel}
                  placeholder={t("feed.labelPlaceholder")}
                  onInput={(e) => setDraftLabel(e.currentTarget.value)}
                  onKeyDown={handleEditKeyDown}
                />
                <input
                  value={draftUrl}
                  placeholder={t("feed.urlPlaceholder")}
                  onInput={(e) => setDraftUrl(e.currentTarget.value)}
                  onKeyDown={handleEditKeyDown}
                />
                <div class="feed-row-edit-actions">
                  <button type="button" class="btn btn-ghost btn-small" onClick={cancelEditFeed}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    class="btn btn-primary btn-small"
                    onClick={saveEditFeed}
                    disabled={!draftUrl.trim()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
              {errors[feed.id] ? <p class="feed-row-error">{errors[feed.id]}</p> : null}
            </li>
          ) : (
            <li key={feed.id} class="feed-row">
              <label class="feed-row-toggle">
                <input type="checkbox" checked={feed.enabled} onChange={() => onToggleFeed(feed.id)} />
                <span class="feed-row-label" title={feed.url}>
                  {feed.label}
                </span>
              </label>
              <button
                type="button"
                class="icon-btn"
                onClick={() => startEditFeed(feed.id, feed.label, feed.url)}
                title={t("feed.editFeedAria", { name: feed.label })}
                aria-label={t("feed.editFeedAria", { name: feed.label })}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                class="icon-btn danger"
                onClick={() => onRemoveFeed(feed.id)}
                title={t("common.delete")}
                aria-label={t("feed.removeFeedAria", { name: feed.label })}
              >
                <Trash2 size={14} />
              </button>
              {errors[feed.id] ? <p class="feed-row-error">{errors[feed.id]}</p> : null}
            </li>
          ),
        )}
      </ul>
    </aside>
  );
}

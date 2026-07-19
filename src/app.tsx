// App shell: owns top-level state (settings, active tab, local DID identity,
// my generated articles) and wires the room/theme hooks into the four main
// tabs — feed ("ホーム": feed management + own-article reading/rating/
// translate/share/delete, since the 4-tab IA rework folded the former
// "articles" tab into it), shared ("みんな"), program, settings. Each view
// imports and owns its own CSS under src/styles/ — this file only pulls in
// the app-shell chrome classes defined in index.css (imported once, by
// main.tsx).
//
// SPEC2 additions: a second, always-well-known "global" room
// (GLOBAL_ARTICLES_ROOM_ID) runs alongside the user's private room so the
// Shared tab can show both; the URL hash drives deep links into a tab/article
// and a one-shot room switch on startup (see lib/hashRoute.ts — it also
// resolves the legacy "#/articles(/<id>)" hash as a feed-tab alias); and the
// Shared tab badge tracks unread articles across both rooms.
import { useEffect, useState } from "preact/hooks";
import {
  Globe,
  House,
  MessagesSquare,
  Moon,
  Newspaper,
  Radio,
  Settings as SettingsIcon,
  Sun,
} from "lucide-preact";

import type { AppSettings, MainTab, NewsArticle, RadioProgram, ReactionKind } from "./types";
import { loadAppSettings, saveAppSettings, resolveInitialTab } from "./lib/appSettings";
import { loadLlmConfig } from "./lib/llmConfig";
import { loadProviderSettings } from "./lib/llmSettings";
import { markOnboardingDone, shouldShowOnboarding, subscribeOnboardingRequests } from "./lib/onboarding";
import { connectNetworkConsumer } from "./lib/network";
import { loadMyArticles, upsertMyArticle, deleteMyArticle, saveSharedArticle } from "./lib/articleStore";
import { upsertProgram } from "./lib/programStore";
import { initKvStore, subscribeKvHydrated } from "./lib/kvStore";
import { GLOBAL_ARTICLES_ROOM_ID, cleanupOrphanedRoomKeys } from "./lib/newsWire";
import { forwardArticleToGlobal } from "./lib/globalArticlesReader";
import { readHash, writeHash, onHashChange } from "./lib/hashRoute";
import { useTheme } from "./hooks/useTheme";
import { useNetworkProviderHost } from "./hooks/useNetworkProviderHost";
import { useNewsRoom } from "./hooks/useNewsRoom";
import { useUnreadShared } from "./hooks/useUnreadShared";
import { ensureDidIdentity } from "./crypto/didIdentity";
import { publishArticleToChat } from "./lib/chatShare";
import { LOCALE_LABELS, useT, type Locale } from "./lib/i18n";
import { translateArticle } from "./lib/translate";
import { getTranslation, saveTranslation, type ArticleTranslation } from "./lib/translationStore";
import { enqueueJob } from "./lib/jobQueue";
import { clearTranslationProgress, publishTranslationProgress } from "./lib/translationProgress";
import { FeedView } from "./views/FeedView";
import { SharedView } from "./views/SharedView";
import { ProgramView } from "./views/ProgramView";
import { SettingsView } from "./views/SettingsView";
import { Onboarding } from "./components/Onboarding";
import { JobQueueToast } from "./components/JobQueueToast";
import { MiniPlayer } from "./components/MiniPlayer";

// Nav tab labels come from each domain's own catalog (feed.tabLabel etc.) so
// the domain owner controls the wording; this file only wires icon + tab id.
// feed's icon is Newspaper (not Rss) now that the tab is where you actually
// read articles, not just triage new feed items.
const TABS: Array<{ id: MainTab; labelKey: string; icon: typeof Newspaper }> = [
  { id: "feed", labelKey: "feed.tabLabel", icon: Newspaper },
  { id: "shared", labelKey: "shared.tabLabel", icon: Globe },
  { id: "program", labelKey: "program.tabLabel", icon: Radio },
  { id: "settings", labelKey: "settings.tabLabel", icon: SettingsIcon },
];

// First occurrence wins — callers put the private room's list before the
// global room's, so a program shared to both shows the room copy.
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function App() {
  const t = useT();
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings());
  const [tab, setTab] = useState<MainTab>(() => {
    const h = readHash();
    return h.tab ?? resolveInitialTab();
  });
  // Deep-linked article id per tab (only "feed"/"shared" ever carry one —
  // see hashRoute.ts's parseHash; it also resolves the legacy "#/articles"
  // hash to "feed" before we ever see it here). Kept separate per tab so
  // switching tabs doesn't clobber the other tab's pending selection.
  const [homeDeepLinkId, setHomeDeepLinkId] = useState<string | null>(() => {
    const h = readHash();
    return h.tab === "feed" ? h.articleId : null;
  });
  const [sharedDeepLinkId, setSharedDeepLinkId] = useState<string | null>(() => {
    const h = readHash();
    return h.tab === "shared" ? h.articleId : null;
  });
  // ランキングの番組行から番組タブへ深リンクする際の選択id。hashRouteは
  // programタブ用のidを持たない(#/programのみ)ので、ここのpropsだけで運ぶ。
  const [programDeepLinkId, setProgramDeepLinkId] = useState<string | null>(null);
  // ホームの「すべて見る」等から「みんな」タブを開く際の初期ソース指定。
  // SharedViewのsource state自体はデフォルトroomなので、これがないとid無し
  // の遷移(id=null)ではglobalではなくroomが開いてしまう。毎回新しいオブジェ
  // クトで包むのは、同じsource値の連続ナビゲーション(global→手動でroomへ→
  // 再びglobal)でもSharedView側のeffectが発火するようにするため。
  const [sharedSourceHint, setSharedSourceHint] = useState<{ source: "room" | "global" } | null>(null);
  const [did, setDid] = useState<string>("");
  const [articles, setArticles] = useState<NewsArticle[]>(() => loadMyArticles());

  // Boots the mist KV backend (lib/kvStore.ts) that feed-items/articles/
  // programs/etc. persist through; safe to call every mount, it's idempotent.
  // `articles` above was seeded from loadMyArticles() before hydration could
  // finish (pre-hydration reads fall back to localStorage, which is empty
  // once a previous session migrated its data into the KV) — re-read once
  // hydration replaces that fallback.
  useEffect(() => {
    void initKvStore();
    return subscribeKvHydrated(() => setArticles(loadMyArticles()));
  }, []);

  // Startup cleanup for tc-news:shared:<roomId> / tc-news:shared-programs:
  // <roomId> orphans left behind in localStorage by rooms the user switched
  // away from (see lib/newsWire.ts's cleanupOrphanedRoomKeys — those caches
  // now live in the mist KV, migrated lazily per room by useNewsRoom below).
  // Includes the #room= deep-link target (if any), which the effect further
  // down applies to settings.roomId right after this one runs, so that
  // room's own key isn't swept before it gets a chance to migrate.
  useEffect(() => {
    const linkedRoom = readHash().room;
    cleanupOrphanedRoomKeys([settings.roomId, GLOBAL_ARTICLES_ROOM_ID, linkedRoom].filter((id): id is string => !!id));
    // Mount-only: covers startup state. Rooms joined later in the session
    // stay safe via useNewsRoom's own per-room migration on load, independent
    // of this one-shot sweep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-run wizard: shown once on a fresh install, and re-openable from the
  // settings screen. Closing it (any path) marks onboarding done.
  const [showOnboarding, setShowOnboarding] = useState(() => shouldShowOnboarding());
  useEffect(() => subscribeOnboardingRequests(() => setShowOnboarding(true)), []);

  function closeOnboarding() {
    markOnboardingDone();
    setShowOnboarding(false);
  }

  const theme = useTheme();

  // userName未設定時の表示名はローカライズされた「匿名」。
  const displayName = settings.userName.trim() || t("common.anonymous");

  const {
    sharedArticles,
    sharedPrograms,
    sharedFeeds,
    share,
    shareTranslation,
    shareProgram,
    sendReaction,
    shareFeed,
    connected,
    peers,
  } = useNewsRoom(settings.roomId, displayName);
  // The private room *is* the global room when the user pointed settings.roomId
  // at it directly — avoid double-joining by disabling this hook in that case
  // (useNewsRoom resets to the empty/disconnected shape when enabled=false).
  const globalRoom = useNewsRoom(
    GLOBAL_ARTICLES_ROOM_ID,
    displayName,
    settings.roomId !== GLOBAL_ARTICLES_ROOM_ID,
  );

  // Programs from both rooms merge into one list for the Shared/Program tabs
  // (room first, so the private-room copy wins over the global re-publish).
  const allSharedPrograms = dedupeById([...sharedPrograms, ...globalRoom.sharedPrograms]);

  const unread = useUnreadShared([...sharedArticles, ...globalRoom.sharedArticles], tab === "shared");

  useEffect(() => {
    ensureDidIdentity()
      .then((identity) => setDid(identity.did))
      .catch(() => {
        // No DID yet (e.g. WebCrypto unavailable); sharing/generation degrade
        // gracefully to an empty authorDid rather than blocking the app.
      });
  }, []);

  // AI Network consumer: 設定で有効なら起動時に接続しておく(設定画面を開か
  // なくても最初の生成からnetwork経由になるように)。以後のon/off・room変更は
  // SettingsView側のeffectが引き継ぐ。
  useEffect(() => {
    const provider = loadProviderSettings();
    const room = loadLlmConfig()?.network.roomId.trim() ?? "";
    if (provider.networkConsumerEnabled && room) void connectNetworkConsumer(room);
  }, []);

  // AI Network provider: アプリ全体の寿命でホストする(設定画面を閉じても
  // 提供が続くように)。SettingsViewには表示用にstatusを渡すだけ。
  const networkProvider = useNetworkProviderHost();

  // #room=<roomId> startup handling: a one-shot deep link that switches the
  // active room, then clears the hash so the user's own navigation (or a
  // later reload) doesn't keep re-triggering it.
  useEffect(() => {
    const h = readHash();
    if (h.room && h.room !== settings.roomId) {
      const next: AppSettings = { ...settings, roomId: h.room };
      saveAppSettings(next);
      setSettings(next);
      setTab("shared");
      writeHash("shared", null);
    }
    // Runs once on mount only — this is a startup one-shot, not a live sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward (and any other hashchange) reflects into tab + deep-link
  // state. We don't writeHash back here — the browser already owns the URL
  // for this case, writing again would just be a no-op loop.
  useEffect(() => {
    return onHashChange((state) => {
      if (!state.tab) return;
      setTab(state.tab);
      if (state.tab === "feed") setHomeDeepLinkId(state.articleId);
      else if (state.tab === "shared") setSharedDeepLinkId(state.articleId);
    });
  }, []);

  function selectTab(next: MainTab) {
    setTab(next);
    const id = next === "feed" ? homeDeepLinkId : next === "shared" ? sharedDeepLinkId : null;
    writeHash(next, id);
  }

  function handleHomeSelectionChange(id: string | null) {
    setHomeDeepLinkId(id);
    writeHash("feed", id);
  }

  function handleSharedSelectionChange(id: string | null) {
    setSharedDeepLinkId(id);
    writeHash("shared", id);
  }

  // ホームのグローバルニュースから「みんな」タブへ: idありならその記事の
  // リーダーへ深リンク、nullなら一覧(グローバル)へ移動するだけ。
  function handleOpenGlobal(id: string | null) {
    setSharedSourceHint({ source: "global" });
    setSharedDeepLinkId(id);
    setTab("shared");
    writeHash("shared", id);
  }

  // ランキングの番組行から番組タブへ。hashRouteはprogramタブのidを持たない
  // (#/program のみ)ので、選択はpropsで渡すdeepLinkIdだけで運ぶ。
  function handleOpenProgram(id: string) {
    setProgramDeepLinkId(id);
    setTab("program");
    writeHash("program");
  }

  function handleSettingsChange(next: AppSettings) {
    setSettings(next);
    saveAppSettings(next);
  }

  // Own-article translate: broadcast the result to whichever room(s) the
  // article was already shared to (mirrors ArticlesView's onShareToRoom dual
  // publish below). An article never shared anywhere has no room to
  // broadcast into, so the translation just stays in the local cache —
  // still avoids re-running the LLM on repeat views.
  //
  // Both handlers below enqueue their body into the global AI job queue
  // (lib/jobQueue); the queue dedups by kind+targetId+lang, so a
  // double-click on the same article×language from two different views (or
  // the same view twice) collapses onto one in-flight job/promise.
  async function handleTranslateOwnArticle(article: NewsArticle, lang: Locale): Promise<ArticleTranslation> {
    const existing = getTranslation(article.id, lang);
    if (existing) return existing;
    return enqueueJob({ kind: "article", targetId: article.id, label: article.title, lang }, async (signal, report) => {
      try {
        const content = await translateArticle(article, {
          profileId: "",
          targetLanguage: LOCALE_LABELS[lang],
          lang,
          signal,
          onProgress: (p) => {
            publishTranslationProgress({
              kind: "article",
              targetId: article.id,
              lang,
              title: p.title,
              subtitle: p.excerpt,
              body: p.body,
              doneChunks: p.doneChunks,
              totalChunks: p.totalChunks,
            });
            if (p.totalChunks > 0) report(`${p.doneChunks}/${p.totalChunks}`);
          },
        });
        // translateArticle checks the signal between chunk calls, but a
        // cancellation that lands while the *final* chunk is in flight still
        // resolves normally — catch that here so a cancelled job doesn't go
        // on to save/share its result. (The per-chunk partial saves are kept;
        // they're what makes the next attempt resumable.)
        if (signal.aborted) {
          const err = new Error("Request cancelled.");
          err.name = "AbortError";
          throw err;
        }
        if (!article.shared) {
          return saveTranslation({
            articleId: article.id,
            lang,
            title: content.title,
            excerpt: content.excerpt,
            body: content.body,
            translatorDid: did,
            translatorName: displayName,
            translatedAt: Date.now(),
          });
        }
        const record = await shareTranslation(article.id, lang, content);
        if (settings.globalShare && settings.roomId !== GLOBAL_ARTICLES_ROOM_ID) {
          try {
            await globalRoom.shareTranslation(article.id, lang, content);
          } catch (err) {
            // Room translation already succeeded; the global re-publish is a
            // best-effort extra and must not fail the user's action.
            console.warn("tc-news: failed to publish translation to global room", err);
          }
        }
        return record;
      } finally {
        // The job (and its onProgress emits) can outlive whichever modal
        // opened it — always drop the live-progress entry on settle
        // (success, failure, or cancel) so readers fall back to the durable
        // translationStore/partialTranslationStore instead of a stale
        // in-memory snapshot.
        clearTranslationProgress("article", article.id, lang);
      }
    });
  }

  // Received-article translate: any reader in a room may contribute a
  // translation (signed with their own DID, not the original author's), so
  // it becomes a shared resource the next reader doesn't have to re-pay the
  // LLM for.
  async function handleTranslateSharedArticle(
    article: NewsArticle,
    lang: Locale,
    source: "room" | "global",
  ): Promise<ArticleTranslation> {
    const existing = getTranslation(article.id, lang);
    if (existing) return existing;
    return enqueueJob({ kind: "article", targetId: article.id, label: article.title, lang }, async (signal, report) => {
      try {
        const content = await translateArticle(article, {
          profileId: "",
          targetLanguage: LOCALE_LABELS[lang],
          lang,
          signal,
          onProgress: (p) => {
            publishTranslationProgress({
              kind: "article",
              targetId: article.id,
              lang,
              title: p.title,
              subtitle: p.excerpt,
              body: p.body,
              doneChunks: p.doneChunks,
              totalChunks: p.totalChunks,
            });
            if (p.totalChunks > 0) report(`${p.doneChunks}/${p.totalChunks}`);
          },
        });
        // See handleTranslateOwnArticle: a cancellation during the final
        // chunk still resolves — stop the job here before it shares its
        // (unwanted) result into the room.
        if (signal.aborted) {
          const err = new Error("Request cancelled.");
          err.name = "AbortError";
          throw err;
        }
        return source === "room"
          ? shareTranslation(article.id, lang, content)
          : globalRoom.shareTranslation(article.id, lang, content);
      } finally {
        // See handleTranslateOwnArticle's finally: this job can outlive the
        // modal that started it.
        clearTranslationProgress("article", article.id, lang);
      }
    });
  }

  return (
    <div class="app-shell">
      <header class="app-header">
        <div class="app-header-brand">
          <Newspaper size={20} />
          <span>TC News</span>
        </div>
        <nav class="app-tabs">
          {TABS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              type="button"
              class={`app-tab${tab === id ? " app-tab-active" : ""}`}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => selectTab(id)}
            >
              <Icon size={16} />
              <span>{t(labelKey)}</span>
              {id === "shared" && unread > 0 && (
                <span class="tab-badge" aria-label={t("shared.unreadBadge", { count: unread })}>
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div class="app-header-links">
          <a
            class="app-link"
            href="../tc-chat/"
            target="_blank"
            rel="noopener"
            title={t("common.appLinkChat")}
            aria-label={t("common.appLinkChat")}
          >
            <MessagesSquare size={18} />
          </a>
          <a
            class="app-link"
            href="../tc-home/"
            target="_blank"
            rel="noopener"
            title={t("common.appLinkHome")}
            aria-label={t("common.appLinkHome")}
          >
            <House size={18} />
          </a>
          <button
            type="button"
            class="theme-toggle"
            onClick={theme.toggleTheme}
            aria-label={theme.theme === "light" ? t("settings.switchToDark") : t("settings.switchToLight")}
          >
            {theme.theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </div>
      </header>

      <main class="app-main">
        {tab === "feed" && (
          <FeedView
            settings={settings}
            authorDid={did}
            authorName={displayName}
            articles={articles}
            onArticleGenerated={(article) => {
              upsertMyArticle(article);
              setArticles(loadMyArticles());
            }}
            onShareToRoom={async (article) => {
              await share(article);
              if (settings.globalShare && settings.roomId !== GLOBAL_ARTICLES_ROOM_ID) {
                try {
                  await globalRoom.share(article);
                } catch (err) {
                  // Room share already succeeded; the global re-publish is a
                  // best-effort extra and must not fail the user's action.
                  console.warn("tc-news: failed to publish article to global room", err);
                }
              }
              upsertMyArticle({ ...article, shared: true });
              setArticles(loadMyArticles());
            }}
            onShareToChat={(article) => publishArticleToChat(article)}
            onDeleteArticle={(id) => {
              deleteMyArticle(id);
              setArticles(loadMyArticles());
            }}
            onArticleUpdated={(a) => {
              upsertMyArticle(a);
              setArticles(loadMyArticles());
            }}
            onTranslate={handleTranslateOwnArticle}
            chatRoomId={settings.roomId}
            deepLinkId={homeDeepLinkId}
            onSelectionChange={handleHomeSelectionChange}
            globalArticles={settings.roomId === GLOBAL_ARTICLES_ROOM_ID ? sharedArticles : globalRoom.sharedArticles}
            globalConnected={settings.roomId === GLOBAL_ARTICLES_ROOM_ID ? connected : globalRoom.connected}
            onOpenGlobal={handleOpenGlobal}
            sharedPrograms={allSharedPrograms}
            onOpenProgram={handleOpenProgram}
          />
        )}
        {tab === "shared" && (
          <SharedView
            roomId={settings.roomId}
            roomArticles={sharedArticles}
            roomConnected={connected}
            roomPeers={peers}
            globalArticles={globalRoom.sharedArticles}
            globalConnected={globalRoom.connected}
            globalPeers={globalRoom.peers}
            chatRoomId={settings.roomId}
            deepLinkId={sharedDeepLinkId}
            sourceHint={sharedSourceHint}
            onSelectionChange={handleSharedSelectionChange}
            onOpenProgram={handleOpenProgram}
            onSaveToArticles={(article, originRoomId) => {
              const ok = saveSharedArticle(article, originRoomId);
              if (ok) setArticles(loadMyArticles());
              return ok;
            }}
            onForwardToGlobal={(articleId, fromRoomId) => forwardArticleToGlobal(articleId, fromRoomId)}
            onTranslate={handleTranslateSharedArticle}
            myDid={did}
            sharedPrograms={allSharedPrograms}
            onReact={(targetId: string, targetType: "article" | "program", kind: ReactionKind, source: "room" | "global") =>
              source === "room"
                ? sendReaction(targetId, targetType, kind)
                : globalRoom.sendReaction(targetId, targetType, kind)
            }
            roomSharedFeeds={sharedFeeds}
            globalSharedFeeds={globalRoom.sharedFeeds}
            onShareFeed={(url: string, label: string, source: "room" | "global") =>
              source === "room" ? shareFeed(url, label) : globalRoom.shareFeed(url, label)
            }
          />
        )}
        {tab === "program" && (
          <ProgramView
            articles={articles}
            myDid={did}
            sharedPrograms={allSharedPrograms}
            deepLinkId={programDeepLinkId}
            rubyEnabled={settings.programRuby}
            onShareProgram={async (program: RadioProgram) => {
              const stamped = await shareProgram(program);
              if (settings.globalShare && settings.roomId !== GLOBAL_ARTICLES_ROOM_ID) {
                try {
                  await globalRoom.shareProgram(stamped);
                } catch (err) {
                  // Room share already succeeded; the global re-publish is a
                  // best-effort extra and must not fail the user's action.
                  console.warn("tc-news: failed to publish program to global room", err);
                }
              }
              upsertProgram(stamped);
              return stamped;
            }}
            onReactToProgram={async (programId: string, kind: ReactionKind) => {
              // Program reactions go to both rooms so tallies converge no
              // matter which room a listener received the program from —
              // receivers dedup by (targetId, kind, fromId), so the double
              // wire is harmless.
              await sendReaction(programId, "program", kind);
              if (settings.roomId !== GLOBAL_ARTICLES_ROOM_ID) {
                try {
                  await globalRoom.sendReaction(programId, "program", kind);
                } catch {
                  /* best-effort */
                }
              }
            }}
          />
        )}
        {tab === "settings" && (
          <SettingsView settings={settings} onSettingsChange={handleSettingsChange} networkProvider={networkProvider} />
        )}
      </main>
      {showOnboarding && (
        <Onboarding settings={settings} onSettingsChange={handleSettingsChange} onClose={closeOnboarding} />
      )}
      <JobQueueToast />
      <MiniPlayer />
    </div>
  );
}

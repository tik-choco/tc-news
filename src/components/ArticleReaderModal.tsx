// Modal wrapper around ArticleReader for the merged "ホーム" (feed) tab —
// this is ArticlesView's former reader pane (right side), lifted out and
// turned into an overlay so the feed tab's own list can stay the primary
// surface. Ports every reader-toolbar action from ArticlesView verbatim:
// ReactionBar, LLM-judge evaluation (Gauge button + score pill +
// EvaluationPanel, with auto-applied category on a fresh judgement),
// translate/original toggle, share-to-room, share-to-chat (with a 10s
// "sent" notice carrying a chatUrl link), an always-visible "open in chat"
// link, and delete (confirm -> deleteArticleEvaluations -> onDelete ->
// onClose, per this component's own contract — the caller only has to drop
// the id from its list).
//
// Same modal convention as components/FeedItemModal.tsx: overlay click or
// Escape closes, a click inside the panel is stopped from bubbling to the
// overlay, and the panel is role="dialog".
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Gauge, Languages, MessageSquare, MessagesSquare, Share2, Trash2, X } from "lucide-preact";
import type { NewsArticle } from "../types";
import { ArticleReader } from "./ArticleReader";
import { EvaluationPanel } from "./EvaluationPanel";
import { ReactionBar } from "./ReactionBar";
import { LOCALE_LABELS, useLocale, useT, type Locale } from "../lib/i18n";
import { chatUrl } from "../lib/chatShare";
import { categoryLabelKey, coerceCategory } from "../lib/categories";
import { deleteArticleEvaluations, evaluateArticle, getLatestArticleEvaluation } from "../lib/articleEvaluation";
import { getTranslation, type ArticleTranslation } from "../lib/translationStore";
import { getPartialTranslation } from "../lib/partialTranslationStore";
import { isCancelError } from "../lib/jobQueue";
import { useTranslationProgress } from "../hooks/useTranslationProgress";
import { LanguagePicker } from "./LanguagePicker";
import "../styles/components.css";
import "../styles/readerModal.css";

type BusyAction = "room" | "chat" | null;

// How long the post-share "sent to tc-chat" notice (with its openInChatLink
// link) stays visible before auto-dismissing. Also reused for the
// "category applied" notice below (same flavor, same timing) — mirrors
// ArticlesView's CHAT_NOTICE_MS.
const CHAT_NOTICE_MS = 10_000;

export function ArticleReaderModal(props: {
  article: NewsArticle;
  chatRoomId: string;
  onClose: () => void;
  onShareToRoom: (article: NewsArticle) => void | Promise<void>;
  onShareToChat: (article: NewsArticle) => void | Promise<void>;
  /** 呼び出し側が記事リストから消す。モーダル自身は confirm と評価レコード削除
   * (deleteArticleEvaluations) を済ませてから呼び、その後 onClose する。 */
  onDelete: (id: string) => void;
  onArticleUpdated: (article: NewsArticle) => void;
  onTranslate: (article: NewsArticle, lang: Locale) => Promise<ArticleTranslation>;
}): JSX.Element {
  const { article, chatRoomId, onClose, onShareToRoom, onShareToChat, onDelete, onArticleUpdated, onTranslate } =
    props;
  const t = useT();
  const { locale } = useLocale();

  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [chatNotice, setChatNotice] = useState(false);
  const chatNoticeTimer = useRef<number | undefined>(undefined);

  // Evaluation flow state — same shape as ArticlesView: evaluatingId is a
  // single-flight guard, panelOpen tracks the EvaluationPanel's disclosure
  // and starts closed on every fresh article.
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null);
  const categoryNoticeTimer = useRef<number | undefined>(undefined);

  // Translate flow state — translatingId is a single-flight guard;
  // showTranslated resets (like panelOpen) on every fresh article.
  const [translatingId, setTranslatingId] = useState<string | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [showTranslated, setShowTranslated] = useState(false);
  // Translate target language, independent of the UI locale — defaults to it
  // on mount/article change but the reader-toolbar LanguagePicker lets the
  // user pick any of LOCALES for this article specifically.
  const [targetLang, setTargetLang] = useState<Locale>(locale);

  // Mirrors ArticlesView's activeIdRef: lets an in-flight evaluate/translate
  // continuation tell whether the modal has since been reassigned to a
  // different article (the modal instance is reused across selections, it
  // isn't remounted per article) before touching state meant for the
  // article now on screen.
  const articleIdRef = useRef<string | null>(null);
  articleIdRef.current = article.id;

  const latestEval = getLatestArticleEvaluation(article.id);
  // Not stateful — re-read on every render, same idiom as ArticlesView.
  const cachedTranslation = getTranslation(article.id, targetLang);
  const needsTranslation = article.lang !== targetLang;
  // Live streaming progress for this article×targetLang — populated
  // regardless of which surface (this modal, SharedView, or a background
  // resume) actually started the translation job, since
  // lib/translationProgress is a module singleton keyed by targetId×lang,
  // not by job origin.
  const liveProgress = useTranslationProgress("article", article.id, targetLang);
  // A partial (interrupted) translation resumable from lib/translate.ts's
  // chunk-level persistence — same re-read-every-render idiom as
  // cachedTranslation, used only to relabel the translate button below.
  const partialTranslation = getPartialTranslation(article.id, targetLang);
  const displayArticle: NewsArticle =
    showTranslated && cachedTranslation
      ? { ...article, title: cachedTranslation.title, excerpt: cachedTranslation.excerpt, body: cachedTranslation.body }
      : liveProgress && !cachedTranslation
        ? {
            ...article,
            title: liveProgress.title ?? article.title,
            excerpt: liveProgress.subtitle ?? article.excerpt,
            body: liveProgress.body || article.body,
          }
        : article;

  // A fresh article always starts with the evaluation panel closed and any
  // stale error/translation-view state from the previous article cleared.
  useEffect(() => {
    setPanelOpen(false);
    setEvalError(null);
    setShowTranslated(false);
    setTranslateError(null);
    setTargetLang(locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (chatNoticeTimer.current !== undefined) window.clearTimeout(chatNoticeTimer.current);
      if (categoryNoticeTimer.current !== undefined) window.clearTimeout(categoryNoticeTimer.current);
    };
  }, []);

  async function handleShareRoom() {
    setBusyAction("room");
    try {
      await onShareToRoom(article);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleShareChat() {
    setBusyAction("chat");
    try {
      await onShareToChat(article);
      setChatNotice(true);
      if (chatNoticeTimer.current !== undefined) window.clearTimeout(chatNoticeTimer.current);
      chatNoticeTimer.current = window.setTimeout(() => setChatNotice(false), CHAT_NOTICE_MS);
    } finally {
      setBusyAction(null);
    }
  }

  function handleDelete() {
    const ok = window.confirm(t("articles.deleteConfirm", { title: article.title || t("articles.thisArticle") }));
    if (!ok) return;
    deleteArticleEvaluations(article.id);
    onDelete(article.id);
    onClose();
  }

  async function handleEvaluate() {
    if (evaluatingId) return; // single-flight guard
    setEvaluatingId(article.id);
    setEvalError(null);
    try {
      const record = await evaluateArticle(article, {
        profileId: "",
        language: LOCALE_LABELS[locale],
      });
      if (articleIdRef.current !== article.id) return; // navigated away meanwhile
      setPanelOpen(true);
      if (!article.category) {
        const appliedCategory = coerceCategory(record.category);
        if (appliedCategory) {
          onArticleUpdated({ ...article, category: appliedCategory });
          setCategoryNotice(t("articles.evalCategoryApplied", { category: t(categoryLabelKey(appliedCategory)) }));
          if (categoryNoticeTimer.current !== undefined) window.clearTimeout(categoryNoticeTimer.current);
          categoryNoticeTimer.current = window.setTimeout(() => setCategoryNotice(null), CHAT_NOTICE_MS);
        }
      }
    } catch (err) {
      if (articleIdRef.current === article.id) {
        setEvalError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setEvaluatingId(null);
    }
  }

  async function handleTranslate() {
    if (translatingId) return; // single-flight guard
    setTranslatingId(article.id);
    setTranslateError(null);
    try {
      await onTranslate(article, targetLang);
      if (articleIdRef.current === article.id) setShowTranslated(true);
    } catch (err) {
      // A queue-toast cancel rejects with an AbortError — that's a user
      // action, not a failure worth an error line.
      if (articleIdRef.current === article.id && !isCancelError(err)) {
        setTranslateError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setTranslatingId(null);
    }
  }

  return (
    <div class="reader-modal-overlay" onClick={onClose}>
      <div
        class="reader-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={article.title || t("articles.untitledArticle")}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          class="reader-modal-close"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <X size={18} />
        </button>

        <div class="reader-modal-toolbar">
          <div class="reader-modal-toolbar-actions">
            <ReactionBar targetId={article.id} />
            {latestEval ? (
              <button
                type="button"
                class="reader-modal-eval-score-btn"
                title={t("articles.evalOverall")}
                aria-label={t("articles.evalOverall")}
                onClick={() => setPanelOpen((open) => !open)}
              >
                <span class="eval-score-pill">{Math.round(latestEval.overallScore)}</span>
              </button>
            ) : null}
            <button
              type="button"
              class="btn btn-ghost"
              disabled={evaluatingId === article.id}
              onClick={() => void handleEvaluate()}
            >
              <Gauge size={14} />
              {evaluatingId === article.id ? t("articles.evaluating") : t("articles.evaluate")}
            </button>
            <LanguagePicker
              value={targetLang}
              onChange={(lang) => {
                setTargetLang(lang);
                // Switching target language jumps straight to that
                // language's cached translation if one exists; otherwise
                // falls back to the original (mirrors selectArticle's
                // showTranslated reset elsewhere in this file).
                setShowTranslated(getTranslation(article.id, lang) !== null);
              }}
              disabled={translatingId === article.id || !!liveProgress}
            />
            {needsTranslation && !cachedTranslation ? (
              <button
                type="button"
                class="btn btn-ghost"
                // Disabled both for this modal's own in-flight request
                // (translatingId) and for a job started elsewhere on the
                // same article×locale (liveProgress) — the queue dedups by
                // kind+targetId+lang regardless, but this avoids the button
                // looking clickable while a job is already running.
                disabled={translatingId === article.id || !!liveProgress}
                onClick={() => void handleTranslate()}
              >
                <Languages size={14} />
                {translatingId === article.id || liveProgress
                  ? t("translate.translating")
                  : partialTranslation
                    ? t("translate.resume")
                    : t("translate.translate")}
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
              <button type="button" class="btn btn-ghost" onClick={() => setShowTranslated((v) => !v)}>
                <Languages size={14} />
                {showTranslated ? t("translate.showOriginal") : t("translate.showTranslated")}
              </button>
            ) : null}
            {showTranslated && cachedTranslation ? (
              <span class="badge">{t("translate.translatedBadge", { lang: LOCALE_LABELS[targetLang] })}</span>
            ) : null}
          </div>
          <div class="reader-modal-toolbar-actions">
            <a class="reader-modal-chat-link" href={chatUrl(chatRoomId)} target="_blank" rel="noopener">
              <MessagesSquare size={14} /> {t("common.openInChat")}
            </a>
            <button
              type="button"
              class={`icon-btn${busyAction === "room" ? " loading" : ""}`}
              title={t("articles.shareToRoom")}
              aria-label={t("articles.shareToRoom")}
              disabled={busyAction === "room"}
              onClick={() => void handleShareRoom()}
            >
              <Share2 size={15} />
            </button>
            <button
              type="button"
              class={`icon-btn${busyAction === "chat" ? " loading" : ""}`}
              title={t("articles.shareToChat")}
              aria-label={t("articles.shareToChat")}
              disabled={busyAction === "chat"}
              onClick={() => void handleShareChat()}
            >
              <MessageSquare size={15} />
            </button>
            <button
              type="button"
              class="icon-btn danger"
              title={t("common.delete")}
              aria-label={t("common.delete")}
              onClick={handleDelete}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {chatNotice ? (
          <div class="reader-modal-chat-notice">
            <span>{t("articles.sentToChat")}</span>
            <a href={chatUrl(chatRoomId)} target="_blank" rel="noopener">
              {t("articles.openInChatLink")}
            </a>
          </div>
        ) : null}
        {categoryNotice ? (
          <div class="reader-modal-chat-notice">
            <span>{categoryNotice}</span>
          </div>
        ) : null}
        {evalError ? <p class="reader-modal-eval-error">{evalError}</p> : null}
        {translateError ? <p class="reader-modal-eval-error">{translateError}</p> : null}
        {panelOpen && latestEval ? <EvaluationPanel record={latestEval} onClose={() => setPanelOpen(false)} /> : null}

        <div class="reader-modal-body">
          <ArticleReader article={displayArticle} />
        </div>
      </div>
    </div>
  );
}

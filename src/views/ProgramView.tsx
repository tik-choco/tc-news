// ProgramView ("スタジオ" / studio tab): pick your own articles, generate a
// radio-style narration script via LLM, render/download its audio, and
// share it to the P2P wire. Playback itself is no longer owned here — it
// runs through the app-global player (lib/playerStore) via usePlayer(), so
// starting a program from this view (or from a feed ProgramCard, or from
// the mini player's controls) is all the same playback, and it survives
// switching away from this tab instead of stopping on unmount. This view
// just reflects the store's state when the *selected* program happens to be
// the one playing; selecting a different program in the list no longer
// stops whatever's actually playing.
// Two-pane layout (list on the left: create + saved programs, plus a
// "everyone's programs" section for P2P-received ones; player/script pane on
// the right), mirroring ArticlesView's structural conventions. Own programs
// can be shared to the P2P wire (see App's onShareProgram) and any program —
// own or received — can collect emoji reactions via ReactionBar.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  Check,
  Download,
  Loader2,
  Mic,
  Pause,
  Play,
  Radio,
  Share2,
  Sparkles,
  StopCircle,
  Trash2,
  Volume2,
} from "lucide-preact";
import type { NewsArticle, ReactionKind, RadioProgram } from "../types";
import { EmptyState } from "../components/EmptyState";
import { ReactionBar } from "../components/ReactionBar";
import { formatRelativeTime } from "../components/ArticleCard";
import { LOCALE_LABELS, useLocale, useT } from "../lib/i18n";
import { mediaPreviewsEnabled } from "../lib/linkPreview";
import { addProgram, loadPrograms, removeProgram, upsertProgram } from "../lib/programStore";
import { subscribeKvHydrated } from "../lib/kvStore";
import { generateProgram } from "../lib/programGenerate";
import { parseRuby } from "../lib/ruby";
import { activeTtsEngine, isTtsSupported, listVoices, pickDefaultVoice } from "../lib/tts";
import { downloadProgramAudio, renderProgramAudio } from "../lib/programAudio";
import { OPENAI_TTS_VOICES, useVoiceOptions } from "../lib/voices";
import { emptyLlmConfig, loadLlmConfig, resolveVoice } from "../lib/llmConfig";
import { loadReactions, subscribeReactions } from "../lib/reactionStore";
import { computeDailyRanking, type RankingEntry } from "../lib/ranking";
import { enqueueJob, findPendingJob, isCancelError } from "../lib/jobQueue";
import { useJobQueue } from "../hooks/useJobQueue";
import { usePlayer } from "../hooks/usePlayer";
import { pausePlayer, playProgram, resumePlayer, stopPlayer } from "../lib/playerStore";
import "../styles/components.css";
import "../styles/reactions.css";
import "../styles/program.css";

type ShareState = "busy" | "done";

const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

// AIジョブキュー(lib/jobQueue)のdedupキー。選択記事idの集合から順序非依存の
// idを作る(FeedView.tsxのbuildTargetIdと同じ考え方)。
function buildTargetId(ids: string[]): string {
  return ids.slice().sort().join("+");
}

// 台本セグメントのテキスト表示: segment.ruby(マーカー入り文字列)があれば
// parseRuby()でトークン化し<ruby><rt>付きで描画、無ければ従来通り平文の
// segment.textをそのまま出す。dangerouslySetInnerHTMLは使わない。
function SegmentText(props: { text: string; ruby?: string }): JSX.Element {
  if (!props.ruby) return <>{props.text}</>;
  const tokens = parseRuby(props.ruby);
  return (
    <>
      {tokens.map((token, index) =>
        token.ruby ? (
          <ruby key={index}>
            {token.base}
            <rt>{token.ruby}</rt>
          </ruby>
        ) : (
          <span key={index}>{token.base}</span>
        ),
      )}
    </>
  );
}

// Program row thumbnail: same opt-in-and-drop-silently-on-failure idiom as
// ArticleCard's thumbnail (see components/ArticleCard.tsx), just without the
// OGP fallback — a program's imageUrl is already fully derived at generation
// time (see programGenerate.ts), so there's nothing to fetch here.
function ProgramRowThumb(props: { imageUrl: string; alt: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      class="program-row-thumb"
      src={props.imageUrl}
      alt={props.alt}
      loading="lazy"
      referrerpolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function ProgramView(props: {
  articles: NewsArticle[];
  myDid: string;
  /** Merged room+global received programs (App layer already dedups). */
  sharedPrograms: RadioProgram[];
  /** Shares + persists the given (own) program; resolves the stamped copy
   * (authorDid/authorName/shared set). Caller refreshes loadPrograms() after. */
  onShareProgram: (program: RadioProgram) => Promise<RadioProgram>;
  onReactToProgram: (programId: string, kind: ReactionKind) => Promise<void>;
  /** ランキング等からの深リンク: このidの番組(自分の/受信どちらでも)を選択する。 */
  deepLinkId?: string | null;
  /** 設定 programRuby — 台本生成時にルビ付与を指示する。 */
  rubyEnabled: boolean;
}): JSX.Element {
  const { articles, myDid, sharedPrograms, onShareProgram, onReactToProgram, deepLinkId, rubyEnabled } = props;
  const t = useT();
  const { locale } = useLocale();

  const [programs, setPrograms] = useState<RadioProgram[]>(() => loadPrograms());
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(() => loadPrograms()[0]?.id ?? null);

  // Tracks the last deepLinkId we've already reacted to, so re-renders caused
  // by fresh P2P program array identity churn (sharedPrograms) don't
  // repeatedly clobber a selection the user has since changed locally.
  // Mirrors SharedView's lastDeepLinkRef idiom. If the program hasn't
  // arrived yet, selectedProgram below just resolves once it does (it
  // already looks the id up across both programs and receivedPrograms).
  const lastDeepLinkRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (deepLinkId === lastDeepLinkRef.current) return;
    lastDeepLinkRef.current = deepLinkId ?? null;
    if (deepLinkId) setSelectedProgramId(deepLinkId);
  }, [deepLinkId]);

  // `programs`/`selectedProgramId` above were seeded from loadPrograms()
  // before the mist KV finished hydrating (lib/kvStore.ts) — pre-hydration
  // reads fall back to localStorage, which is empty once a previous session
  // migrated its data into the KV. Re-read once hydration replaces that
  // fallback; only default-select the first program if the user hasn't
  // already picked one (e.g. via deepLinkId) in the meantime.
  useEffect(
    () =>
      subscribeKvHydrated(() => {
        const hydrated = loadPrograms();
        setPrograms(hydrated);
        setSelectedProgramId((prev) => prev ?? hydrated[0]?.id ?? null);
      }),
    [],
  );

  const [selectedArticleIds, setSelectedArticleIds] = useState<Set<string>>(() => new Set());
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Sharing an own program to the P2P wire: keyed by program id so the
  // player header can flip busy -> done independently per program (mirrors
  // SharedView's showNotice 2s-timer pattern / ArticlesView's chat notice).
  const [shareState, setShareState] = useState<Record<string, ShareState | undefined>>({});
  const [shareErrors, setShareErrors] = useState<Record<string, string | undefined>>({});
  const shareTimers = useRef<Record<string, number | undefined>>({});

  // Rendering an own program's script to speech (see handleRenderAudio) —
  // keyed by program id like shareState/shareErrors above, so progress and
  // any failure are scoped to whichever program is being rendered.
  const [renderAudioState, setRenderAudioState] = useState<
    Record<string, { done: number; total: number } | undefined>
  >({});
  const [renderAudioErrors, setRenderAudioErrors] = useState<Record<string, string | undefined>>({});

  // Downloading a program's combined rendered audio (own or received) —
  // same per-id keying idiom.
  const [downloadState, setDownloadState] = useState<Record<string, "busy" | undefined>>({});
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string | undefined>>({});

  // 番組生成(kind: "program")・音声レンダリング(kind: "programAudio")は
  // グローバルAIジョブキューへ乗るので、このビューを離れて戻ってきても
  // (=上のローカルstateが失われても)実行中かどうかをここから導出する。
  const jobs = useJobQueue();
  const isPendingStatus = (status: (typeof jobs)[number]["status"]) =>
    status === "queued" || status === "running" || status === "cancelling";
  const generateJobPending = jobs.some((job) => job.kind === "program" && isPendingStatus(job.status));

  // Reactions live in localStorage (reactionStore), not props — bump on every
  // store write (any ReactionBar anywhere) to re-read it for the popular
  // programs section. Mirrors SharedView's reactionsTick pattern.
  const [reactionsTick, bumpReactionsTick] = useState(0);
  useEffect(() => subscribeReactions(() => bumpReactionsTick((n) => n + 1)), []);

  const ttsSupported = isTtsSupported();
  const engine = activeTtsEngine();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  // Loaded once — this view re-renders on every playback segment, so we don't
  // want to re-parse localStorage on each render just to read the TTS config.
  const [resolvedVoice] = useState(() => resolveVoice(loadLlmConfig() ?? emptyLlmConfig(), "tts"));
  // OpenAI engine only: the voice picker below defaults to whatever's saved
  // in settings ("alloy" if that's blank), overridable per-playback.
  const [openaiVoice, setOpenaiVoice] = useState(() => resolvedVoice?.voice || "alloy");
  // Fetches the endpoint's voice list only when the openai engine is active
  // (an empty baseUrl keeps the hook idle, so the browser engine never fetches).
  const openaiVoiceOptions = useVoiceOptions(
    engine === "openai" ? (resolvedVoice?.baseUrl ?? "") : "",
    resolvedVoice?.apiKey ?? "",
  );
  const [rate, setRate] = useState(1);
  const segmentRefs = useRef<Array<HTMLLIElement | null>>([]);

  // Programs shared by others — ones we authored ourselves are excluded even
  // if they round-tripped back to us over P2P, since those already live in
  // the own list above ("みんなの番組" is other people's programs only).
  const receivedPrograms = sharedPrograms.filter((p) => p.authorDid !== myDid);

  const selectedProgram =
    programs.find((p) => p.id === selectedProgramId) ??
    receivedPrograms.find((p) => p.id === selectedProgramId) ??
    null;
  const isOwnProgram = selectedProgram ? programs.some((p) => p.id === selectedProgram.id) : false;
  const hasAudio = (selectedProgram?.audioCids?.length ?? 0) > 0;

  // Playback lives in the app-global store now (lib/playerStore) — this
  // view only reflects it, and only when the *selected* program is the one
  // actually playing. Picking a different program in the list just changes
  // what this pane shows; it no longer touches whatever's playing.
  const player = usePlayer();
  const isSelectedPlaying = selectedProgram ? player.program?.id === selectedProgram.id : false;
  const playState = isSelectedPlaying ? player.playState : "idle";
  const currentIndex = isSelectedPlaying ? player.currentIndex : 0;
  const playbackError = isSelectedPlaying ? player.error : null;

  // --- Today's popular programs (daily reaction ranking, program targets only) ---

  // Own + received programs, own taking priority on id clashes (mirrors
  // ProgramView's own selectedProgram lookup order above).
  const popularProgramsById = useMemo(() => {
    const map = new Map<string, RadioProgram>();
    for (const p of [...programs, ...receivedPrograms]) {
      if (!map.has(p.id)) map.set(p.id, p);
    }
    return map;
  }, [programs, receivedPrograms]);

  interface PopularRow {
    entry: RankingEntry;
    program: RadioProgram;
  }

  // reactionsTick is an intentional dep — it's how this recomputes when a
  // reaction is sent anywhere (see the subscribeReactions effect above).
  const popularRows = useMemo<PopularRow[]>(() => {
    const entries = computeDailyRanking(loadReactions()).filter((e) => e.targetType === "program");
    const rows: PopularRow[] = [];
    for (const entry of entries) {
      const program = popularProgramsById.get(entry.targetId);
      if (!program) continue; // can't render a title/author for it — skip
      rows.push({ entry, program });
      if (rows.length >= 5) break;
    }
    return rows;
  }, [reactionsTick, popularProgramsById]);

  // Load the available system voices once (async on some browsers).
  useEffect(() => {
    if (!ttsSupported) return;
    let cancelled = false;
    listVoices().then((v) => {
      if (!cancelled) setVoices(v);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick a default voice whenever the selected program (or the voice list
  // itself, which may arrive after mount) changes.
  useEffect(() => {
    if (!selectedProgram) return;
    setSelectedVoice(pickDefaultVoice(voices, selectedProgram.lang ?? locale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProgram?.id, voices]);

  useEffect(() => {
    if (playState === "idle") return;
    const el = segmentRefs.current[currentIndex];
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentIndex, playState]);

  // Clear any pending share "done" timers on unmount.
  useEffect(() => {
    return () => {
      for (const timer of Object.values(shareTimers.current)) {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    };
  }, []);

  function toggleArticle(id: string) {
    setSelectedArticleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleGenerate() {
    if (selectedArticleIds.size === 0 || generating || generateJobPending) return;
    const selected = articles.filter((a) => selectedArticleIds.has(a.id));
    const targetId = buildTargetId(selected.map((a) => a.id));
    // 既に同じ選択の生成ジョブが進行中なら、ここで新しい呼び出し経路の
    // then/catch を重ねて付けない(= 二重の後処理を防ぐ)。
    if (findPendingJob("program", targetId)) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await enqueueJob(
        { kind: "program", targetId, label: selected[0]?.title || t("program.untitledProgram") },
        async (signal) => {
          const program = await generateProgram(selected, {
            profileId: "",
            language: LOCALE_LABELS[locale],
            locale,
            ruby: rubyEnabled,
          });
          // generateProgram自体はsignalを受け取れない単発呼び出しなので、
          // 解決した直後がキャンセルを反映できる最初のタイミング。
          if (signal.aborted) {
            const err = new Error("Request cancelled.");
            err.name = "AbortError";
            throw err;
          }
          return program;
        },
      );
      setPrograms(addProgram(result));
      setSelectedArticleIds(new Set());
      setSelectedProgramId(result.id);
    } catch (err) {
      // キャンセルはユーザー操作の結果であってエラーではないので表示しない。
      if (!isCancelError(err)) {
        const detail = err instanceof Error ? err.message : String(err);
        setGenerateError(t("program.generateFailed", { detail }));
      }
    } finally {
      setGenerating(false);
    }
  }

  function handleDeleteProgram(program: RadioProgram) {
    const title = program.title || t("program.untitledProgram");
    if (!window.confirm(t("program.deleteConfirm", { title }))) return;
    if (player.program?.id === program.id) {
      stopPlayer();
    }
    const next = removeProgram(program.id);
    setPrograms(next);
    if (selectedProgramId === program.id) {
      setSelectedProgramId(next[0]?.id ?? null);
    }
  }

  async function handleShareProgram(program: RadioProgram) {
    setShareState((prev) => ({ ...prev, [program.id]: "busy" }));
    setShareErrors((prev) => ({ ...prev, [program.id]: undefined }));
    try {
      await onShareProgram(program);
      // The app layer already persisted the stamped (shared:true) copy —
      // pick it back up from storage rather than guessing its shape here.
      setPrograms(loadPrograms());
      setShareState((prev) => ({ ...prev, [program.id]: "done" }));
      if (shareTimers.current[program.id] !== undefined) {
        window.clearTimeout(shareTimers.current[program.id]);
      }
      shareTimers.current[program.id] = window.setTimeout(() => {
        setShareState((prev) => ({ ...prev, [program.id]: undefined }));
      }, 2000);
    } catch (err) {
      setShareState((prev) => ({ ...prev, [program.id]: undefined }));
      setShareErrors((prev) => ({ ...prev, [program.id]: err instanceof Error ? err.message : String(err) }));
    }
  }

  // playerStore.playProgram() itself picks creator-rendered audio vs. live
  // TTS (based on program.audioCids) — this view just supplies the voice/
  // rate/openaiVoice choices from its own picker UI.
  function handlePlay() {
    if (!selectedProgram) return;
    void playProgram(selectedProgram, { voice: selectedVoice, openaiVoice, rate });
  }

  async function handleRenderAudio(program: RadioProgram) {
    if (!resolvedVoice || renderAudioState[program.id]) return;
    // 既に同じ番組の音声レンダリングジョブが進行中なら、ここで新しい呼び出し
    // 経路の then/catch を重ねて付けない(= 二重の後処理を防ぐ)。
    if (findPendingJob("programAudio", program.id)) return;
    const total = program.segments.length;
    setRenderAudioState((prev) => ({ ...prev, [program.id]: { done: 0, total } }));
    setRenderAudioErrors((prev) => ({ ...prev, [program.id]: undefined }));
    try {
      const { audioCids, audioMime } = await enqueueJob(
        { kind: "programAudio", targetId: program.id, label: program.title || t("program.untitledProgram") },
        (signal, report) =>
          renderProgramAudio(
            program.id,
            program.segments.map((s) => s.text),
            { ...resolvedVoice, voice: openaiVoice },
            {
              onProgress: (done, doneTotal) => {
                report(`${done}/${doneTotal}`);
                setRenderAudioState((prev) => ({ ...prev, [program.id]: { done, total: doneTotal } }));
              },
              signal,
            },
          ),
      );
      upsertProgram({ ...program, audioCids, audioMime, audioVoice: openaiVoice });
      setPrograms(loadPrograms());
    } catch (err) {
      // キャンセルはユーザー操作の結果であってエラーではないので表示しない。
      if (!isCancelError(err)) {
        setRenderAudioErrors((prev) => ({ ...prev, [program.id]: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      setRenderAudioState((prev) => ({ ...prev, [program.id]: undefined }));
    }
  }

  async function handleDownloadAudio(program: RadioProgram) {
    if (!program.audioCids || program.audioCids.length === 0 || downloadState[program.id] === "busy") return;
    setDownloadState((prev) => ({ ...prev, [program.id]: "busy" }));
    setDownloadErrors((prev) => ({ ...prev, [program.id]: undefined }));
    try {
      await downloadProgramAudio(
        { cids: program.audioCids, mime: program.audioMime ?? "audio/mpeg" },
        program.title,
        t("program.untitledProgram"),
      );
    } catch (err) {
      setDownloadErrors((prev) => ({ ...prev, [program.id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setDownloadState((prev) => ({ ...prev, [program.id]: undefined }));
    }
  }

  function handlePauseResume() {
    if (!isSelectedPlaying) return;
    if (playState === "playing") pausePlayer();
    else if (playState === "paused") resumePlayer();
  }

  function handleStop() {
    stopPlayer();
  }

  // Fetched voices when available, else the standard OpenAI set — always
  // merged with the current selection so a custom voice from settings stays
  // selectable even if the endpoint's list (or the fallback) doesn't include it.
  const openaiVoiceSelectOptions = Array.from(
    new Set(
      [
        ...(openaiVoiceOptions.status === "done" && openaiVoiceOptions.options.length > 0
          ? openaiVoiceOptions.options
          : OPENAI_TTS_VOICES),
        ...(openaiVoice ? [openaiVoice] : []),
      ],
    ),
  ).sort((a, b) => a.localeCompare(b));

  const renderProgress = selectedProgram ? renderAudioState[selectedProgram.id] : undefined;
  // ローカルのrenderAudioStateに加えて、キューに残っている"programAudio"
  // ジョブの有無もOR判定に入れる — このビューを離れて戻ってきた直後は
  // renderAudioStateがリセットされているが、ジョブ自体はまだ動いているので
  // ここで拾う。
  const renderAudioJobPending = selectedProgram
    ? findPendingJob("programAudio", selectedProgram.id) !== null
    : false;

  return (
    <div class="program-view">
      <div class="program-list-pane">
        <section class="program-create">
          <h2 class="program-section-heading">{t("program.createHeading")}</h2>
          <p class="program-section-hint">{t("program.createHint")}</p>
          {articles.length === 0 ? (
            <p class="program-articles-empty">{t("program.articlesEmpty")}</p>
          ) : (
            <>
              <ul class="program-article-picklist">
                {articles.map((article) => (
                  <li key={article.id}>
                    <label class="checkbox-field program-article-option">
                      <input
                        type="checkbox"
                        checked={selectedArticleIds.has(article.id)}
                        onChange={() => toggleArticle(article.id)}
                      />
                      <span class="program-article-option-text">
                        <span class="program-article-option-title">
                          {article.title || t("articles.untitledArticle")}
                        </span>
                        <span class="program-article-option-time">
                          {formatRelativeTime(article.createdAt, locale)}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div class="program-generate-row">
                <span class="program-selected-count">
                  {t("program.selectedCount", { count: selectedArticleIds.size })}
                </span>
                <button
                  type="button"
                  class="btn btn-primary"
                  disabled={selectedArticleIds.size === 0 || generating || generateJobPending}
                  onClick={() => void handleGenerate()}
                >
                  {generating ? <Loader2 size={15} class="spin" /> : <Sparkles size={15} />}
                  {generating ? t("program.generating") : t("program.generateButton")}
                </button>
              </div>
              {generateError ? <p class="program-generate-error">{generateError}</p> : null}
            </>
          )}
        </section>

        <section class="program-popular">
          <h2 class="program-section-heading">{t("program.popularHeading")}</h2>
          {popularRows.length === 0 ? (
            <p class="program-shared-empty">{t("program.popularEmpty")}</p>
          ) : (
            <ul class="ranking-list">
              {popularRows.map((row, index) => {
                const rank = index + 1;
                const rankClass = rank <= 3 ? ` ranking-rank--${rank}` : "";
                return (
                  <li key={row.program.id}>
                    <button
                      type="button"
                      class="ranking-row"
                      onClick={() => setSelectedProgramId(row.program.id)}
                    >
                      <span class={`ranking-rank${rankClass}`}>{rank}</span>
                      <span class="ranking-row-main">
                        <span class="ranking-row-title">{row.program.title || t("program.untitledProgram")}</span>
                        <span class="ranking-row-meta">
                          <span>{row.program.authorName || t("common.anonymous")}</span>
                        </span>
                      </span>
                      <span class="ranking-row-side">{t("shared.rankingReactions", { count: row.entry.count })}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section class="program-saved">
          <h2 class="program-section-heading">{t("program.listHeading")}</h2>
          {programs.length === 0 ? (
            <EmptyState icon={Radio} title={t("program.emptyTitle")} description={t("program.emptyDescription")} />
          ) : (
            <ul class="program-list">
              {programs.map((program) => (
                <li key={program.id}>
                  <div
                    class={`program-row${program.id === selectedProgramId ? " program-row--active" : ""}`}
                    onClick={() => setSelectedProgramId(program.id)}
                  >
                    {program.imageUrl && mediaPreviewsEnabled() ? (
                      <ProgramRowThumb
                        imageUrl={program.imageUrl}
                        alt={program.title || t("program.untitledProgram")}
                      />
                    ) : null}
                    <div class="program-row-text">
                      <span class="program-row-title">{program.title || t("program.untitledProgram")}</span>
                      <span class="program-row-meta">
                        {formatRelativeTime(program.createdAt, locale)}
                        <span class="program-row-dot" aria-hidden="true">
                          ・
                        </span>
                        {t("program.segmentCount", { count: program.segments.length })}
                        {program.shared ? (
                          <span class="badge badge--shared program-row-badge">{t("articles.sharedBadge")}</span>
                        ) : null}
                        {(program.audioCids?.length ?? 0) > 0 ? (
                          <span class="badge program-audio-badge program-row-badge">
                            <Volume2 size={11} /> {t("program.audioBadge")}
                          </span>
                        ) : null}
                      </span>
                      <div class="program-row-reactions">
                        <ReactionBar targetId={program.id} myDid={myDid} compact />
                      </div>
                    </div>
                    <button
                      type="button"
                      class="icon-btn danger"
                      title={t("program.deleteProgramAria")}
                      aria-label={t("program.deleteProgramAria")}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteProgram(program);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="program-shared">
          <h2 class="program-section-heading">{t("program.sharedProgramsHeading")}</h2>
          {receivedPrograms.length === 0 ? (
            <p class="program-shared-empty">{t("program.sharedProgramsEmpty")}</p>
          ) : (
            <ul class="program-list">
              {receivedPrograms.map((program) => (
                <li key={program.id}>
                  <div
                    class={`program-row program-row--shared${
                      program.id === selectedProgramId ? " program-row--active" : ""
                    }`}
                    onClick={() => setSelectedProgramId(program.id)}
                  >
                    {program.imageUrl && mediaPreviewsEnabled() ? (
                      <ProgramRowThumb
                        imageUrl={program.imageUrl}
                        alt={program.title || t("program.untitledProgram")}
                      />
                    ) : null}
                    <div class="program-row-text">
                      <span class="program-row-title">{program.title || t("program.untitledProgram")}</span>
                      <span class="program-row-meta">
                        <span class="program-row-author">{program.authorName || t("common.anonymous")}</span>
                        <span class="program-row-dot" aria-hidden="true">
                          ・
                        </span>
                        {formatRelativeTime(program.createdAt, locale)}
                        {(program.audioCids?.length ?? 0) > 0 ? (
                          <span class="badge program-audio-badge program-row-badge">
                            <Volume2 size={11} /> {t("program.audioBadge")}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div class="program-player-pane">
        {selectedProgram ? (
          <div class="program-player">
            <div class="program-player-header">
              <h2 class="program-player-title">{selectedProgram.title || t("program.untitledProgram")}</h2>
              <div class="program-player-header-actions">
                {selectedProgram.shared ? (
                  <span class="badge badge--shared">{t("articles.sharedBadge")}</span>
                ) : null}
                {hasAudio ? (
                  <span class="badge program-audio-badge">
                    <Volume2 size={12} /> {t("program.audioBadge")}
                  </span>
                ) : null}
                {isOwnProgram && engine === "openai" && !hasAudio ? (
                  <button
                    type="button"
                    class="btn btn-ghost"
                    disabled={renderProgress !== undefined || renderAudioJobPending}
                    onClick={() => void handleRenderAudio(selectedProgram)}
                  >
                    {renderProgress || renderAudioJobPending ? <Loader2 size={14} class="spin" /> : <Mic size={14} />}
                    {renderProgress
                      ? t("program.renderingAudio", { done: renderProgress.done, total: renderProgress.total })
                      : renderAudioJobPending
                        ? t("translate.statusRenderingAudio")
                        : t("program.renderAudio")}
                  </button>
                ) : null}
                {hasAudio ? (
                  <button
                    type="button"
                    class="btn btn-ghost"
                    disabled={downloadState[selectedProgram.id] === "busy"}
                    onClick={() => void handleDownloadAudio(selectedProgram)}
                  >
                    {downloadState[selectedProgram.id] === "busy" ? (
                      <Loader2 size={14} class="spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    {downloadState[selectedProgram.id] === "busy"
                      ? t("program.downloadPreparing")
                      : t("program.downloadAudio")}
                  </button>
                ) : null}
                {isOwnProgram ? (
                  <button
                    type="button"
                    class="btn btn-ghost"
                    disabled={shareState[selectedProgram.id] === "busy"}
                    onClick={() => void handleShareProgram(selectedProgram)}
                  >
                    {shareState[selectedProgram.id] === "busy" ? (
                      <Loader2 size={14} class="spin" />
                    ) : shareState[selectedProgram.id] === "done" ? (
                      <Check size={14} />
                    ) : (
                      <Share2 size={14} />
                    )}
                    {shareState[selectedProgram.id] === "done" ? t("program.shareDone") : t("program.shareProgram")}
                  </button>
                ) : null}
              </div>
              {!isOwnProgram ? (
                <p class="program-player-subtitle">
                  {(selectedProgram.authorName || t("common.anonymous")) +
                    " ・ " +
                    formatRelativeTime(selectedProgram.createdAt, locale)}
                </p>
              ) : null}
            </div>
            {isOwnProgram && shareErrors[selectedProgram.id] ? (
              <p class="program-generate-error">{shareErrors[selectedProgram.id]}</p>
            ) : null}
            {isOwnProgram && renderAudioErrors[selectedProgram.id] ? (
              <p class="program-generate-error">{renderAudioErrors[selectedProgram.id]}</p>
            ) : null}
            {downloadErrors[selectedProgram.id] ? (
              <p class="program-generate-error">{downloadErrors[selectedProgram.id]}</p>
            ) : null}
            {isOwnProgram && engine === "openai" && !selectedProgram.shared && !hasAudio ? (
              <p class="program-section-hint">{t("program.renderAudioHint")}</p>
            ) : null}

            <div class="program-player-reactions">
              {isOwnProgram ? (
                <ReactionBar targetId={selectedProgram.id} myDid={myDid} />
              ) : (
                <ReactionBar
                  targetId={selectedProgram.id}
                  myDid={myDid}
                  onReact={(kind) => onReactToProgram(selectedProgram.id, kind)}
                />
              )}
            </div>

            {!hasAudio && !ttsSupported ? (
              <p class="program-tts-unsupported">{t("program.ttsUnsupported")}</p>
            ) : null}
            {playbackError ? <p class="program-generate-error">{playbackError}</p> : null}

            {hasAudio || ttsSupported ? (
              <>
                <div class="program-controls">
                  {playState === "idle" ? (
                    <button type="button" class="btn btn-primary" onClick={handlePlay}>
                      <Play size={15} /> {t("program.play")}
                    </button>
                  ) : (
                    <button type="button" class="btn" onClick={handlePauseResume}>
                      <Pause size={15} /> {playState === "playing" ? t("program.pause") : t("program.resume")}
                    </button>
                  )}
                  <button type="button" class="btn" disabled={playState === "idle"} onClick={handleStop}>
                    <StopCircle size={15} /> {t("program.stop")}
                  </button>
                  {playState !== "idle" ? (
                    <span class="program-progress">
                      {t("program.segmentProgress", {
                        current: currentIndex + 1,
                        total: selectedProgram.segments.length,
                      })}
                    </span>
                  ) : null}
                </div>

                <div class="program-settings-row">
                  {!hasAudio && engine === "browser" ? (
                    <label class="field program-voice-field">
                      <span>{t("program.voice")}</span>
                      <select
                        disabled={playState === "playing"}
                        value={selectedVoice ? `${selectedVoice.name}::${selectedVoice.lang}` : ""}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          const found = voices.find((v) => `${v.name}::${v.lang}` === value) ?? null;
                          setSelectedVoice(found);
                        }}
                      >
                        {voices.map((v) => (
                          <option key={`${v.name}::${v.lang}`} value={`${v.name}::${v.lang}`}>
                            {v.name} ({v.lang})
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {!hasAudio && engine === "openai" ? (
                    <label class="field program-voice-field">
                      <span>{t("program.voice")}</span>
                      <select
                        disabled={playState === "playing"}
                        value={openaiVoice}
                        onChange={(e) => setOpenaiVoice(e.currentTarget.value)}
                      >
                        {openaiVoiceSelectOptions.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label class="field program-rate-field">
                    <span>{t("program.rate")}</span>
                    <select value={String(rate)} onChange={(e) => setRate(Number(e.currentTarget.value))}>
                      {RATE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r}x
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {!hasAudio && engine === "openai" ? (
                  <p class="program-section-hint">{t("program.ttsEngineOpenAi")}</p>
                ) : null}
              </>
            ) : null}

            <ul class="program-script">
              {selectedProgram.segments.map((segment, index) => (
                <li
                  key={index}
                  ref={(el) => {
                    segmentRefs.current[index] = el;
                  }}
                  class={`program-segment${playState !== "idle" && index === currentIndex ? " program-segment--active" : ""}`}
                >
                  <SegmentText text={segment.text} ruby={segment.ruby} />
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState icon={Radio} title={t("program.emptyTitle")} description={t("program.emptyDescription")} />
        )}
      </div>
    </div>
  );
}

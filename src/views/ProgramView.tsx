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
  Languages,
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
import { LanguagePicker } from "../components/LanguagePicker";
import { formatRelativeTime } from "../components/ArticleCard";
import { LOCALE_LABELS, useLocale, useT, type Locale } from "../lib/i18n";
import { mediaPreviewsEnabled } from "../lib/linkPreview";
import { addProgram, loadPrograms, removeProgram, upsertProgram } from "../lib/programStore";
import { subscribeKvHydrated } from "../lib/kvStore";
import { generateProgram } from "../lib/programGenerate";
import { translateProgram } from "../lib/programTranslate";
import {
  getProgramTranslation,
  saveProgramTranslation,
  subscribeProgramTranslations,
} from "../lib/programTranslationStore";
import { clearTranslationProgress, publishTranslationProgress } from "../lib/translationProgress";
import { useTranslationProgress } from "../hooks/useTranslationProgress";
import { parseRuby } from "../lib/ruby";
import { activeTtsEngine, isTtsSupported, listVoices, pickDefaultVoice } from "../lib/tts";
import { downloadProgramAudio, renderProgramAudio } from "../lib/programAudio";
import { OPENAI_TTS_VOICES, useVoiceOptions } from "../lib/voices";
import { emptyLlmConfig, loadLlmConfig, resolveVoice } from "../lib/llmConfig";
import { loadReactions, subscribeReactions } from "../lib/reactionStore";
import { loadViews, subscribeViews } from "../lib/viewStore";
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
  /** Shares one program-translation (text, plus rendered audio if any) into
   * the room(s) — used to contribute a translation for an already-shared
   * program (see handleTranslateProgram/handleRenderTranslatedAudio below). */
  onShareProgramTranslation: (
    programId: string,
    lang: Locale,
    content: { title: string; segmentTexts: string[]; audioCids?: string[]; audioMime?: string; audioVoice?: string },
  ) => Promise<void>;
  onReactToProgram: (programId: string, kind: ReactionKind) => Promise<void>;
  /** 番組を開いた(選択した)ことを閲覧数として記録する。onReactToProgramと同じく
   * room/global両方へ送る(呼び出し側でハンドリング)。 */
  onViewProgram: (programId: string) => Promise<void>;
  /** ランキング等からの深リンク: このidの番組(自分の/受信どちらでも)を選択する。 */
  deepLinkId?: string | null;
  /** 設定 programRuby — 台本生成時にルビ付与を指示する。 */
  rubyEnabled: boolean;
}): JSX.Element {
  const {
    articles,
    myDid,
    sharedPrograms,
    onShareProgram,
    onShareProgramTranslation,
    onReactToProgram,
    onViewProgram,
    deepLinkId,
    rubyEnabled,
  } = props;
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
  // Views live in localStorage (viewStore), not props — same bump-on-write
  // idiom as reactionsTick, so the popular-programs ranking re-reads it
  // whenever a view is recorded anywhere.
  const [viewsTick, bumpViewsTick] = useState(0);
  useEffect(() => subscribeViews(() => bumpViewsTick((n) => n + 1)), []);

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

  // Opening a program (selecting it in the list) counts as a view. onViewProgram
  // dedupes at the wire layer (viewStore.hasViewed via useNewsRoom's sendView) so
  // re-selecting the same program repeatedly is a harmless no-op.
  useEffect(() => {
    if (!selectedProgram) return;
    void onViewProgram(selectedProgram.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProgram?.id]);

  // --- Script translation (lib/programTranslate.ts) ---------------------
  // Preview of the selected program's script (title + segment text) in
  // another language — same rationale as feedTranslate.ts: a per-viewer
  // convenience so the same program×lang pair doesn't re-run the LLM every
  // time the script pane re-renders. It's no longer *never* shared over P2P
  // though (see programTranslationStore.ts's module header): once finished,
  // a translation of an already-shared program is contributed to the room
  // over the dedicated tc-news:program-translation wire so other viewers
  // don't each have to re-translate the same program independently — it
  // just never rides the tc-news:program wire itself (that wire serializes
  // the whole untranslated RadioProgram). Once a translation is fully
  // cached, playback follows the on-screen script too: rendered
  // translated audio (if the viewer made one, see handleRenderTranslatedAudio
  // below) plays if present, else live TTS speaks the translated text in a
  // target-language voice — see displayProgram below. Only while a
  // translation is still streaming (no cached result yet) does audio keep
  // playing the original, since there's no complete translated text/audio to
  // switch to.
  //
  // targetLang defaults to the current UI locale and resets (along with the
  // toggle/error below) whenever the selected program changes — mirrors
  // ArticleReaderModal's article.id effect.
  const [targetLang, setTargetLang] = useState<Locale>(locale);
  const [showTranslated, setShowTranslated] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  // Lets a translation job's continuation (below) tell whether the user has
  // since selected a different program before it touches showTranslated —
  // same guard idiom as ArticleReaderModal's articleIdRef.
  const selectedProgramIdRef = useRef<string | null>(null);
  selectedProgramIdRef.current = selectedProgramId;

  useEffect(() => {
    setTargetLang(locale);
    setShowTranslated(false);
    setTranslateError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProgram?.id]);

  // cachedProgramTranslation below is read fresh on every render rather than
  // held in state, so a translation that lands in the store *without* one of
  // this view's own setState calls — i.e. hydrated from a P2P
  // tc-news:program-translation wire while this view is open, or an audio
  // upgrade saved by another tab — wouldn't otherwise trigger a re-render.
  // Bump a counter on every store write (local or wire-hydrated) so the view
  // re-reads it.
  const [, bumpTranslationVersion] = useState(0);
  useEffect(() => subscribeProgramTranslations(() => bumpTranslationVersion((v) => v + 1)), []);

  // Not stateful — re-read on every render, same idiom as
  // ArticleReaderModal's cachedTranslation.
  const cachedProgramTranslation = selectedProgram ? getProgramTranslation(selectedProgram.id, targetLang) : null;
  // Live streaming progress for this program×targetLang, regardless of which
  // surface started the translation job (lib/translationProgress is a module
  // singleton keyed by targetId×lang, not by job origin). targetId falls
  // back to "" when nothing is selected so the hook is still called
  // unconditionally on every render (Rules of Hooks).
  const liveProgramProgress = useTranslationProgress("program", selectedProgram?.id ?? "", targetLang);
  // The live progress's per-segment translations are carried through
  // TranslationProgress.body as a JSON-encoded string array — that field is
  // an opaque per-kind payload (article/feed use it for Markdown/HTML text),
  // and a program's progress is naturally an array of segment strings rather
  // than one blob of prose, so JSON-encoding it here is simpler than
  // shoehorning segments into a joined-text convention. Defensively parsed:
  // an unexpected shape just falls back to showing original segments.
  let liveProgramSegmentTexts: string[] | null = null;
  if (liveProgramProgress) {
    try {
      const parsed: unknown = JSON.parse(liveProgramProgress.body || "[]");
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        liveProgramSegmentTexts = parsed as string[];
      }
    } catch {
      liveProgramSegmentTexts = null;
    }
  }
  // A program without a recorded generation-time locale (lang) can't be
  // compared against targetLang, so the translate affordance stays available
  // rather than guessing — mirrors the "targetLang===program.lang" hide rule
  // for the common (lang known) case.
  const programNeedsTranslation = selectedProgram ? !selectedProgram.lang || selectedProgram.lang !== targetLang : false;
  const translateJobPending = selectedProgram
    ? findPendingJob("programTranslate", selectedProgram.id, targetLang) !== null
    : false;
  // True while the script pane should render translated (not original) text:
  // either a finished cached translation the user has toggled on, or a
  // still-streaming job with no cached result yet to fall back to.
  const showingCachedProgramTranslation = showTranslated && !!cachedProgramTranslation;
  const showingLiveProgramTranslation = !!liveProgramProgress && !cachedProgramTranslation;

  // Synthesized "translated variant" of the selected program, used for
  // playback/rendering/downloading/audio-badge decisions below — id is kept
  // identical to selectedProgram.id so the player's "is this program
  // playing" check (player.program?.id === selectedProgram.id) and segment
  // highlighting keep working unchanged whichever variant is on screen.
  // ruby carries no meaning for translated text (see programTranslate.ts's
  // module header) so it's dropped. Only built once a translation is fully
  // cached (showingCachedProgramTranslation) — a still-streaming live
  // translation has no complete segmentTexts/audio to synthesize from yet,
  // so audio keeps playing the original script until the translation
  // finishes and gets cached, same as before this feature.
  const displayProgram: RadioProgram | null =
    selectedProgram && showingCachedProgramTranslation && cachedProgramTranslation
      ? {
          ...selectedProgram,
          title: cachedProgramTranslation.title,
          segments: selectedProgram.segments.map((s, index) => ({
            articleId: s.articleId,
            text: cachedProgramTranslation.segmentTexts[index] ?? s.text,
          })),
          lang: targetLang,
          audioCids: cachedProgramTranslation.audioCids,
          audioMime: cachedProgramTranslation.audioMime,
          audioVoice: cachedProgramTranslation.audioVoice,
        }
      : selectedProgram;
  // Every hasAudio-derived bit of UI below (badge, render/download buttons,
  // TTS-unsupported note) reflects whichever variant is currently on
  // screen: if the original has rendered audio but the translated variant
  // doesn't (yet), showing the translated script should offer "render
  // audio" rather than claim audio is already available.
  const hasAudio = (displayProgram?.audioCids?.length ?? 0) > 0;

  const programTitleDisplay =
    showTranslated && cachedProgramTranslation
      ? cachedProgramTranslation.title
      : liveProgramProgress && !cachedProgramTranslation
        ? (liveProgramProgress.title ?? selectedProgram?.title ?? "")
        : (selectedProgram?.title ?? "");

  // Same length/order as selectedProgram.segments; ruby is only ever carried
  // for the original-language display (see programTranslate.ts's module
  // header — translated text has no ruby annotations of its own).
  const programSegmentsDisplay: { text: string; ruby?: string }[] = (selectedProgram?.segments ?? []).map(
    (segment, index) => {
      if (showingCachedProgramTranslation) {
        return { text: cachedProgramTranslation?.segmentTexts[index] ?? segment.text };
      }
      if (showingLiveProgramTranslation && liveProgramSegmentTexts && index < liveProgramSegmentTexts.length) {
        return { text: liveProgramSegmentTexts[index] };
      }
      return { text: segment.text, ruby: segment.ruby };
    },
  );

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

  // reactionsTick/viewsTick are intentional deps — they're how this
  // recomputes when a reaction or view is recorded anywhere (see the
  // subscribeReactions/subscribeViews effects above).
  const popularRows = useMemo<PopularRow[]>(() => {
    const entries = computeDailyRanking(loadReactions(), loadViews()).filter((e) => e.targetType === "program");
    const rows: PopularRow[] = [];
    for (const entry of entries) {
      const program = popularProgramsById.get(entry.targetId);
      if (!program) continue; // can't render a title/author for it — skip
      rows.push({ entry, program });
      if (rows.length >= 5) break;
    }
    return rows;
  }, [reactionsTick, viewsTick, popularProgramsById]);

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

  // Translates the selected program's script into `lang` and caches the
  // result locally (lib/programTranslationStore). Runs through the global AI
  // job queue like generate/programAudio above, so it survives navigating
  // away from this tab. `lang` is captured as a plain parameter (the caller
  // passes the current targetLang state at click time) rather than read from
  // component state inside the job closure — the closure must keep
  // translating into the language the user asked for even if they flip the
  // LanguagePicker again before the job finishes.
  async function handleTranslateProgram(program: RadioProgram, lang: Locale) {
    // 既に同じ番組×言語の翻訳ジョブが進行中なら、ここで新しい呼び出し経路の
    // then/catch を重ねて付けない(= 二重の後処理を防ぐ)。キュー自体も
    // kind+targetId+lang でdedupするが、これは早期returnで無駄なenqueue
    // 呼び出し自体を避けるためのもの(handleRenderAudio/handleGenerateと同じ)。
    if (findPendingJob("programTranslate", program.id, lang)) return;
    setTranslateError(null);
    try {
      await enqueueJob(
        { kind: "programTranslate", targetId: program.id, label: program.title || t("program.untitledProgram"), lang },
        async (signal, report) => {
          try {
            const content = await translateProgram(program, {
              profileId: "",
              targetLanguage: LOCALE_LABELS[lang],
              signal,
              onProgress: (p) => {
                publishTranslationProgress({
                  kind: "program",
                  targetId: program.id,
                  lang,
                  title: p.title,
                  subtitle: null,
                  body: JSON.stringify(p.segmentTexts),
                  doneChunks: p.doneSegments,
                  totalChunks: p.totalSegments,
                });
                if (p.totalSegments > 0) report(`${p.doneSegments}/${p.totalSegments}`);
              },
            });
            // translateProgram checks the signal between segment calls, but a
            // cancellation landing while the *final* segment call is in
            // flight still resolves normally — catch that here so a
            // cancelled job doesn't go on to cache its (unwanted) result.
            // Mirrors app.tsx's handleTranslateOwnArticle.
            if (signal.aborted) {
              const err = new Error("Request cancelled.");
              err.name = "AbortError";
              throw err;
            }
            saveProgramTranslation({
              programId: program.id,
              lang,
              title: content.title,
              segmentTexts: content.segmentTexts,
              translatedAt: Date.now(),
            });
            // Mirrors app.tsx's handleTranslateSharedArticle: any viewer of
            // an already-shared program may contribute a translation to the
            // room, so the next viewer doesn't have to re-pay the LLM for the
            // same program×lang. Fire-and-forget — a share failure must
            // never fail (or roll back) the translation job itself, since
            // the translation is already safely cached locally above.
            if (program.shared) {
              onShareProgramTranslation(program.id, lang, {
                title: content.title,
                segmentTexts: content.segmentTexts,
              }).catch((err) => {
                console.warn("tc-news: failed to share program translation", err);
              });
            }
          } finally {
            // The job (and its onProgress emits) can outlive this view being
            // scrolled away from — always drop the live-progress entry on
            // settle (success, failure, or cancel) so readers fall back to
            // programTranslationStore instead of a stale in-memory snapshot.
            clearTranslationProgress("program", program.id, lang);
          }
        },
      );
      // Only flip the toggle if the user is still looking at this program —
      // they may have selected a different one while the job was running.
      if (selectedProgramIdRef.current === program.id) setShowTranslated(true);
    } catch (err) {
      // キャンセルはユーザー操作の結果であってエラーではないので表示しない。
      if (selectedProgramIdRef.current === program.id && !isCancelError(err)) {
        setTranslateError(err instanceof Error ? err.message : String(err));
      }
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
  // rate/openaiVoice choices from its own picker UI. Plays displayProgram
  // (the translated variant while one's on screen, else the original as-is)
  // rather than selectedProgram directly, so translated script pane and
  // translated audio always agree.
  function handlePlay() {
    if (!displayProgram) return;
    // selectedVoice was picked to match the *original* program's language
    // (see the pickDefaultVoice effect above, keyed off selectedProgram.lang).
    // While showing a translated variant that voice is wrong for the target
    // language, so pass voice: undefined instead — playProgram (lib/
    // playerStore.ts) resolves that itself via pickDefaultVoice(voices,
    // displayProgram.lang), and displayProgram.lang is set to targetLang
    // above, so it lands on a voice for the translated language
    // automatically. openaiVoice/rate stay as picked: OpenAI voice ids name
    // a voice, not a language, and the rate is a playback-speed preference
    // independent of language either way.
    const voice = showingCachedProgramTranslation ? undefined : selectedVoice;
    void playProgram(displayProgram, { voice, openaiVoice, rate });
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

  // Renders audio for the *translated* script (lang-scoped — see
  // programTranslationStore.ts's module header). Mirrors handleRenderAudio
  // above but: (1) doesn't require isOwnProgram — rendering a translation's
  // audio is a per-viewer convenience usable for a received program just as
  // much as one's own (only *sharing* it back, below, needs program.shared);
  // (2) state/errors are keyed by `${program.id}::${lang}` rather than
  // program.id alone, so a translated render never clobbers (or gets
  // clobbered by) an in-flight/completed original-language render for the
  // same program; (3) the storage id passed to renderProgramAudio is
  // `${program.id}.${lang}` for the same reason (distinct object keys per
  // language); (4) the result is saved into programTranslationStore via
  // saveProgramTranslation, never onto the program itself — upsertProgram is
  // intentionally never called here, since a RadioProgram's audioCids ride
  // the tc-news:program P2P wire whole-JSON, and translated audio must never
  // leak out that way. It can still reach peers, just over the dedicated
  // tc-news:program-translation wire instead (see the share call below).
  //
  // `lang` is captured as a plain parameter at click time (like
  // handleTranslateProgram above) rather than re-read from targetLang state
  // inside the async closure, so flipping the LanguagePicker mid-render
  // doesn't redirect an in-flight render to the wrong language's cache slot.
  async function handleRenderTranslatedAudio(program: RadioProgram, lang: Locale) {
    const tr = getProgramTranslation(program.id, lang);
    if (!tr || !resolvedVoice) return;
    const key = `${program.id}::${lang}`;
    if (renderAudioState[key]) return;
    // 既に同じ番組×言語の音声レンダリングジョブが進行中なら、ここで新しい
    // 呼び出し経路の then/catch を重ねて付けない(= 二重の後処理を防ぐ)。
    // findPendingJob へ lang を渡すことで、原文用ジョブ(lang省略 = ""扱い)
    // とは別のdedupバケットになる — 互いのガードが誤って干渉しない。
    if (findPendingJob("programAudio", program.id, lang)) return;
    const total = tr.segmentTexts.length;
    setRenderAudioState((prev) => ({ ...prev, [key]: { done: 0, total } }));
    setRenderAudioErrors((prev) => ({ ...prev, [key]: undefined }));
    try {
      const { audioCids, audioMime } = await enqueueJob(
        {
          kind: "programAudio",
          targetId: program.id,
          label: tr.title || program.title || t("program.untitledProgram"),
          lang,
        },
        (signal, report) =>
          renderProgramAudio(
            `${program.id}.${lang}`,
            tr.segmentTexts,
            { ...resolvedVoice, voice: openaiVoice },
            {
              onProgress: (done, doneTotal) => {
                report(`${done}/${doneTotal}`);
                setRenderAudioState((prev) => ({ ...prev, [key]: { done, total: doneTotal } }));
              },
              signal,
            },
          ),
      );
      // 保存直前に最新の翻訳レコードを再読みしてから上書きする — このジョブが
      // 走っている間に(再翻訳などで)別の保存が挟まっていた場合に、その内容を
      // 消さないため(handleTranslateProgramの再翻訳と競合した場合の保険)。
      const latest = getProgramTranslation(program.id, lang) ?? tr;
      saveProgramTranslation({ ...latest, audioCids, audioMime, audioVoice: openaiVoice });
      // "Audio upgrade" re-share: if the program is shared, ship the full
      // record (text + the audio we just rendered) so peers' hydrate logic
      // can upgrade an existing text-only translation with audio instead of
      // everyone rendering their own copy. Fire-and-forget, same rationale
      // as handleTranslateProgram above — must never fail/undo the render,
      // which already succeeded and is safely cached locally.
      if (program.shared) {
        onShareProgramTranslation(program.id, lang, {
          title: latest.title,
          segmentTexts: latest.segmentTexts,
          audioCids,
          audioMime,
          audioVoice: openaiVoice,
        }).catch((err) => {
          console.warn("tc-news: failed to share program translation audio", err);
        });
      }
    } catch (err) {
      // キャンセルはユーザー操作の結果であってエラーではないので表示しない。
      if (!isCancelError(err)) {
        setRenderAudioErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      setRenderAudioState((prev) => ({ ...prev, [key]: undefined }));
    }
  }

  // Downloads whichever audio is currently displayed (translated variant's
  // rendered audio while one's on screen, else the original's) — caller
  // supplies the cids/mime/title/key already resolved from displayProgram
  // downstream (see downloadKey below), so this stays agnostic of which
  // variant it's downloading.
  async function handleDownloadAudio(key: string, cids: string[], mime: string | undefined, title: string) {
    if (cids.length === 0 || downloadState[key] === "busy") return;
    setDownloadState((prev) => ({ ...prev, [key]: "busy" }));
    setDownloadErrors((prev) => ({ ...prev, [key]: undefined }));
    try {
      await downloadProgramAudio({ cids, mime: mime ?? "audio/mpeg" }, title, t("program.untitledProgram"));
    } catch (err) {
      setDownloadErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setDownloadState((prev) => ({ ...prev, [key]: undefined }));
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

  // 「音声を作成」ボタン・進捗・エラーが対象にするキー: 翻訳表示中は
  // `${id}::${lang}`(翻訳版レンダリング用、原文用と衝突しないキー)、それ
  // 以外は従来通り program.id。findPendingJob へ渡す lang も同じ使い分け —
  // 省略時は lang==="" のジョブ(=原文用)のみにマッチするので、原文/翻訳
  // どちらのガードも互いを誤ブロックしない(lib/jobQueue.ts の
  // findExistingPending 参照)。
  const renderAudioKey = selectedProgram
    ? showingCachedProgramTranslation
      ? `${selectedProgram.id}::${targetLang}`
      : selectedProgram.id
    : null;
  const renderProgress = renderAudioKey ? renderAudioState[renderAudioKey] : undefined;
  // ローカルのrenderAudioStateに加えて、キューに残っている"programAudio"
  // ジョブの有無もOR判定に入れる — このビューを離れて戻ってきた直後は
  // renderAudioStateがリセットされているが、ジョブ自体はまだ動いているので
  // ここで拾う。
  const renderAudioJobPending = selectedProgram
    ? showingCachedProgramTranslation
      ? findPendingJob("programAudio", selectedProgram.id, targetLang) !== null
      : findPendingJob("programAudio", selectedProgram.id) !== null
    : false;
  // ダウンロードbusy/エラーの対象キー — レンダリングと同じ使い分け。
  const downloadKey = selectedProgram
    ? showingCachedProgramTranslation
      ? `${selectedProgram.id}::${targetLang}`
      : selectedProgram.id
    : null;

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
                      <span class="ranking-row-side">
                        <span>{t("shared.rankingReactions", { count: row.entry.count })}</span>
                        <span>{t("shared.rankingViews", { count: row.entry.viewCount })}</span>
                      </span>
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
              <h2 class="program-player-title">{programTitleDisplay || t("program.untitledProgram")}</h2>
              <div class="program-player-header-actions">
                {selectedProgram.shared ? (
                  <span class="badge badge--shared">{t("articles.sharedBadge")}</span>
                ) : null}
                {hasAudio ? (
                  <span class="badge program-audio-badge">
                    <Volume2 size={12} /> {t("program.audioBadge")}
                  </span>
                ) : null}
                {/* 「音声を作成」: 翻訳表示中はisOwnProgramを問わない(翻訳音声の
                    レンダリング自体はローカルのviewer側の利便性であり、受信番組
                    でも自分の端末向けに作ってよい。番組がshared済みなら結果は
                    tc-news:program-translationワイヤで自動的に共有もされるが、
                    それはrenderできるかどうかとは無関係)。原文表示中は従来通り
                    isOwnProgramのみ。 */}
                {(
                  showingCachedProgramTranslation
                    ? engine === "openai" && !!resolvedVoice && !hasAudio
                    : isOwnProgram && engine === "openai" && !hasAudio
                ) ? (
                  <button
                    type="button"
                    class="btn btn-ghost"
                    disabled={renderProgress !== undefined || renderAudioJobPending}
                    onClick={() =>
                      showingCachedProgramTranslation
                        ? void handleRenderTranslatedAudio(selectedProgram, targetLang)
                        : void handleRenderAudio(selectedProgram)
                    }
                  >
                    {renderProgress || renderAudioJobPending ? <Loader2 size={14} class="spin" /> : <Mic size={14} />}
                    {renderProgress
                      ? t("program.renderingAudio", { done: renderProgress.done, total: renderProgress.total })
                      : renderAudioJobPending
                        ? t("translate.statusRenderingAudio")
                        : t("program.renderAudio")}
                  </button>
                ) : null}
                {hasAudio && downloadKey ? (
                  <button
                    type="button"
                    class="btn btn-ghost"
                    disabled={downloadState[downloadKey] === "busy"}
                    onClick={() =>
                      void handleDownloadAudio(
                        downloadKey,
                        displayProgram?.audioCids ?? [],
                        displayProgram?.audioMime,
                        displayProgram?.title ?? selectedProgram.title,
                      )
                    }
                  >
                    {downloadState[downloadKey] === "busy" ? <Loader2 size={14} class="spin" /> : <Download size={14} />}
                    {downloadState[downloadKey] === "busy" ? t("program.downloadPreparing") : t("program.downloadAudio")}
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
            {renderAudioKey && renderAudioErrors[renderAudioKey] ? (
              <p class="program-generate-error">{renderAudioErrors[renderAudioKey]}</p>
            ) : null}
            {downloadKey && downloadErrors[downloadKey] ? (
              <p class="program-generate-error">{downloadErrors[downloadKey]}</p>
            ) : null}
            {translateError ? <p class="program-generate-error">{translateError}</p> : null}
            {/* "render before sharing" nudge only makes sense for the
                original script — it's about audioCids riding the same
                tc-news:program wire as the program share itself, so
                rendering first avoids a second publish. Translated audio
                doesn't work that way: it rides its own dedicated
                tc-news:program-translation wire and is shared automatically
                right after rendering (see handleRenderTranslatedAudio), not
                bundled into a manual "share program" click — so the nudge
                never applies while a translated variant is on screen. */}
            {!showingCachedProgramTranslation && isOwnProgram && engine === "openai" && !selectedProgram.shared && !hasAudio ? (
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

            <div class="program-script-toolbar">
              <LanguagePicker
                value={targetLang}
                onChange={(lang) => {
                  setTargetLang(lang);
                  // Switching target language jumps straight to that
                  // language's cached translation if one exists; otherwise
                  // falls back to the original — mirrors
                  // ArticleReaderModal's LanguagePicker onChange.
                  setShowTranslated(getProgramTranslation(selectedProgram.id, lang) !== null);
                }}
                disabled={translateJobPending}
              />
              {programNeedsTranslation && !cachedProgramTranslation ? (
                <button
                  type="button"
                  class="btn btn-ghost"
                  disabled={translateJobPending}
                  onClick={() => void handleTranslateProgram(selectedProgram, targetLang)}
                >
                  <Languages size={14} />
                  {translateJobPending ? t("translate.translating") : t("translate.translate")}
                </button>
              ) : null}
              {showingLiveProgramTranslation ? (
                <span class="badge">
                  {liveProgramProgress && liveProgramProgress.totalChunks > 0
                    ? t("translate.translatingProgress", {
                        done: String(liveProgramProgress.doneChunks),
                        total: String(liveProgramProgress.totalChunks),
                      })
                    : t("translate.translating")}
                </span>
              ) : null}
              {cachedProgramTranslation ? (
                <button type="button" class="btn btn-ghost" onClick={() => setShowTranslated((v) => !v)}>
                  <Languages size={14} />
                  {showTranslated ? t("translate.showOriginal") : t("translate.showTranslated")}
                </button>
              ) : null}
              {showingCachedProgramTranslation ? (
                <span class="badge">{t("translate.translatedBadge", { lang: LOCALE_LABELS[targetLang] })}</span>
              ) : null}
            </div>
            {/* Only true while a translation is still streaming: once cached
                (showingCachedProgramTranslation), displayProgram synthesizes
                translated audio/live-TTS-in-target-language, so the note
                would be wrong there — see displayProgram's doc comment. */}
            {showingLiveProgramTranslation ? (
              <p class="program-section-hint">{t("translate.programAudioOriginalNote")}</p>
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
                  <SegmentText
                    text={programSegmentsDisplay[index]?.text ?? segment.text}
                    ruby={programSegmentsDisplay[index]?.ruby}
                  />
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

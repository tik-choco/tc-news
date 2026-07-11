// App-global persistent playback bar: mounted once at the app root
// (app.tsx, alongside JobQueueToast) so a program keeps playing — and stays
// visible/controllable — across tab switches, unlike the old ProgramView-only
// player. Reflects lib/playerStore via usePlayer(); all control actions
// (pause/resume/stop) call straight into the store, same as ProgramCard's
// play button and ProgramView's (now store-backed) player controls.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Pause, Play, Radio, X } from "lucide-preact";
import { usePlayer } from "../hooks/usePlayer";
import { pausePlayer, resumePlayer, stopPlayer } from "../lib/playerStore";
import { useT } from "../lib/i18n";
import { mediaPreviewsEnabled } from "../lib/linkPreview";
import "../styles/miniPlayer.css";

// Same opt-in-and-drop-silently-on-failure thumbnail idiom as ProgramRowThumb
// (views/ProgramView.tsx) — a program's imageUrl is already fully derived at
// generation time, so there's nothing to retry on failure.
function MiniPlayerThumb(props: { imageUrl: string; alt: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      class="mini-player-thumb"
      src={props.imageUrl}
      alt={props.alt}
      loading="lazy"
      referrerpolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function MiniPlayer(): JSX.Element | null {
  const t = useT();
  const { program, playState, currentIndex, error } = usePlayer();

  // Idle with no error means nothing is playing and nothing recently failed
  // — stay out of the way entirely rather than showing an empty bar.
  if (playState === "idle" && !error) return null;
  if (!program) return null; // defensive: should always be set alongside playState/error above

  const title = program.title || t("program.untitledProgram");

  return (
    <div class="mini-player" role="region" aria-label={title}>
      {program.imageUrl && mediaPreviewsEnabled() ? (
        <MiniPlayerThumb imageUrl={program.imageUrl} alt={title} />
      ) : (
        <div class="mini-player-thumb mini-player-thumb--fallback">
          <Radio size={18} />
        </div>
      )}
      <div class="mini-player-text">
        <span class="mini-player-title">{title}</span>
        <span class="mini-player-meta">
          <span class="mini-player-author">{program.authorName || t("common.anonymous")}</span>
          {playState !== "idle" ? (
            <>
              <span class="mini-player-dot" aria-hidden="true">
                ・
              </span>
              <span>
                {t("program.segmentProgress", { current: currentIndex + 1, total: program.segments.length })}
              </span>
            </>
          ) : null}
        </span>
        {error ? <span class="mini-player-error">{error}</span> : null}
      </div>
      <div class="mini-player-controls">
        {playState !== "idle" ? (
          <button
            type="button"
            class="icon-btn"
            aria-label={playState === "playing" ? t("player.pause") : t("player.resume")}
            title={playState === "playing" ? t("player.pause") : t("player.resume")}
            onClick={() => (playState === "playing" ? pausePlayer() : resumePlayer())}
          >
            {playState === "playing" ? <Pause size={16} /> : <Play size={16} />}
          </button>
        ) : null}
        <button
          type="button"
          class="icon-btn danger"
          aria-label={t("player.stop")}
          title={t("player.stop")}
          onClick={() => stopPlayer()}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

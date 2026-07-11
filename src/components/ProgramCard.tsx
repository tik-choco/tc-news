// Home-feed radio program card (see views/FeedView.tsx's "音声"/"すべて"
// filters). Mirrors ArticleCard's visual conventions (thumbnail, title,
// author + relative time) plus a prominent play/pause control wired straight
// to the app-global player (lib/playerStore) — playback started here
// survives navigating away from the card, unlike the old per-ProgramView
// state. Clicking the card body (not the play button) opens the studio tab
// with this program selected (onOpenProgram, same handler app.tsx already
// wires into SharedView's program rows).
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Pause, Play, Radio, Volume2 } from "lucide-preact";
import type { RadioProgram } from "../types";
import { formatRelativeTime } from "./ArticleCard";
import { usePlayer } from "../hooks/usePlayer";
import { pausePlayer, playProgram, resumePlayer } from "../lib/playerStore";
import { useLocale, useT } from "../lib/i18n";
import { mediaPreviewsEnabled } from "../lib/linkPreview";
import "../styles/programCard.css";

// Same opt-in-and-drop-silently-on-failure thumbnail idiom as ProgramRowThumb
// (views/ProgramView.tsx).
function ProgramCardThumb(props: { imageUrl: string; alt: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      class="program-card-thumb"
      src={props.imageUrl}
      alt={props.alt}
      loading="lazy"
      referrerpolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function ProgramCard(props: {
  program: RadioProgram;
  /** Created on this device (structural membership in loadPrograms()), even
   * before sharing — mirrors ProgramView's isOwnProgram. Own programs have
   * no authorName until shared, so this drives the "自分" fallback below. */
  isOwn: boolean;
  onOpenProgram: (id: string) => void;
}): JSX.Element {
  const { program, isOwn, onOpenProgram } = props;
  const t = useT();
  const { locale } = useLocale();
  const player = usePlayer();

  const isThisProgram = player.program?.id === program.id;
  const isPlaying = isThisProgram && player.playState === "playing";
  const isPaused = isThisProgram && player.playState === "paused";
  const hasAudio = (program.audioCids?.length ?? 0) > 0;
  const title = program.title || t("program.untitledProgram");
  const authorLabel = program.authorName || (isOwn ? t("feed.ownAuthorLabel") : t("common.anonymous"));

  function handlePlayClick(e: MouseEvent) {
    e.stopPropagation();
    if (isPlaying) pausePlayer();
    else if (isPaused) resumePlayer();
    else void playProgram(program);
  }

  return (
    <div class="program-card">
      <button type="button" class="program-card-main" onClick={() => onOpenProgram(program.id)}>
        {program.imageUrl && mediaPreviewsEnabled() ? (
          <ProgramCardThumb imageUrl={program.imageUrl} alt={title} />
        ) : (
          <div class="program-card-thumb program-card-thumb--fallback">
            <Radio size={20} />
          </div>
        )}
        <div class="program-card-text">
          <h3 class="program-card-title">{title}</h3>
          <div class="program-card-meta">
            <span class="program-card-author">{authorLabel}</span>
            <span class="program-card-dot" aria-hidden="true">
              ・
            </span>
            <span class="program-card-time">{formatRelativeTime(program.createdAt, locale)}</span>
            {hasAudio ? (
              <span class="badge program-audio-badge program-card-badge">
                <Volume2 size={11} /> {t("program.audioBadge")}
              </span>
            ) : null}
          </div>
        </div>
      </button>
      <button
        type="button"
        class="program-card-play"
        aria-label={isPlaying ? t("player.pause") : isPaused ? t("player.resume") : t("program.play")}
        title={isPlaying ? t("player.pause") : isPaused ? t("player.resume") : t("program.play")}
        onClick={handlePlayClick}
      >
        {isPlaying ? <Pause size={18} /> : <Play size={18} />}
      </button>
    </div>
  );
}

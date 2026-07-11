// MiniPlayer (components/MiniPlayer.tsx) aria-label strings for the
// app-global persistent player's controls. Wording deliberately mirrors
// program.pause/program.resume/program.stop (views/ProgramView.tsx's player
// controls) — same action, just a second place it can be triggered from —
// but lives in its own namespace since the mini player is a distinct
// component, not part of the studio view.
//
// Pattern for every catalog file: author `ja` (the source), then `en` typed as
// `typeof ja` so TypeScript flags any key present in one but missing in the
// other. Additional languages live in ../locales/<lang>.ts.
const ja = {
  pause: "一時停止",
  resume: "再開",
  stop: "停止",
};

const en: typeof ja = {
  pause: "Pause",
  resume: "Resume",
  stop: "Stop",
};

export const player = { ja, en };

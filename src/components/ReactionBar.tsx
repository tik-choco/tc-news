// Emoji reaction bar: one pill button per REACTION_KINDS, with a live count
// read from reactionStore (Worker A). Used both inline in the article reader
// (interactive, own-DID highlight) and compact/read-only in list rows (social
// proof only). Worker D also imports this component directly — the exported
// prop signature below is a cross-worker contract, keep it stable.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { REACTION_EMOJI, REACTION_KINDS, type ReactionKind } from "../types";
import { countsFor, hasReacted, subscribeReactions } from "../lib/reactionStore";
import { useT } from "../lib/i18n";
import "../styles/reactions.css";

export function ReactionBar(props: {
  targetId: string;
  /** Own DID, for highlighting/disabling a kind the user already reacted
   * with. May be empty (e.g. identity not yet loaded) — no highlight then. */
  myDid?: string;
  /** Omitted => read-only mode: counts render as non-interactive spans. */
  onReact?: (kind: ReactionKind) => void | Promise<void>;
  /** Smaller paddings; hides zero-count kinds (unless every kind is zero and
   * the bar is interactive, in which case all kinds show so there's
   * something to press). */
  compact?: boolean;
}): JSX.Element {
  const { targetId, myDid, onReact, compact } = props;
  const t = useT();
  // Bump-driven re-render: reactionStore is plain localStorage state, not a
  // signal, so we re-read countsFor()/hasReacted() on every render and just
  // need a way to trigger those re-renders when reactions change anywhere.
  const [, bump] = useState(0);
  useEffect(() => subscribeReactions(() => bump((n) => n + 1)), []);
  const [busyKind, setBusyKind] = useState<ReactionKind | null>(null);

  const counts = countsFor(targetId);
  const allZero = REACTION_KINDS.every((kind) => counts[kind] === 0);
  const kinds =
    compact && !(allZero && onReact) ? REACTION_KINDS.filter((kind) => counts[kind] > 0) : REACTION_KINDS;

  async function handleClick(kind: ReactionKind) {
    if (!onReact || busyKind) return;
    setBusyKind(kind);
    try {
      await onReact(kind);
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <div class={`reaction-bar${compact ? " reaction-bar--compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      {kinds.map((kind) => {
        const emoji = REACTION_EMOJI[kind];
        const count = counts[kind];
        const own = Boolean(myDid) && hasReacted(targetId, kind, myDid as string);
        const label = t("shared.reactionButtonAria", { emoji });

        if (!onReact) {
          return (
            <span
              key={kind}
              class={`reaction-btn reaction-btn--readonly${own ? " reaction-btn--own" : ""}`}
              aria-label={label}
              title={label}
            >
              <span class="reaction-btn-emoji" aria-hidden="true">
                {emoji}
              </span>
              {count > 0 ? <span class="reaction-btn-count">{count}</span> : null}
            </span>
          );
        }

        const disabled = own || busyKind === kind;
        return (
          <button
            key={kind}
            type="button"
            class={`reaction-btn${own ? " reaction-btn--own" : ""}${busyKind === kind ? " reaction-btn--busy" : ""}`}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              void handleClick(kind);
            }}
          >
            <span class="reaction-btn-emoji" aria-hidden="true">
              {emoji}
            </span>
            {count > 0 ? <span class="reaction-btn-count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

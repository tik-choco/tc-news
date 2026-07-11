// Subscribes a component to the global player (lib/playerStore) so it
// re-renders whenever playback starts/pauses/resumes/stops or its progress
// changes. Same shape as useJobQueue (hooks/useJobQueue.ts).
import { useEffect, useState } from "preact/hooks";
import { getPlayerState, subscribePlayer, type PlayerState } from "../lib/playerStore";

export function usePlayer(): PlayerState {
  const [state, setState] = useState<PlayerState>(() => getPlayerState());

  useEffect(() => {
    // Snapshot may have changed between the initial useState() call and this
    // effect running (mount race), so sync once before subscribing.
    setState(getPlayerState());
    return subscribePlayer(() => {
      setState(getPlayerState());
    });
  }, []);

  return state;
}

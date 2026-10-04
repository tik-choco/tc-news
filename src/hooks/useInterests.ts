import { useEffect, useState } from "preact/hooks";
import { loadInterests, subscribeInterests } from "../lib/interestStore";
import type { InterestState } from "../lib/recommendationTypes";

export function useInterests(): InterestState {
  const [state, setState] = useState(loadInterests);
  useEffect(() => {
    const refresh = () => setState(loadInterests());
    const unsubscribe = subscribeInterests(refresh);
    // Cover changes between render and subscribing, including another tab.
    refresh();
    return unsubscribe;
  }, []);
  return state;
}

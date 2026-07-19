// Subscribes a component to one translation's live streaming progress
// (lib/translationProgress) so it re-renders as partial translated text
// arrives. Same subscribe/getSnapshot idiom as useJobQueue:
// getTranslationProgress returns a stable reference until the entry
// actually changes, so setState-on-every-notification is safe.
import { useEffect, useState } from "preact/hooks";
import {
  getTranslationProgress,
  subscribeTranslationProgress,
  type TranslationProgress,
  type TranslationProgressKind,
} from "../lib/translationProgress";

export function useTranslationProgress(
  kind: TranslationProgressKind,
  targetId: string,
  lang: string,
): TranslationProgress | null {
  const [progress, setProgress] = useState<TranslationProgress | null>(() =>
    getTranslationProgress(kind, targetId, lang),
  );

  useEffect(() => {
    // Snapshot may have changed between the initial useState() call and this
    // effect running (mount race), so sync once before subscribing.
    setProgress(getTranslationProgress(kind, targetId, lang));
    return subscribeTranslationProgress(() => {
      setProgress(getTranslationProgress(kind, targetId, lang));
    });
  }, [kind, targetId, lang]);

  return progress;
}

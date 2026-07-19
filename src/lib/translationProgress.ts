// In-memory live progress for streaming translations, keyed by
// kind×targetId×lang. While a translation job (lib/jobQueue) is running,
// lib/translate.ts / lib/feedTranslate.ts emit partial results through
// their onProgress callbacks; the job wiring (app.tsx, FeedItemModal)
// publishes them here so any open reader surface can render the
// translation as it streams in — the same role tc-pdf-viewer's
// setTranslatedMarkdown state plays, but as a module singleton (matching
// lib/jobQueue's pattern) because tc-news renders translations from
// several surfaces that all need the same live view of one job.
//
// Deliberately NOT persisted: durable partial results live in
// lib/partialTranslationStore / lib/partialFeedTranslationStore (saved
// per completed chunk); this store only carries the finer-grained
// mid-chunk streaming text, which is worthless across a reload.

export type TranslationProgressKind = "article" | "feed" | "program";

export interface TranslationProgress {
  kind: TranslationProgressKind;
  targetId: string; // NewsArticle.id / FeedItem.id
  lang: string; // target UI locale (lib/i18n Locale value)
  title: string | null; // translated title once known
  subtitle: string | null; // article: excerpt / feed: summary, once known
  body: string; // article: Markdown-so-far / feed: sanitized HTML-so-far
  doneChunks: number;
  totalChunks: number; // 0 while the chunk split hasn't happened yet
  updatedAt: number; // epoch ms
}

const progressMap = new Map<string, TranslationProgress>();
const listeners = new Set<() => void>();

function progressKey(kind: TranslationProgressKind, targetId: string, lang: string): string {
  return `${kind}:${targetId}::${lang}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Live progress for one translation, or null when none is streaming.
 * The returned reference only changes when that entry actually changed,
 * so hook consumers can setState() it directly without redundant renders. */
export function getTranslationProgress(
  kind: TranslationProgressKind,
  targetId: string,
  lang: string,
): TranslationProgress | null {
  return progressMap.get(progressKey(kind, targetId, lang)) ?? null;
}

export function publishTranslationProgress(update: Omit<TranslationProgress, "updatedAt">): void {
  progressMap.set(progressKey(update.kind, update.targetId, update.lang), {
    ...update,
    updatedAt: Date.now(),
  });
  notify();
}

/** Drop a translation's live entry — call when its job settles (complete,
 * failed, or cancelled) so readers fall back to the durable stores. */
export function clearTranslationProgress(kind: TranslationProgressKind, targetId: string, lang: string): void {
  if (!progressMap.delete(progressKey(kind, targetId, lang))) return;
  notify();
}

export function subscribeTranslationProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

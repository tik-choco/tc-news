// Pure Markdown chunker used to split an article body into pieces small
// enough for a single chat-completion call, without corrupting Markdown
// structure. Extracted into its own module (rather than living inline in
// translate.ts) so it can be unit-tested in isolation and, per the module
// header convention elsewhere in lib/, kept free of any network/storage
// dependency.
//
// Ported from tc-pdf-viewer's splitMarkdownForTranslation
// (tc-pdf-viewer/src/services/ai.js) — same line-boundary-first strategy,
// same code-fence guard, same "never cut mid-paragraph" fallback. tc-news's
// version only renames the export and drops the JS-only bits (no
// MARKDOWN_TRANSLATION_CHUNK_SIZE default here; the caller — translate.ts —
// owns its own chunk-size constant so both call sites don't have to agree on
// one shared magic number).

/**
 * Splits `markdown` into chunks of at most `maxChars`, preferring to cut at
 * heading lines and blank lines (paragraph/section boundaries) so each chunk
 * reads as a coherent, self-contained fragment when translated on its own.
 *
 * Two invariants callers rely on:
 * - Code fences (```) are never split across chunks — an odd fence-line
 *   count would otherwise leave one chunk's fence unterminated and the next
 *   chunk's content misinterpreted as code.
 * - A single "paragraph" (a run of lines with no boundary in between) that
 *   by itself exceeds maxChars still becomes one oversized chunk rather than
 *   being cut mid-line/mid-tag — a partial line is never a valid semantic
 *   unit to hand to a translator.
 *
 * chunks.join("\n\n") reconstitutes a document that is semantically
 * equivalent to the input (blank-line spacing may be normalized, since the
 * original inter-line newlines are preserved within each chunk and chunks
 * are rejoined with a paragraph break).
 */
export function splitMarkdownIntoChunks(markdown: string, maxChars: number): string[] {
  if (!markdown || markdown.length <= maxChars) return markdown.trim() ? [markdown] : [];

  const chunks: string[] = [];
  const lines = markdown.split("\n");
  let current: string[] = [];
  let currentLength = 0;
  let inFence = false;

  const flush = (): void => {
    if (!current.length) return;
    chunks.push(current.join("\n"));
    current = [];
    currentLength = 0;
  };

  for (const line of lines) {
    const lineLength = line.length + 1; // +1 accounts for the newline join below
    const isFenceLine = /^\s*(```|~~~)/.test(line);
    const isBoundary = line.trim() === "" || /^#{1,6}\s+/.test(line);

    // Flush at a boundary once we're already over budget — this is the
    // "prefer breaking at structure" path. Never flush mid-fence: doing so
    // would split an open code block across two chunks.
    if (!inFence && currentLength + lineLength > maxChars && isBoundary) {
      flush();
    } else if (!inFence && currentLength > maxChars) {
      // No boundary line has shown up yet even though we're already past
      // maxChars (e.g. one very long paragraph with no blank line). Rather
      // than waiting forever for a boundary that may never come before the
      // next heading, flush here — the oversized-single-paragraph case from
      // the module doc comment.
      flush();
    }

    current.push(line);
    currentLength += lineLength;

    if (isFenceLine) {
      inFence = !inFence;
    }
  }

  flush();
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

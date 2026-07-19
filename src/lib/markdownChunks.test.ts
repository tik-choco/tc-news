import { describe, expect, it } from "vitest";
import { splitMarkdownIntoChunks } from "./markdownChunks";

// Extracts every non-blank, trimmed line from a Markdown string, in order.
// Used to assert content-preservation across chunking without pinning down
// the exact placement of blank-line artifacts the ported algorithm can
// leave at chunk boundaries (see the boundary-splitting test below).
function nonBlankLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("splitMarkdownIntoChunks", () => {
  it("returns an empty array for empty input", () => {
    expect(splitMarkdownIntoChunks("", 100)).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(splitMarkdownIntoChunks("   \n\n\t  \n", 100)).toEqual([]);
  });

  it("returns a single unchanged chunk when the input is already under maxChars", () => {
    const md = "# Title\n\nSome short paragraph of body text.";
    expect(splitMarkdownIntoChunks(md, 1000)).toEqual([md]);
  });

  it("splits at blank-line boundaries once the running chunk is about to exceed maxChars", () => {
    // Six 18-char "paragraphs" (each its own line, no internal blank lines)
    // separated by blank lines, maxChars = 50. Hand-traced against the
    // ported algorithm: a chunk is flushed only when adding the *boundary*
    // (blank) line itself would push the running total past maxChars, so
    // the split point lands right after the third paragraph, not the
    // first line to numerically exceed the cap.
    const p = (ch: string) => ch.repeat(18);
    const lines = [p("A"), "", p("B"), "", p("C"), "", p("D"), "", p("E"), "", p("F")];
    const markdown = lines.join("\n");

    const chunks = splitMarkdownIntoChunks(markdown, 50);

    expect(chunks).toEqual([
      [p("A"), "", p("B"), "", p("C")].join("\n"),
      ["", p("D"), "", p("E"), "", p("F")].join("\n"),
    ]);
  });

  it("joining chunks with \\n\\n preserves every non-blank line, in order", () => {
    const p = (ch: string) => ch.repeat(18);
    const lines = [p("A"), "", p("B"), "", p("C"), "", p("D"), "", p("E"), "", p("F")];
    const markdown = lines.join("\n");

    const chunks = splitMarkdownIntoChunks(markdown, 50);
    const reconstituted = chunks.join("\n\n");

    expect(nonBlankLines(reconstituted)).toEqual(nonBlankLines(markdown));
  });

  it("never splits inside a code fence even though the fenced block exceeds maxChars", () => {
    const codeLineA = "x".repeat(25);
    const codeLineB = "y".repeat(25);
    const markdown = ["```", codeLineA, "", codeLineB, "```"].join("\n");

    // maxChars(20) is well under the fenced block's total length, so
    // without fence protection this would try to split mid-block at the
    // blank line inside it.
    const chunks = splitMarkdownIntoChunks(markdown, 20);

    expect(chunks).toEqual([markdown]);
    // Sanity: the fence markers are balanced (both survived in the same
    // chunk) rather than one being cut off from the other.
    expect(chunks[0].split("```").length - 1).toBe(2);
  });

  it("resumes normal boundary splitting once a code fence closes", () => {
    const codeLine = "x".repeat(25);
    const paragraph = "z".repeat(25);
    const markdown = ["```", codeLine, "```", "", paragraph].join("\n");

    const chunks = splitMarkdownIntoChunks(markdown, 20);

    // Every chunk must be well-formed: fence markers always come in pairs.
    for (const chunk of chunks) {
      expect(chunk.split("```").length - 1).toBe(chunk.includes("```") ? 2 : 0);
    }
    expect(nonBlankLines(chunks.join("\n\n"))).toEqual(nonBlankLines(markdown));
  });

  it("gives a single oversized paragraph (no internal boundary) its own chunk instead of cutting it", () => {
    const longLine = "Z".repeat(500);
    const chunks = splitMarkdownIntoChunks(longLine, 100);

    expect(chunks).toEqual([longLine]);
    expect(chunks[0].length).toBeGreaterThan(100);
  });

  it("keeps two oversized paragraphs as two separate, uncut chunks", () => {
    const longA = "A".repeat(600);
    const longB = "B".repeat(600);
    const markdown = [longA, "", longB].join("\n");

    const chunks = splitMarkdownIntoChunks(markdown, 100);

    expect(chunks).toHaveLength(2);
    // Neither oversized paragraph was cut mid-line: each appears intact,
    // in full, inside exactly one chunk (trimming away any blank-line
    // artifact the flush-before-boundary logic leaves at a chunk's edge).
    expect(chunks[0].trim()).toBe(longA);
    expect(chunks[1].trim()).toBe(longB);
  });

  it("treats headings as boundaries alongside blank lines", () => {
    const p = (ch: string) => ch.repeat(18);
    const markdown = [p("A"), "## Section Two", p("B"), "## Section Three", p("C")].join("\n");

    const chunks = splitMarkdownIntoChunks(markdown, 30);

    // All content must survive regardless of exactly where the splits land.
    expect(nonBlankLines(chunks.join("\n\n"))).toEqual(nonBlankLines(markdown));
    expect(chunks.length).toBeGreaterThan(1);
  });
});

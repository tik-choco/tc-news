// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { extractReadableHtml } from "./pageExtract";

const BASE_URL = "https://example.com/news/story";

// A long, link-free sentence used to build paragraphs that clear the
// MIN_PARAGRAPH_TEXT (300 char) threshold with comfortable margin.
const SENTENCE =
  "Local officials announced a new plan today, describing a series of measures intended to address the issue over the coming months. ";

function para(count = 1): string {
  return `<p>${SENTENCE.repeat(count)}</p>`;
}

describe("extractReadableHtml", () => {
  it("picks <article> over a sidebar div with short link text", () => {
    const html = `
      <html><body>
        <div class="sidebar">
          <p><a href="/a">Popular story one</a></p>
          <p><a href="/b">Popular story two</a></p>
          <p><a href="/c">Popular story three</a></p>
        </div>
        <article>
          ${para(2)}
          ${para(2)}
        </article>
      </body></html>`;

    const result = extractReadableHtml(html, BASE_URL);

    expect(result).not.toBeNull();
    expect(result).toContain("Local officials announced");
    expect(result).not.toContain("Popular story");
  });

  it("weights paragraph text inside <a> down so a link-farm block loses to real prose of similar raw size", () => {
    // Link-farm: 10 paragraphs, each a single long anchor. Raw character
    // count is deliberately larger than the article body below, so this
    // case only passes if the 0.5x link-text discount is actually applied.
    const linkFarmSentence = "This is a long link title that reads almost like a real sentence but is entirely clickable. ";
    const linkFarmParas = Array.from(
      { length: 10 },
      (_, i) => `<p><a href="/link-${i}">${linkFarmSentence}</a></p>`,
    ).join("");
    const html = `
      <html><body>
        <div class="link-list">${linkFarmParas}</div>
        <article>
          ${para(3)}
          ${para(3)}
          ${para(3)}
        </article>
      </body></html>`;

    const result = extractReadableHtml(html, BASE_URL);

    expect(result).not.toBeNull();
    expect(result).toContain("Local officials announced");
    expect(result).not.toContain("long link title");
  });

  it("removes script/nav/footer content even when they sit alongside the article", () => {
    const html = `
      <html><body>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <script>alert("should not appear");</script>
        <article>
          ${para(2)}
          ${para(2)}
        </article>
        <footer>Copyright 2026 Example Corp. All rights reserved.</footer>
      </body></html>`;

    const result = extractReadableHtml(html, BASE_URL);

    expect(result).not.toBeNull();
    expect(result).toContain("Local officials announced");
    expect(result).not.toContain("Copyright");
    expect(result).not.toContain("should not appear");
    expect(result).not.toContain("Home");
  });

  it("resolves a relative <img src> against baseUrl", () => {
    const html = `
      <html><body>
        <article>
          <img src="/img/photo.jpg" alt="Photo" />
          ${para(2)}
          ${para(2)}
        </article>
      </body></html>`;

    const result = extractReadableHtml(html, BASE_URL);

    expect(result).not.toBeNull();
    expect(result).toContain('src="https://example.com/img/photo.jpg"');
  });

  it("returns null for a page with no real article content", () => {
    const html = `
      <html><body>
        <header><a href="/">Site</a></header>
        <nav><a href="/a">A</a><a href="/b">B</a></nav>
        <div class="widget">Hello world.</div>
        <footer>Copyright 2026.</footer>
      </body></html>`;

    const result = extractReadableHtml(html, BASE_URL);

    expect(result).toBeNull();
  });

  it("reduces output to the allowed tag/attribute set: disallowed tags unwrapped, disallowed attrs stripped, allowed content kept", () => {
    const html = `
      <html><body>
        <article>
          <div class="pull-quote">A pulled-out quote wrapper that should be unwrapped.</div>
          <p onclick="doSomethingBad()">${SENTENCE}</p>
          <p style="color:red">${SENTENCE}</p>
          <button onclick="alert(1)">Click me</button>
          ${para(2)}
        </article>
      </body></html>`;

    const result = extractReadableHtml(html, BASE_URL);

    expect(result).not.toBeNull();
    expect(result).toContain("Local officials announced");
    expect(result).toContain("A pulled-out quote wrapper");
    expect(result).not.toContain("<div");
    expect(result).not.toContain("<button");
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("style=");
  });
});

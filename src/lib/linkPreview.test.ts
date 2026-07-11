// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseLinkPreviewHtml } from "./linkPreview";

describe("parseLinkPreviewHtml", () => {
  it("reads og:* tags", () => {
    const html = `<html><head>
      <meta property="og:title" content="OG Title" />
      <meta property="og:description" content="OG Description" />
      <meta property="og:image" content="https://example.com/img/og.jpg" />
      <meta property="og:site_name" content="Example Site" />
    </head><body></body></html>`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/article");

    expect(preview.url).toBe("https://example.com/article");
    expect(preview.title).toBe("OG Title");
    expect(preview.description).toBe("OG Description");
    expect(preview.imageUrl).toBe("https://example.com/img/og.jpg");
    expect(preview.siteName).toBe("Example Site");
  });

  it("falls back to twitter:* tags when og:* tags are absent", () => {
    const html = `<html><head>
      <meta name="twitter:title" content="Twitter Title" />
      <meta name="twitter:description" content="Twitter Description" />
      <meta name="twitter:image" content="https://example.com/img/twitter.jpg" />
    </head></html>`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/article");

    expect(preview.title).toBe("Twitter Title");
    expect(preview.description).toBe("Twitter Description");
    expect(preview.imageUrl).toBe("https://example.com/img/twitter.jpg");
  });

  it("falls back to <title> when no og/twitter title is present", () => {
    const html = `<html><head><title>Fallback Title</title></head><body></body></html>`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/article");
    expect(preview.title).toBe("Fallback Title");
  });

  it("resolves a relative og:image against baseUrl", () => {
    const html = `<meta property="og:image" content="/images/relative.jpg" />`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/articles/foo");
    expect(preview.imageUrl).toBe("https://example.com/images/relative.jpg");
  });

  it("skips a data: URI <img> and falls back to the next real image", () => {
    const html = `<html><body>
      <img src="data:image/png;base64,AAAA" />
      <img src="/images/real.jpg" />
    </body></html>`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/articles/foo");
    expect(preview.imageUrl).toBe("https://example.com/images/real.jpg");
  });

  it("has no imageUrl when the only <img> is a data: URI", () => {
    const html = `<html><body><img src="data:image/png;base64,AAAA" /></body></html>`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/articles/foo");
    expect(preview.imageUrl).toBeUndefined();
  });

  it("accepts og:video pointing at a direct video file", () => {
    const html = `<meta property="og:video" content="https://example.com/videos/clip.mp4" />
      <meta property="og:video:type" content="video/mp4" />`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/articles/foo");
    expect(preview.videoUrl).toBe("https://example.com/videos/clip.mp4");
  });

  it("rejects og:video pointing at a YouTube watch (player) page", () => {
    const html = `<meta property="og:video" content="https://www.youtube.com/watch?v=abc123" />
      <meta property="og:video:type" content="text/html" />`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/articles/foo");
    expect(preview.videoUrl).toBeUndefined();
  });

  it("tolerates meta tags using name= instead of property= (and vice versa)", () => {
    const html = `<html><head>
      <meta name="og:title" content="Name Attr Title" />
      <meta property="twitter:image" content="https://example.com/tw2.jpg" />
    </head></html>`;
    const preview = parseLinkPreviewHtml(html, "https://example.com/articles/foo");
    expect(preview.title).toBe("Name Attr Title");
    expect(preview.imageUrl).toBe("https://example.com/tw2.jpg");
  });
});

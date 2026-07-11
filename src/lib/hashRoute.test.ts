import { describe, expect, it } from "vitest";
import { parseHash } from "./hashRoute";

describe("parseHash", () => {
  it("returns the empty state for an empty or bare hash", () => {
    expect(parseHash("")).toEqual({ tab: null, articleId: null, room: null });
    expect(parseHash("#")).toEqual({ tab: null, articleId: null, room: null });
  });

  it("parses a bare tab hash", () => {
    expect(parseHash("#/feed")).toEqual({ tab: "feed", articleId: null, room: null });
    expect(parseHash("#/program")).toEqual({ tab: "program", articleId: null, room: null });
    expect(parseHash("#/settings")).toEqual({ tab: "settings", articleId: null, room: null });
  });

  it("parses a feed deep link with id", () => {
    expect(parseHash("#/feed/abc-123")).toEqual({ tab: "feed", articleId: "abc-123", room: null });
  });

  it("parses a shared deep link with id", () => {
    expect(parseHash("#/shared/xyz-789")).toEqual({ tab: "shared", articleId: "xyz-789", room: null });
  });

  it("decodes a percent-encoded article id", () => {
    const encoded = encodeURIComponent("id with spaces/slash");
    expect(parseHash(`#/feed/${encoded}`)).toEqual({
      tab: "feed",
      articleId: "id with spaces/slash",
      room: null,
    });
  });

  it("treats #/articles as a legacy alias for the feed tab", () => {
    expect(parseHash("#/articles")).toEqual({ tab: "feed", articleId: null, room: null });
  });

  it("treats #/articles/<id> as a legacy deep link into the feed tab", () => {
    expect(parseHash("#/articles/abc-123")).toEqual({ tab: "feed", articleId: "abc-123", room: null });
    const encoded = encodeURIComponent("id with spaces/slash");
    expect(parseHash(`#/articles/${encoded}`)).toEqual({
      tab: "feed",
      articleId: "id with spaces/slash",
      room: null,
    });
  });

  it("parses a room hash and decodes the room id", () => {
    expect(parseHash("#room=tc-global-articles")).toEqual({ tab: null, articleId: null, room: "tc-global-articles" });
    const encoded = encodeURIComponent("room with spaces");
    expect(parseHash(`#room=${encoded}`)).toEqual({ tab: null, articleId: null, room: "room with spaces" });
  });

  it("rejects a deep link id on a tab that doesn't support one", () => {
    expect(parseHash("#/program/abc")).toEqual({ tab: null, articleId: null, room: null });
    expect(parseHash("#/settings/abc")).toEqual({ tab: null, articleId: null, room: null });
  });

  it("returns the empty state for unknown tabs", () => {
    expect(parseHash("#/unknown-tab")).toEqual({ tab: null, articleId: null, room: null });
  });

  it("returns the empty state for malformed hashes", () => {
    expect(parseHash("#not-a-route")).toEqual({ tab: null, articleId: null, room: null });
    expect(parseHash("#/")).toEqual({ tab: null, articleId: null, room: null });
    expect(parseHash("#room=")).toEqual({ tab: null, articleId: null, room: null });
  });
});

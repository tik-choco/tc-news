import { describe, expect, it } from "vitest";
import { parseRuby, stripRuby } from "./ruby";

describe("parseRuby", () => {
  it("converts a basic marker into a base+ruby token", () => {
    expect(parseRuby("{漢字|かんじ}")).toEqual([{ base: "漢字", ruby: "かんじ" }]);
  });

  it("returns a single plain token when there is no marker", () => {
    expect(parseRuby("こんにちは")).toEqual([{ base: "こんにちは" }]);
  });

  it("handles multiple markers mixed with plain text", () => {
    expect(parseRuby("今日は{漢字|かんじ}を{勉強|べんきょう}します")).toEqual([
      { base: "今日は" },
      { base: "漢字", ruby: "かんじ" },
      { base: "を" },
      { base: "勉強", ruby: "べんきょう" },
      { base: "します" },
    ]);
  });

  it("treats an empty base as a literal", () => {
    expect(parseRuby("{|かんじ}")).toEqual([{ base: "{|かんじ}" }]);
  });

  it("treats an empty reading as a literal", () => {
    expect(parseRuby("{漢字|}")).toEqual([{ base: "{漢字|}" }]);
  });

  it("treats an unclosed marker as a literal", () => {
    expect(parseRuby("{a|b")).toEqual([{ base: "{a|b" }]);
  });

  it("treats an empty string as an empty token list", () => {
    expect(parseRuby("")).toEqual([]);
  });
});

describe("stripRuby", () => {
  it("replaces markers with their base text only", () => {
    expect(stripRuby("今日は{漢字|かんじ}を{勉強|べんきょう}します")).toBe("今日は漢字を勉強します");
  });

  it("leaves plain text untouched", () => {
    expect(stripRuby("plain text")).toBe("plain text");
  });

  it("is consistent with parseRuby: joined bases equal the stripped text", () => {
    const samples = [
      "{漢字|かんじ}",
      "こんにちは",
      "今日は{漢字|かんじ}を{勉強|べんきょう}します",
      "{|かんじ}",
      "{漢字|}",
      "{a|b",
      "",
    ];
    for (const sample of samples) {
      const joined = parseRuby(sample)
        .map((t) => t.base)
        .join("");
      expect(joined).toBe(stripRuby(sample));
    }
  });
});

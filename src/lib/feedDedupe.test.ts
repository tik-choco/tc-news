import { describe, expect, it } from "vitest";
import { groupNearDuplicateItems } from "./feedDedupe";
import type { FeedItem } from "../types";

let seq = 0;

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  seq += 1;
  return {
    id: `item-${seq}`,
    feedId: `feed-${seq}`,
    feedLabel: "Some Feed",
    title: `Untitled ${seq}`,
    link: `https://example.com/articles/${seq}`,
    summary: "",
    publishedAt: Date.now() - seq,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("groupNearDuplicateItems", () => {
  it("groups identical titles from two different feeds, first (newest) as representative", () => {
    const newest = makeItem({
      id: "a",
      feedLabel: "ITmedia",
      title: "OpenAIが新型モデルを発表",
      link: "https://itmedia.example.com/a",
    });
    const older = makeItem({
      id: "b",
      feedLabel: "Impress Watch",
      title: "OpenAIが新型モデルを発表",
      link: "https://impress.example.com/b",
    });

    const groups = groupNearDuplicateItems([newest, older]);

    expect(groups).toHaveLength(1);
    expect(groups[0].item).toBe(newest);
    expect(groups[0].duplicates).toEqual([older]);
  });

  it("groups ~98%-similar Japanese titles (different quoting/wording, same story)", () => {
    const itmedia = makeItem({
      feedLabel: "ITmedia",
      title: "OpenAI、新モデル「GPT-5」を発表、推論能力を大幅に強化",
    });
    const impress = makeItem({
      feedLabel: "Impress Watch",
      title: "OpenAI、新モデル『GPT-5』を発表、推論能力を大幅に強化とのこと",
    });

    const groups = groupNearDuplicateItems([itmedia, impress]);

    expect(groups).toHaveLength(1);
    expect(groups[0].item).toBe(itmedia);
    expect(groups[0].duplicates).toEqual([impress]);
  });

  it("groups the same story republished with different outlet suffixes", () => {
    const itmedia = makeItem({
      feedLabel: "ITmedia",
      title: "OpenAI、新モデル『GPT-5』を発表 - ITmedia",
    });
    const impress = makeItem({
      feedLabel: "Impress Watch",
      title: "OpenAI、新モデル「GPT-5」を発表(Impress Watch)",
    });

    const groups = groupNearDuplicateItems([itmedia, impress]);

    expect(groups).toHaveLength(1);
    expect(groups[0].item).toBe(itmedia);
    expect(groups[0].duplicates).toEqual([impress]);
  });

  it("does not group different stories that share the same outlet suffix", () => {
    const a = makeItem({ title: "A社が新製品を発表 - ITmedia" });
    const b = makeItem({ title: "B社が四半期決算を発表 - ITmedia" });

    const groups = groupNearDuplicateItems([a, b]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.item)).toEqual([a, b]);
  });

  it("groups a leading-tagged title with its pipe-suffixed republication", () => {
    const tagged = makeItem({ title: "【速報】トヨタが新型EVセダンを発表" });
    const piped = makeItem({ title: "トヨタが新型EVセダンを発表 | Reuters" });

    const groups = groupNearDuplicateItems([tagged, piped]);

    expect(groups).toHaveLength(1);
    expect(groups[0].item).toBe(tagged);
    expect(groups[0].duplicates).toEqual([piped]);
  });

  it("leaves a title untouched when stripping the suffix would leave under 8 chars", () => {
    // If " - NHK" / " - TBS" were stripped, both cores would collapse to 「速報」
    // and wrongly group; the min-head-length guard must prevent that.
    const nhk = makeItem({ title: "速報 - NHK" });
    const tbs = makeItem({ title: "速報 - TBS" });

    const groups = groupNearDuplicateItems([nhk, tbs]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.item)).toEqual([nhk, tbs]);
  });

  it("does not group similar-length titles about different topics", () => {
    const rain = makeItem({ title: "東京都心で今夜から大雨、交通機関に影響のおそれ" });
    const vaccine = makeItem({ title: "大阪府で新型ワクチンの接種が本格的に開始される" });

    const groups = groupNearDuplicateItems([rain, vaccine]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.item)).toEqual([rain, vaccine]);
    expect(groups[0].duplicates).toEqual([]);
    expect(groups[1].duplicates).toEqual([]);
  });

  it("groups same canonical link (utm params stripped) even when titles differ", () => {
    const withUtm = makeItem({
      title: "速報:新製品を発表",
      link: "https://example.com/news/123?utm_source=twitter&utm_medium=social",
    });
    const withoutUtm = makeItem({
      title: "まったく異なる見出しのテキスト",
      link: "https://example.com/news/123/",
    });

    const groups = groupNearDuplicateItems([withUtm, withoutUtm]);

    expect(groups).toHaveLength(1);
    expect(groups[0].item).toBe(withUtm);
    expect(groups[0].duplicates).toEqual([withoutUtm]);
  });

  it("groups short titles only on exact normalized equality", () => {
    const a = makeItem({ title: "速報", link: "https://example.com/1" });
    const b = makeItem({ title: "速報", link: "https://example.com/2" });

    const groups = groupNearDuplicateItems([a, b]);

    expect(groups).toHaveLength(1);
    expect(groups[0].item).toBe(a);
    expect(groups[0].duplicates).toEqual([b]);
  });

  it("does not group different short titles even if similar", () => {
    const a = makeItem({ title: "速報", link: "https://example.com/1" });
    const b = makeItem({ title: "続報", link: "https://example.com/2" });

    const groups = groupNearDuplicateItems([a, b]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.item)).toEqual([a, b]);
  });

  it("never groups untitled/empty-title items together, even with different links", () => {
    const a = makeItem({ title: "", link: "https://example.com/1" });
    const b = makeItem({ title: "   ", link: "https://example.com/2" });

    const groups = groupNearDuplicateItems([a, b]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.item)).toEqual([a, b]);
  });

  it("preserves input order for representatives and duplicates", () => {
    const first = makeItem({ id: "1", title: "ニュースA", link: "https://example.com/a" });
    const second = makeItem({ id: "2", title: "ニュースB", link: "https://example.com/b" });
    const dupOfFirst = makeItem({ id: "3", title: "ニュースA", link: "https://example.com/a2" });
    const dupOfSecond = makeItem({ id: "4", title: "ニュースB", link: "https://example.com/b2" });

    const groups = groupNearDuplicateItems([first, second, dupOfFirst, dupOfSecond]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.item.id)).toEqual(["1", "2"]);
    expect(groups[0].duplicates.map((d) => d.id)).toEqual(["3"]);
    expect(groups[1].duplicates.map((d) => d.id)).toEqual(["4"]);
  });

  it("collapses a 3-way near-duplicate cluster (A≈B, A≈C) into one group with 2 duplicates", () => {
    const a = makeItem({
      id: "a",
      feedLabel: "ITmedia",
      title: "OpenAI、新モデル「GPT-5」を発表、推論能力を大幅に強化",
    });
    const b = makeItem({
      id: "b",
      feedLabel: "Impress Watch",
      title: "OpenAI、新モデル『GPT-5』を発表、推論能力を大幅に強化とのこと",
    });
    const c = makeItem({
      id: "c",
      feedLabel: "Yahoo!ニュース",
      title: "OpenAI、新モデル「GPT-5」を発表。推論能力を大幅に強化(速報)",
    });

    const groups = groupNearDuplicateItems([a, b, c]);

    expect(groups).toHaveLength(1);
    expect(groups[0].item).toBe(a);
    expect(groups[0].duplicates).toEqual([b, c]);
  });

  it("returns an empty array for an empty input", () => {
    expect(groupNearDuplicateItems([])).toEqual([]);
  });
});

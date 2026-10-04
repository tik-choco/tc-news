import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FeedItem } from "../types";
import { fetchReadablePage, type ExtractedPage } from "../lib/pageExtract";
import { useReadingInterest } from "../hooks/useReadingInterest";
import { useTranslationProgress } from "../hooks/useTranslationProgress";
import { FeedItemModal } from "./FeedItemModal";

vi.mock("../lib/pageExtract", () => ({ fetchReadablePage: vi.fn() }));
vi.mock("../hooks/useReadingInterest", () => ({ useReadingInterest: vi.fn() }));
vi.mock("../hooks/useLinkPreview", () => ({ useLinkPreview: () => null }));
vi.mock("../hooks/useJobQueue", () => ({ useJobQueue: () => [] }));
vi.mock("../hooks/useTranslationProgress", () => ({ useTranslationProgress: vi.fn(() => null) }));
vi.mock("../lib/feedTranslate", () => ({ translateFeedContent: vi.fn() }));
vi.mock("./RecommendationFeedback", () => ({ RecommendationFeedback: () => null }));
vi.mock("./ArticleCard", () => ({ formatRelativeTime: () => "now" }));

const item: FeedItem = {
  id: "article", feedId: "feed", feedLabel: "Example", title: "Original title",
  link: "https://example.com/article", summary: "RSS summary", publishedAt: 1, fetchedAt: 2,
};
const props = { item, selected: false, onToggleSelect: vi.fn(), onClose: vi.fn() };

beforeEach(() => {
  localStorage.clear();
  vi.mocked(useTranslationProgress).mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("counts failed full-text extraction as summary reading, never full reading", async () => {
  let resolve!: (page: ExtractedPage | null) => void;
  vi.mocked(fetchReadablePage).mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<FeedItemModal {...props} />);
  expect(useReadingInterest).toHaveBeenLastCalledWith(expect.objectContaining({ key: "feed:article" }), "loading");
  await act(async () => { resolve(null); });
  expect(useReadingInterest).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Original title" }), "summary");
});

it("suspends full reading during streaming while retaining the original interest identity", async () => {
  vi.mocked(fetchReadablePage).mockResolvedValue({ url: item.link, html: "<p>Article body</p>" });
  const { rerender } = render(<FeedItemModal {...props} />);
  await act(async () => { await Promise.resolve(); });
  expect(useReadingInterest).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Original title" }), "full");
  vi.mocked(useTranslationProgress).mockReturnValue({
    kind: "feed", targetId: item.id, lang: "ja", title: "Translated title",
    subtitle: "Translated summary", body: "<p>Partial translation</p>", doneChunks: 1, totalChunks: 3, updatedAt: 1,
  });
  rerender(<FeedItemModal {...props} />);
  expect(useReadingInterest).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Original title" }), "loading");
  vi.mocked(useTranslationProgress).mockReturnValue(null);
  rerender(<FeedItemModal {...props} />);
  expect(useReadingInterest).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Original title" }), "full");
});

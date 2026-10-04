import { act, cleanup, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedInbox } from "./FeedInbox";

vi.mock("../hooks/useLinkPreview", () => ({ useLinkPreview: () => null }));
vi.mock("./ArticleCard", () => ({ formatRelativeTime: () => "now" }));

const observers: { notify: (visible: boolean) => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
beforeEach(() => {
  localStorage.clear();
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: IntersectionObserverCallback) {
      observers.push({
        notify: (visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
        disconnect: this.disconnect,
      });
    }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reveals successive batches near the bottom and stops observing when exhausted", async () => {
  const items = Array.from({ length: 65 }, (_, i) => ({
    id: `${i}`, title: `A${i}`, feedId: `${i}`, feedLabel: `${i}`,
    link: `https://source${i}.example.com/news`, summary: "",
    publishedAt: i, fetchedAt: i,
  }));
  const { container, unmount } = render(<FeedInbox items={items} hasFeeds selectedIds={new Set()}
    onToggleSelect={() => {}} onSelectMany={() => {}} onOpenItem={() => {}} />);
  const count = () => container.querySelectorAll(".feed-item-card").length;
  expect(count()).toBe(30);
  expect(container.querySelector(".feed-inbox-load-more button")).toBeNull();
  await waitFor(() => expect(observers).toHaveLength(1));
  act(() => observers[0].notify(false));
  expect(count()).toBe(30);
  act(() => { observers[0].notify(true); observers[0].notify(true); });
  expect(count()).toBe(60);
  await waitFor(() => expect(observers).toHaveLength(2));
  act(() => observers[1].notify(true));
  expect(count()).toBe(65);
  expect(container.querySelector(".feed-inbox-load-more")).toBeNull();
  expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
  unmount();
  act(() => observers[1].notify(true));
});

import { cleanup, render } from "@testing-library/preact";
import { afterEach, expect, it, vi } from "vitest";
import { FeedManageSidebar } from "./FeedManageSidebar";

vi.mock("./ArticleCard", () => ({ formatRelativeTime: () => "just now" }));

afterEach(cleanup);

it("focuses the feed URL after expansion and on subsequent setup requests without submitting", () => {
  const actions = {
    feeds: [], refreshing: false, lastRefreshedAt: null, errors: {},
    onToggleCollapsed: vi.fn(), onRefreshAll: vi.fn(), onAddFeed: vi.fn(),
    onRemoveFeed: vi.fn(), onToggleFeed: vi.fn(), onUpdateFeed: vi.fn(),
  };
  const { rerender, getByRole, queryByRole } = render(
    <FeedManageSidebar {...actions} collapsed focusRequest={0} />,
  );
  expect(queryByRole("textbox")).toBeNull();

  rerender(<FeedManageSidebar {...actions} collapsed={false} focusRequest={1} />);
  const input = getByRole("textbox", { name: "フィードURL(https://...)" });
  expect(document.activeElement).toBe(input);

  getByRole("button", { name: "追加" }).focus();
  rerender(<FeedManageSidebar {...actions} collapsed={false} focusRequest={2} />);
  expect(document.activeElement).toBe(input);
  expect(actions.onAddFeed).not.toHaveBeenCalled();
});

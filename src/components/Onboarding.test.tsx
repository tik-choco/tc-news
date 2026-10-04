// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../lib/appSettings";
import { emptyLlmConfig, LLM_CONFIG_KEY } from "../lib/llmConfig";
import { Onboarding } from "./Onboarding";

// Keep the wizard test independent of model discovery and the settings screen.
vi.mock("../views/SettingsView", () => ({
  ModelField: (props: { value: string }) => <input value={props.value} readOnly />,
}));
vi.mock("../lib/llm", () => ({ requestChatCompletion: vi.fn() }));

function seedConnection() {
  const config = emptyLlmConfig();
  config.providers = [{ id: "provider", label: "Local", baseUrl: "http://localhost:1234/v1", apiKey: "existing-key" }];
  config.presets = [{ id: "preset", label: "Default", providerId: "provider", model: "existing-model" }];
  config.defaultPresetId = "preset";
  localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));
}

function renderOnboarding() {
  const callbacks = {
    onStartReading: vi.fn(),
    onClose: vi.fn(),
    onSettingsChange: vi.fn(),
  };
  const view = render(<Onboarding settings={{ ...DEFAULT_APP_SETTINGS }} {...callbacks} />);
  return { ...view, ...callbacks };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Onboarding", () => {
  it.each([false, true])("starts reading without saving settings (existing connection: %s)", (configured) => {
    if (configured) seedConnection();
    const write = vi.spyOn(localStorage, "setItem");
    const view = renderOnboarding();

    fireEvent.click(view.getByRole("button", { name: "ニュースを読む" }));

    expect(view.onStartReading).toHaveBeenCalledOnce();
    expect(view.onClose).not.toHaveBeenCalled();
    expect(view.onSettingsChange).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("reopens existing connection values and allows closing without saving edits", () => {
    seedConnection();
    const write = vi.spyOn(localStorage, "setItem");
    const view = renderOnboarding();

    fireEvent.click(view.getByRole("button", { name: "記事作成を設定" }));
    const baseUrl = view.getByDisplayValue("http://localhost:1234/v1");
    expect(view.getByDisplayValue("existing-key")).toBeTruthy();
    expect(view.getByDisplayValue("existing-model")).toBeTruthy();
    fireEvent.input(baseUrl, { target: { value: "http://localhost:5678/v1" } });
    fireEvent.click(view.getByRole("button", { name: "閉じる" }));

    expect(view.onClose).toHaveBeenCalledOnce();
    expect(view.onStartReading).not.toHaveBeenCalled();
    expect(view.onSettingsChange).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("finishes optional setup through the close callback while preserving app preferences", () => {
    const view = renderOnboarding();

    fireEvent.click(view.getByRole("button", { name: "記事作成を設定" }));
    fireEvent.click(view.getByRole("button", { name: "保存して次へ" }));
    fireEvent.input(view.getByPlaceholderText("例: ふくろう"), { target: { value: " Reader " } });
    fireEvent.click(view.getByRole("button", { name: "次へ" }));
    fireEvent.click(view.getByRole("button", { name: "完了" }));

    expect(view.onSettingsChange).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_APP_SETTINGS, userName: "Reader" });
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(view.onStartReading).not.toHaveBeenCalled();
    expect(localStorage.getItem(LLM_CONFIG_KEY)).toBeNull();
  });
});

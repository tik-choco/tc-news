import { beforeEach, describe, expect, it } from "vitest";
import { loadAppSettings, saveAppSettings } from "./appSettings";

const SETTINGS_KEY = "tc-news:app-settings";

beforeEach(() => localStorage.clear());

describe("article sharing preferences", () => {
  it("requires a sharing action for a fresh install, including after saving other settings", () => {
    const settings = loadAppSettings();
    expect(settings.shareMode).toBe("manual");
    expect(settings.globalShare).toBe(false);

    saveAppSettings({ ...settings, userName: "Reader" });
    expect(loadAppSettings()).toMatchObject({ userName: "Reader", shareMode: "manual", globalShare: false });
  });

  it("preserves legacy automatic sharing when saved settings predate the sharing fields", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ userName: "Existing reader", roomId: "my-room" }));
    expect(loadAppSettings()).toMatchObject({
      userName: "Existing reader", roomId: "my-room", shareMode: "auto", globalShare: true,
    });
  });

  it.each([
    { shareMode: "auto" as const, globalShare: true },
    { shareMode: "auto" as const, globalShare: false },
    { shareMode: "manual" as const, globalShare: true },
    { shareMode: "manual" as const, globalShare: false },
  ])("preserves explicitly saved sharing preferences: %j", (preferences) => {
    saveAppSettings({ ...loadAppSettings(), ...preferences });
    expect(loadAppSettings()).toMatchObject(preferences);
  });

  it.each(["{bad json", "null", "[]"])("does not enable publishing when stored settings are invalid: %s", (raw) => {
    localStorage.setItem(SETTINGS_KEY, raw);
    expect(loadAppSettings()).toMatchObject({ shareMode: "manual", globalShare: false });
  });
});

import { describe, expect, it } from "vitest";
import { AI_SETTINGS_MESSAGES } from "./aiSettings";
import { LLM_SETTINGS_MESSAGES } from "@tik-choco/mistai/preact";
function check(catalogs: Record<string, Record<string, string>>) {
  const keys = Object.keys(catalogs.en).sort();
  for (const locale of ["ja", "zh-CN", "zh-TW"]) {
    expect(Object.keys(catalogs[locale]).sort()).toEqual(keys);
    for (const key of keys) {
      expect(catalogs[locale][key].trim()).not.toBe("");
      expect((catalogs[locale][key].match(/\{\w+\}/g) ?? []).sort()).toEqual((catalogs.en[key].match(/\{\w+\}/g) ?? []).sort());
    }
  }
}
describe("AI settings language coverage", () => {
  it("has complete app and library catalogs with matching placeholders", () => {
    check(AI_SETTINGS_MESSAGES); check(LLM_SETTINGS_MESSAGES);
  });
});

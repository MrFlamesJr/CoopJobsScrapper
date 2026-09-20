import { describe, expect, test, vi } from "vitest";
import { compareVersions, detectBrowser } from "./extensionInfo.js";

describe("compareVersions", () => {
  test("an older build compares below a newer one", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.1.9", "0.2.0")).toBe(-1);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
  });

  test("equal versions compare equal, whatever their length", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  test("a newer build compares above, and a missing version is oldest", () => {
    expect(compareVersions("0.3.0", "0.2.9")).toBe(1);
    expect(compareVersions(null, "0.1.0")).toBe(-1);
  });
});

describe("detectBrowser", () => {
  test("a phone is never a scraping browser, whatever the brand", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile",
    });
    try {
      expect(detectBrowser()).toBe("other");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

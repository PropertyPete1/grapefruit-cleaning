/**
 * Settings-driven public site info: verifies the public siteInfo endpoint
 * only exposes whitelisted keys, trims values, defaults to empty strings
 * (so the UI hides unconfigured sections), and that public review
 * submissions are created unapproved (never instantly published).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockListSettings = vi.fn();
const mockCreateReview = vi.fn();

vi.mock("./db", () => ({
  listSettings: (...args: unknown[]) => mockListSettings(...args),
  createReview: (...args: unknown[]) => mockCreateReview(...args),
  listReviews: vi.fn().mockResolvedValue([]),
  listGalleryItems: vi.fn().mockResolvedValue([]),
}));

import { publicContentRouter } from "./routers/publicContent";
import { PUBLIC_SETTING_KEYS } from "../shared/const";

function caller() {
  return publicContentRouter.createCaller({} as never);
}

beforeEach(() => {
  mockListSettings.mockReset();
  mockCreateReview.mockReset();
});

describe("public siteInfo endpoint", () => {
  it("returns every whitelisted key as empty string when nothing is configured", async () => {
    mockListSettings.mockResolvedValue([]);
    const info = await caller().siteInfo();
    expect(Object.keys(info).sort()).toEqual([...PUBLIC_SETTING_KEYS].sort());
    for (const key of PUBLIC_SETTING_KEYS) {
      expect(info[key]).toBe("");
    }
  });

  it("returns configured values and trims whitespace", async () => {
    mockListSettings.mockResolvedValue([
      { settingKey: "business_phone", settingValue: "  (210) 555-8899  " },
      { settingKey: "stats_clients", settingValue: "150+" },
    ]);
    const info = await caller().siteInfo();
    expect(info.business_phone).toBe("(210) 555-8899");
    expect(info.stats_clients).toBe("150+");
    expect(info.business_email).toBe("");
  });

  it("never leaks non-whitelisted settings (e.g. internal keys)", async () => {
    mockListSettings.mockResolvedValue([
      { settingKey: "internal_api_secret", settingValue: "supersecret" },
      { settingKey: "business_email", settingValue: "team@example.com" },
    ]);
    const info = await caller().siteInfo() as Record<string, string>;
    expect(info.internal_api_secret).toBeUndefined();
    expect(info.business_email).toBe("team@example.com");
  });
});

describe("public review submission", () => {
  it("creates reviews unapproved so they require admin moderation", async () => {
    mockCreateReview.mockResolvedValue(undefined);
    const res = await caller().submitReview({ customerName: "Jane D.", rating: 5, text: "Great service!" });
    expect(res.success).toBe(true);
    expect(mockCreateReview).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false, source: "website", customerName: "Jane D." })
    );
  });

  it("rejects out-of-range ratings", async () => {
    await expect(
      caller().submitReview({ customerName: "X", rating: 6, text: "hi" })
    ).rejects.toThrow();
    expect(mockCreateReview).not.toHaveBeenCalled();
  });
});

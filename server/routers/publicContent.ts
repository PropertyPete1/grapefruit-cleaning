import { z } from "zod";
import * as db from "../db";
import { publicProcedure, router } from "../_core/trpc";
import { PUBLIC_SETTING_KEYS, type SiteInfo } from "../../shared/const";

/** Public content: approved reviews + visible gallery items (live data). */
export const publicContentRouter = router({
  reviews: publicProcedure.query(() => db.listReviews(true)),
  gallery: publicProcedure.query(() => db.listGalleryItems(true)),
  /**
   * Business info for the public site (footer, contact page, SEO JSON-LD,
   * homepage stats). Whitelisted keys only — never leaks internal settings.
   */
  siteInfo: publicProcedure.query(async (): Promise<SiteInfo> => {
    const rows = await db.listSettings();
    const map = new Map(rows.map((r) => [r.settingKey, r.settingValue ?? ""]));
    return Object.fromEntries(
      PUBLIC_SETTING_KEYS.map((key) => [key, (map.get(key) ?? "").trim()])
    ) as SiteInfo;
  }),
  submitReview: publicProcedure
    .input(
      z.object({
        customerName: z.string().min(1).max(200),
        rating: z.number().int().min(1).max(5),
        text: z.string().min(1).max(3000),
      })
    )
    .mutation(async ({ input }) => {
      await db.createReview({ ...input, source: "website", approved: false });
      return { success: true } as const;
    }),
});

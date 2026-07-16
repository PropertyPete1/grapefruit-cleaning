import { z } from "zod";
import * as db from "../db";
import { publicProcedure, router } from "../_core/trpc";
import { PUBLIC_SETTING_KEYS, type SiteInfo } from "../../shared/const";
import { assertRateLimit, clientIp, looksLikeSpam } from "../antiSpam";

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
        website: z.string().max(500).optional(), // honeypot
        formRenderedAt: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertRateLimit("review", clientIp(ctx), 5, 60_000);
      if (looksLikeSpam(input)) {
        return { success: true } as const; // silent reject — bots learn nothing
      }
      await db.createReview({
        customerName: input.customerName,
        rating: input.rating,
        text: input.text,
        source: "website",
        approved: false,
      });
      return { success: true } as const;
    }),

  /** Published blog posts, newest first (public). */
  blogPosts: publicProcedure.query(() => db.listBlogPosts(true)),

  /** A single published blog post by slug (public). */
  blogPost: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(160) }))
    .query(async ({ input }) => {
      const post = await db.getBlogPostBySlug(input.slug);
      if (!post || !post.published) return null;
      return post;
    }),
});

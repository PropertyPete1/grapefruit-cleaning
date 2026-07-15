import { z } from "zod";
import * as db from "../db";
import { publicProcedure, router } from "../_core/trpc";

/** Public content: approved reviews + visible gallery items (live data). */
export const publicContentRouter = router({
  reviews: publicProcedure.query(() => db.listReviews(true)),
  gallery: publicProcedure.query(() => db.listGalleryItems(true)),
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


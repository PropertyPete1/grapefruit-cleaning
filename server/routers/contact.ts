import { z } from "zod";
import * as db from "../db";
import { sendContactNotification } from "../emails";
import { publicProcedure, router } from "../_core/trpc";
import { assertRateLimit, clientIp, looksLikeSpam } from "../antiSpam";

export const contactRouter = router({
  submit: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        email: z.string().email().max(320),
        phone: z.string().max(40).optional(),
        subject: z.string().max(255).optional(),
        message: z.string().min(1).max(5000),
        locale: z.enum(["en", "es"]),
        website: z.string().max(500).optional(), // honeypot — humans never fill this
        formRenderedAt: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertRateLimit("contact", clientIp(ctx), 5, 60_000);
      if (looksLikeSpam(input)) {
        // Silently pretend success so bots learn nothing.
        return { success: true } as const;
      }
      await db.createContactMessage({
        name: input.name,
        email: input.email,
        phone: input.phone,
        subject: input.subject,
        message: input.message,
        locale: input.locale,
      });
      await sendContactNotification(input);
      return { success: true } as const;
    }),
});

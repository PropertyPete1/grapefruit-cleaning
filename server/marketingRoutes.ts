/**
 * One-click unsubscribe: GET /unsubscribe/:token
 *
 * Every marketing email carries this link, and it must work with a single
 * click — no login, no confirmation step, no "are you sure". That is both the
 * legal standard for commercial email and the decent way to treat someone who
 * has decided they've heard enough from us.
 *
 * The token is the only credential, like the balance and tip links. It is not
 * secret in any meaningful sense — anyone with the email has it — but the only
 * thing it can do is stop mail, which is a safe direction for a stranger to
 * push. Nothing here exposes customer data: the page confirms the action
 * without naming the person or echoing their address.
 *
 * Deliberately NOT under /api: this URL is read by humans in an email client.
 */
import type { Express, Request, Response } from "express";
import * as db from "./db";

const BRAND_CORAL = "#F26D5B";
const BRAND_CREAM = "#FDF8F3";

type UnsubKind = "done" | "notFound" | "error";

const NOTICES: Record<UnsubKind, Record<"en" | "es", { title: string; body: string }>> = {
  done: {
    en: {
      title: "You're unsubscribed",
      body: "We won't send you any more re-booking invitations. You'll still receive confirmations, receipts and invoices for any cleaning you book with us. Thank you for letting us into your home.",
    },
    es: {
      title: "Suscripción cancelada",
      body: "No le enviaremos más invitaciones para reservar. Seguirá recibiendo confirmaciones, recibos y facturas de cualquier limpieza que reserve con nosotros. Gracias por habernos recibido en su hogar.",
    },
  },
  notFound: {
    en: {
      title: "We couldn't find that link",
      body: "This unsubscribe link may have been mistyped. If you'd still like to stop receiving invitations, just reply to any of our emails and we'll take care of it right away.",
    },
    es: {
      title: "No encontramos ese enlace",
      body: "Es posible que el enlace esté incompleto. Si aún desea dejar de recibir invitaciones, responda a cualquiera de nuestros correos y lo haremos de inmediato.",
    },
  },
  error: {
    en: {
      title: "Something went wrong",
      body: "We couldn't process that just now. Please try again in a moment, or reply to any of our emails and we'll unsubscribe you by hand.",
    },
    es: {
      title: "Algo salió mal",
      body: "No pudimos procesar su solicitud en este momento. Inténtelo de nuevo o responda a cualquiera de nuestros correos y lo haremos manualmente.",
    },
  },
};

export function renderUnsubscribeNotice(kind: UnsubKind, locale: "en" | "es"): string {
  const { title, body } = NOTICES[kind][locale];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} | Grapefruit Cleaning Co.</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND_CREAM};font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:48px 16px;">
    <div style="text-align:center;padding-bottom:20px;">
      <p style="margin:0;font-size:22px;font-weight:800;color:${BRAND_CORAL};">Grapefruit Cleaning Co.</p>
    </div>
    <div style="background:#ffffff;border-radius:16px;padding:32px 28px;box-shadow:0 2px 12px rgba(60,40,30,0.06);text-align:center;">
      <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#3d3733;">${esc(title)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.65;color:#3d3733;">${esc(body)}</p>
    </div>
    <p style="text-align:center;margin-top:20px;font-size:12px;color:#9b918a;">© ${new Date().getFullYear()} Grapefruit Cleaning Co.</p>
  </div>
</body>
</html>`;
}

export async function unsubscribeHandler(req: Request, res: Response) {
  const token = String(req.params.token ?? "");
  try {
    const customer = token ? await db.getCustomerByMarketingToken(token) : undefined;
    if (!customer) {
      return res.status(404).type("html").send(renderUnsubscribeNotice("notFound", "en"));
    }
    const locale = (customer.preferredLocale as "en" | "es") ?? "en";
    // Idempotent: clicking twice, or a mail client pre-fetching the link, both
    // land on the same confirmation rather than an error.
    await db.unsubscribeFromMarketing(customer.id);
    console.log(`[Marketing] Customer ${customer.id} unsubscribed`);
    return res.status(200).type("html").send(renderUnsubscribeNotice("done", locale));
  } catch (error) {
    console.error("[Marketing] Unsubscribe handler error:", error);
    return res.status(500).type("html").send(renderUnsubscribeNotice("error", "en"));
  }
}

export function registerMarketingRoutes(app: Express): void {
  app.get("/unsubscribe/:token", unsubscribeHandler);
}

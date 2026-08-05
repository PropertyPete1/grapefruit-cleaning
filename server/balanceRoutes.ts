/**
 * Customer-facing balance payment link: GET /api/pay/balance/:token
 *
 * A Stripe Checkout Session may live at most 24 hours, so the emailed link
 * points here instead of straight at Stripe. While the invoice's own 7-day
 * window is open this mints a fresh session and redirects; once the balance is
 * settled or the window closes it renders a short bilingual notice.
 *
 * The token (24 random bytes) is the only credential — no session required,
 * exactly like the staff invite links.
 */
import type { Express, Request, Response } from "express";
import { assertRateLimit } from "./antiSpam";
import { createBalanceCheckoutSession } from "./balance";
import { balanceLinkStatus } from "./balanceRules";
import * as db from "./db";

const BRAND_CORAL = "#F26D5B";
const BRAND_CREAM = "#FDF8F3";

type NoticeKind = "paid" | "expired" | "notFound" | "error";

const NOTICES: Record<NoticeKind, Record<"en" | "es", { title: string; body: string }>> = {
  paid: {
    en: {
      title: "Payment received — thank you!",
      body: "Your balance is paid in full. A receipt is on its way to your inbox. We loved cleaning for you!",
    },
    es: {
      title: "Pago recibido — ¡gracias!",
      body: "Su saldo está pagado por completo. Le enviaremos el recibo por correo. ¡Fue un gusto limpiar para usted!",
    },
  },
  expired: {
    en: {
      title: "This payment link has expired",
      body: "No problem at all — reply to your invoice email or give us a call and we'll send you a fresh link right away.",
    },
    es: {
      title: "Este enlace de pago ha expirado",
      body: "No hay ningún problema — responda al correo de su factura o llámenos y le enviaremos un enlace nuevo de inmediato.",
    },
  },
  notFound: {
    en: {
      title: "We couldn't find this payment link",
      body: "The link may have been mistyped or replaced by a newer one. Please check your most recent invoice email, or contact us and we'll help.",
    },
    es: {
      title: "No encontramos este enlace de pago",
      body: "Es posible que el enlace esté incompleto o haya sido reemplazado por uno más reciente. Revise el correo más reciente de su factura o contáctenos y con gusto le ayudamos.",
    },
  },
  error: {
    en: {
      title: "Something went wrong",
      body: "We couldn't open the payment page just now. Please try again in a moment, or contact us and we'll take your payment another way.",
    },
    es: {
      title: "Algo salió mal",
      body: "No pudimos abrir la página de pago en este momento. Inténtelo de nuevo en un momento o contáctenos y recibiremos su pago de otra forma.",
    },
  },
};

/** Small branded standalone page, styled like the transactional emails. */
export function renderBalanceNotice(kind: NoticeKind, locale: "en" | "es"): string {
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

function requestIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function requestOrigin(req: Request): string {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) return origin;
  return `${req.protocol}://${req.headers.host}`;
}

async function payBalanceHandler(req: Request, res: Response) {
  const token = String(req.params.token ?? "");
  const notice = (kind: NoticeKind, locale: "en" | "es", status = 200) =>
    res.status(status).type("html").send(renderBalanceNotice(kind, locale));

  try {
    // Nuisance guard: the token is secret, but minting Stripe sessions costs us.
    try {
      assertRateLimit("balancePay", requestIp(req), 10, 60_000);
    } catch {
      return res.status(429).type("html").send(renderBalanceNotice("error", "en"));
    }

    const invoice = token ? await db.getInvoiceByPayToken(token) : undefined;
    if (!invoice || invoice.kind !== "balance") return notice("notFound", "en", 404);

    const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    const locale = (booking?.locale as "en" | "es") ?? "en";

    // Stripe sends the customer back here after a successful payment; the
    // webhook may not have landed yet, so never re-open checkout in that case.
    if (req.query.paid !== undefined) return notice("paid", locale);

    const linkState = balanceLinkStatus(invoice);
    if (linkState === "paid") return notice("paid", locale);
    if (linkState !== "sent" || !booking) return notice("expired", locale);

    const customer = await db.getCustomerById(invoice.customerId);
    if (!customer) return notice("error", locale, 500);

    const session = await createBalanceCheckoutSession({
      invoice,
      booking,
      customerEmail: customer.email,
      origin: requestOrigin(req),
    });
    await db.updateInvoice(invoice.id, { stripeSessionId: session.id });
    if (!session.url) return notice("error", locale, 500);
    return res.redirect(303, session.url);
  } catch (error) {
    console.error("[Balance] Payment link handler error:", error);
    return notice("error", "en", 500);
  }
}

export function registerBalanceRoutes(app: Express): void {
  app.get("/api/pay/balance/:token", payBalanceHandler);
}

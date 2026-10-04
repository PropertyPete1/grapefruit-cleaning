/**
 * Customer-facing balance payment link: GET /api/pay/balance/:token
 *
 * A Stripe Checkout Session may live at most 24 hours, so the emailed link
 * points here instead of straight at Stripe. While the invoice's own 7-day
 * window is open this opens the invoice's ONE live session — reopening it on
 * every visit, minting a replacement only after it has expired or its payment
 * failed — and redirects. A bank payment that is processing gets a "your
 * payment is processing" page and no checkout at all; a settled, voided or
 * lapsed link renders a short bilingual notice. See invoiceCheckout.ts for
 * why: minting per visit is how an ACH customer was charged twice.
 *
 * PAY WITH CASH lives next to it: GET /api/pay/balance/:token/cash shows the
 * customer what they would be paying and asks them to confirm; the POST records
 * the choice on the invoice, alerts the owner once, and stops the automatic
 * card reminders. Nothing is charged, and the card link keeps working for a
 * customer who changes their mind.
 *
 * The token (24 random bytes) is the only credential — no session required,
 * exactly like the staff invite links.
 */
import type { Express, Request, Response } from "express";
import { assertRateLimit } from "./antiSpam";
import { balancePayUrl, invoiceFacts, openBalanceCheckout, toInvoiceEmailData } from "./balance";
import { balanceLinkStatus } from "./balanceRules";
import * as db from "./db";
import { sendCashPreferenceAlert, type BalanceEmailData } from "./emails";
import { publicOrigin } from "./publicOrigin";

const BRAND_CORAL = "#F26D5B";
const BRAND_CREAM = "#FDF8F3";

type NoticeKind = "paid" | "processing" | "verifying" | "confirming" | "expired" | "notFound" | "error";

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
  processing: {
    en: {
      title: "Your bank payment is processing",
      body: "Thank you — your bank payment is on its way. Bank payments take a few business days to clear, and we'll email your receipt as soon as it does. There's nothing else to do, and no need to pay again.",
    },
    es: {
      title: "Su pago bancario está en proceso",
      body: "Gracias — su pago bancario ya está en camino. Los pagos bancarios tardan algunos días hábiles en completarse y le enviaremos el recibo por correo en cuanto se acredite. No tiene que hacer nada más ni volver a pagar.",
    },
  },
  // ACH by manually entered account: the debit only starts once the customer
  // confirms Stripe's two microdeposits, so "nothing else to do" would be wrong.
  verifying: {
    en: {
      title: "Almost done — confirm your bank account",
      body: "Thank you! To finish your bank payment, confirm the two small deposits Stripe is sending to your bank account — look for Stripe's email with the link (the deposits take 1–2 business days to show up). Your payment starts as soon as you confirm. There's no need to pay again.",
    },
    es: {
      title: "Casi listo — confirme su cuenta bancaria",
      body: "¡Gracias! Para completar su pago bancario, confirme los dos pequeños depósitos que Stripe está enviando a su cuenta — busque el correo de Stripe con el enlace (los depósitos tardan 1–2 días hábiles en aparecer). Su pago comienza en cuanto confirme. No tiene que volver a pagar.",
    },
  },
  confirming: {
    en: {
      title: "Thank you — we're confirming your payment",
      body: "We haven't seen your payment come through yet. If you completed checkout, your receipt will arrive by email shortly. If you didn't finish, you can return to the payment page from the link in your invoice email.",
    },
    es: {
      title: "Gracias — estamos confirmando su pago",
      body: "Todavía no vemos su pago. Si completó el pago, recibirá el recibo por correo en breve. Si no terminó, puede volver a la página de pago con el enlace del correo de su factura.",
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Whole dollars when the amount is whole, cents otherwise — the way the emails print money. */
function money(amount: number): string {
  return `$${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)} USD`;
}

/** Small branded standalone page, styled like the transactional emails. */
function renderStandalonePage(locale: "en" | "es", title: string, innerHtml: string): string {
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
      ${innerHtml}
    </div>
    <p style="text-align:center;margin-top:20px;font-size:12px;color:#9b918a;">© ${new Date().getFullYear()} Grapefruit Cleaning Co.</p>
  </div>
</body>
</html>`;
}

export function renderBalanceNotice(kind: NoticeKind, locale: "en" | "es"): string {
  const { title, body } = NOTICES[kind][locale];
  return renderStandalonePage(
    locale,
    title,
    `<p style="margin:0;font-size:15px;line-height:1.65;color:#3d3733;">${esc(body)}</p>`
  );
}

const CANCELLED_COPY = {
  en: {
    title: "Your payment wasn't completed",
    body: "No payment was taken. Whenever you're ready, you can go back to the secure payment page.",
    button: "Return to payment",
  },
  es: {
    title: "Su pago no se completó",
    body: "No se realizó ningún cobro. Cuando esté listo, puede volver a la página de pago segura.",
    button: "Volver al pago",
  },
} as const;

/**
 * Where Stripe's Back/cancel lands. A page with a button, never a redirect:
 * the pay link now reopens the invoice's live session, so redirecting from
 * here would bounce the customer straight back into the checkout they just
 * left.
 */
export function renderCancelledPage(locale: "en" | "es", payUrl: string): string {
  const copy = CANCELLED_COPY[locale];
  return renderStandalonePage(
    locale,
    copy.title,
    `<p style="margin:0;font-size:15px;line-height:1.65;color:#3d3733;">${esc(copy.body)}</p>
      <a href="${esc(payUrl)}" style="display:inline-block;margin-top:22px;padding:13px 28px;border-radius:999px;background:${BRAND_CORAL};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">${esc(copy.button)}</a>`
  );
}

const CASH_COPY = {
  en: {
    askTitle: "Pay with cash?",
    chosenTitle: "You're set to pay in cash",
    confirmedTitle: "Got it — cash it is",
    amount: "Amount",
    ask: (amount: string) =>
      `Choose cash and we'll collect ${amount} in person — nothing is charged online, and we'll stop the card reminders. You can still pay by card later if you change your mind.`,
    chosen: (amount: string) =>
      `We have you down to pay ${amount} in cash, in person. There's nothing to do online — and you can still pay by card below if that's easier.`,
    confirmed: (amount: string) =>
      `Thank you! We'll collect ${amount} in cash in person, and we've let our team know. Nothing else to do online — you can still pay by card below any time.`,
    confirmButton: "Yes, I'll pay in cash",
    onlineInstead: "Pay online instead",
    onlineAnytime: "Pay by card instead",
  },
  es: {
    askTitle: "¿Pagar en efectivo?",
    chosenTitle: "Pagará en efectivo",
    confirmedTitle: "Listo — pago en efectivo",
    amount: "Monto",
    ask: (amount: string) =>
      `Elija efectivo y recibiremos ${amount} en persona — no se cobra nada en línea y dejamos de enviar recordatorios de pago con tarjeta. Si cambia de opinión, podrá pagar con tarjeta más adelante.`,
    chosen: (amount: string) =>
      `Tenemos registrado que pagará ${amount} en efectivo, en persona. No tiene que hacer nada en línea — y puede pagar con tarjeta abajo si le resulta más fácil.`,
    confirmed: (amount: string) =>
      `¡Gracias! Recibiremos ${amount} en efectivo en persona y ya avisamos a nuestro equipo. No tiene que hacer nada más en línea — puede pagar con tarjeta abajo en cualquier momento.`,
    confirmButton: "Sí, pagaré en efectivo",
    onlineInstead: "Prefiero pagar en línea",
    onlineAnytime: "Pagar con tarjeta",
  },
} as const;

/**
 * The cash-choice page: the bill by its customer-facing name, the amount, and
 * a real form button so a link preview or a mail scanner following the GET can
 * never choose for the customer — only the POST records anything.
 */
export function renderCashChoicePage(
  locale: "en" | "es",
  data: Pick<BalanceEmailData, "serviceReference" | "serviceName" | "balance" | "payUrl">,
  state: "ask" | "chosen" | "confirmed",
  formAction: string
): string {
  const copy = CASH_COPY[locale];
  const amount = money(data.balance);
  const title = state === "ask" ? copy.askTitle : state === "chosen" ? copy.chosenTitle : copy.confirmedTitle;
  const lede = state === "ask" ? copy.ask(amount) : state === "chosen" ? copy.chosen(amount) : copy.confirmed(amount);
  const linkStyle = `display:inline-block;margin-top:14px;font-size:14px;font-weight:700;color:${BRAND_CORAL};text-decoration:underline;`;
  const body = `
      <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#2E2724;">${esc(data.serviceReference ?? data.serviceName)}</p>
      <p style="margin:0 0 18px;font-size:15px;color:#7a716b;">${esc(copy.amount)}: <strong style="color:#2E2724;">${esc(amount)}</strong></p>
      <p style="margin:0;font-size:15px;line-height:1.65;color:#3d3733;">${esc(lede)}</p>
      ${
        state === "ask"
          ? `<form method="post" action="${esc(formAction)}" style="margin:22px 0 0;">
        <button type="submit" style="display:inline-block;padding:13px 28px;border:0;border-radius:999px;background:${BRAND_CORAL};color:#ffffff;font-size:15px;font-weight:700;cursor:pointer;">${esc(copy.confirmButton)}</button>
      </form>
      <a href="${esc(data.payUrl)}" style="${linkStyle}">${esc(copy.onlineInstead)}</a>`
          : `<a href="${esc(data.payUrl)}" style="${linkStyle}">${esc(copy.onlineAnytime)}</a>`
      }`;
  return renderStandalonePage(locale, title, body);
}

function requestIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * This route is reached by clicking a link in an email, so the browser sends no
 * Origin header — publicOrigin's forwarded-header and PUBLIC_BASE_URL steps are
 * what keep the Stripe return URLs on the public domain rather than the
 * internal one.
 */
function requestOrigin(req: Request): string {
  return publicOrigin(req);
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
    // Any invoice holding this token is payable, balance or manual — the token
    // itself is the credential, and manual invoices are billed on identical
    // terms.
    if (!invoice) return notice("notFound", "en", 404);

    const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    const customerForLocale = await db.getCustomerById(invoice.customerId);
    // A manual invoice has no booking to carry the language, so fall back to
    // the customer's own preference.
    const locale =
      (booking?.locale as "en" | "es") ?? (customerForLocale?.preferredLocale as "en" | "es") ?? "en";

    const origin = requestOrigin(req);
    const customer = customerForLocale;
    const checkoutArgs = {
      invoiceId: invoice.id,
      booking,
      customerEmail: customer?.email ?? "",
      origin,
      locale,
    };

    // Stripe sends the customer back here after checkout. Never re-open
    // checkout from this URL — and never take "?paid" on faith either: a bank
    // payment completes checkout without being paid. Stripe's own record of
    // the session decides which page they see (and settles a card payment the
    // webhook has not delivered yet).
    if (req.query.paid !== undefined) {
      if (invoice.status === "paid") return notice("paid", locale);
      try {
        const look = await openBalanceCheckout({ ...checkoutArgs, mint: false });
        if (look.kind === "paid") return notice("paid", locale);
        if (look.kind === "processing") return notice(look.awaitingVerification ? "verifying" : "processing", locale);
      } catch (error) {
        console.error(`[Balance] Could not read checkout state for invoice ${invoice.id}:`, error);
      }
      return notice("confirming", locale);
    }

    const linkState = balanceLinkStatus(invoice);
    if (linkState === "paid") return notice("paid", locale);
    // Back from Stripe without paying: a page with a way back, not a redirect
    // loop into the same live session.
    if (req.query.cancelled !== undefined && linkState === "sent") {
      return res.type("html").send(renderCancelledPage(locale, balancePayUrl(origin, invoice.payToken ?? token)));
    }
    // "processing" still asks Stripe below — the bank may have answered since.
    // A voided invoice, a lapsed window, or a balance invoice whose booking
    // vanished is not payable; a manual invoice never had a booking and is fine.
    if ((linkState !== "sent" && linkState !== "processing") || (invoice.kind === "balance" && !booking)) {
      return notice("expired", locale);
    }
    if (!customer) return notice("error", locale, 500);

    const checkout = await openBalanceCheckout(checkoutArgs);
    switch (checkout.kind) {
      case "redirect":
        return res.redirect(303, checkout.url);
      case "processing":
        return notice(checkout.awaitingVerification ? "verifying" : "processing", locale);
      case "paid":
        return notice("paid", locale);
      case "closed":
        return notice("expired", locale);
      default:
        // Another visit is opening this invoice's checkout right now.
        return notice("error", locale, 503);
    }
  } catch (error) {
    console.error("[Balance] Payment link handler error:", error);
    return notice("error", "en", 500);
  }
}

/**
 * PAY WITH CASH. GET shows the bill and asks; POST records the choice.
 *
 * Open invoices only: a paid one shows the paid notice and a voided one the
 * expired notice, exactly as the card link would. The choice is claimed once
 * (db.claimInvoiceCashPreference), so the owner hears about it once however
 * many times the button is pressed, and a repeat visit shows the same
 * "you're set" page rather than an error.
 */
async function cashChoiceHandler(req: Request, res: Response) {
  const token = String(req.params.token ?? "");
  const notice = (kind: NoticeKind, locale: "en" | "es", status = 200) =>
    res.status(status).type("html").send(renderBalanceNotice(kind, locale));

  try {
    try {
      assertRateLimit("balancePay", requestIp(req), 10, 60_000);
    } catch {
      return res.status(429).type("html").send(renderBalanceNotice("error", "en"));
    }

    const invoice = token ? await db.getInvoiceByPayToken(token) : undefined;
    if (!invoice) return notice("notFound", "en", 404);

    const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    const customer = await db.getCustomerById(invoice.customerId);
    const locale = (booking?.locale as "en" | "es") ?? (customer?.preferredLocale as "en" | "es") ?? "en";

    if (invoice.status === "paid") return notice("paid", locale);
    if (invoice.status === "void" || (invoice.kind === "balance" && !booking)) return notice("expired", locale);
    // Paid by bank and waiting on it to clear: there is nothing to choose.
    if (invoice.paymentProcessingAt) return notice("processing", locale);
    if (!customer) return notice("error", locale, 500);

    const origin = requestOrigin(req);
    const payUrl = balancePayUrl(origin, invoice.payToken ?? token);
    const data = toInvoiceEmailData(
      booking,
      customer,
      invoiceFacts(invoice),
      payUrl,
      invoice.linkExpiresAt ? new Date(invoice.linkExpiresAt) : new Date(),
      (await db.getSetting("business_phone"))?.trim() || undefined
    );
    const formAction = `${payUrl}/cash`;

    if (req.method === "POST") {
      const claimed = await db.claimInvoiceCashPreference(invoice.id);
      if (claimed) {
        // The owner hears once, on the tap that changed the invoice. A mail
        // problem here must not turn the customer's choice into an error page.
        try {
          await sendCashPreferenceAlert({ ...data, paymentPreference: "cash" });
        } catch (error) {
          console.error(`[Balance] Cash-choice alert failed for invoice ${invoice.id}:`, error);
        }
      }
      return res.type("html").send(renderCashChoicePage(locale, data, "confirmed", formAction));
    }

    const state = invoice.paymentPreference === "cash" ? "chosen" : "ask";
    return res.type("html").send(renderCashChoicePage(locale, data, state, formAction));
  } catch (error) {
    console.error("[Balance] Cash choice handler error:", error);
    return notice("error", "en", 500);
  }
}

export function registerBalanceRoutes(app: Express): void {
  // Express matches `:token` against a single path segment, so the cash routes
  // never collide with the pay route; they are registered first only so the
  // pay handler stays the last one on the app, where existing tooling finds it.
  app.get("/api/pay/balance/:token/cash", cashChoiceHandler);
  app.post("/api/pay/balance/:token/cash", cashChoiceHandler);
  app.get("/api/pay/balance/:token", payBalanceHandler);
}

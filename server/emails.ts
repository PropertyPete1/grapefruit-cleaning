/**
 * Bilingual transactional email content + delivery for Grapefruit Cleaning Co.
 * Emails are professionally written in EN and neutral Latin American Spanish.
 * Delivery: customer emails are sent through Gmail SMTP (nodemailer) using the
 * business Gmail account + app password (GMAIL_USER / GMAIL_APP_PASSWORD).
 * Falls back to server logs when credentials are missing so booking flows
 * never fail because of email issues. Owner notifications additionally use the
 * built-in Manus notification API.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { notifyOwner } from "./_core/notification";
import { renderBrandedEmail, renderBrandedEmailText, type BrandedEmail } from "./emailShell";

export interface BookingEmailData {
  /**
   * Set when this booking came from a deposit link the owner sent by hand.
   * The owner notification then leads with "your link was completed" — the
   * link may have gone out hours ago, and "new booking" would read like a
   * stranger from the website rather than the lead they already spoke to.
   * Lists the facts the customer chose themselves (service, size, time).
   */
  completedLink?: { customerChose: string[] };
  reference: string;
  serviceName: string;
  date: string;
  time: string;
  frequencyLabel: string;
  extras: string[];
  total: number;
  deposit: number;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  address?: string;
  locale: "en" | "es";
  /** Whatever the customer typed at checkout — door codes, access notes. */
  notes?: string;
  /** Live business phone from Admin → Settings; omitted when not configured. */
  bizPhone?: string;
  /**
   * True when a late (expired-recovery) payment confirmed this booking after
   * its slot was retaken — the owner notification must warn about the clash.
   */
  slotConflict?: boolean;
}

const fmtUsd = (n: number) => `$${n.toFixed(0)} USD`;

const BRAND_CORAL = "#F26D5B";
const BRAND_CREAM = "#FDF8F3";

/** Wraps plain-text email body into a branded, email-client-safe HTML template. */
export function wrapEmailHtml(subject: string, body: string): string {
  const paragraphs = body
    .split("\n")
    .map(line => {
      const safe = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      if (safe.trim() === "") return `<div style="height:12px"></div>`;
      const isHeading = /^[A-ZÁÉÍÓÚÑÜ¿¡][A-ZÁÉÍÓÚÑÜ\s¿¡']+$/.test(safe.trim()) && safe.trim().length > 3;
      if (isHeading) {
        return `<p style="margin:0;font-size:12px;font-weight:700;letter-spacing:1.5px;color:${BRAND_CORAL};text-transform:uppercase;">${safe}</p>`;
      }
      return `<p style="margin:0;font-size:15px;line-height:1.65;color:#3d3733;">${safe}</p>`;
    })
    .join("");
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background-color:${BRAND_CREAM};font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <div style="text-align:center;padding-bottom:20px;">
      <p style="margin:0;font-size:22px;font-weight:800;color:${BRAND_CORAL};">Grapefruit Cleaning Co.</p>
    </div>
    <div style="background:#ffffff;border-radius:16px;padding:32px 28px;box-shadow:0 2px 12px rgba(60,40,30,0.06);">
      ${paragraphs}
    </div>
    <p style="text-align:center;margin-top:20px;font-size:12px;color:#9b918a;">© ${new Date().getFullYear()} Grapefruit Cleaning Co. — Premium home & office cleaning</p>
  </div>
</body>
</html>`;
}

let _transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });
  }
  return _transporter;
}

/** Test-only helper to reset the cached transporter. */
export function __resetTransporter(): void {
  _transporter = null;
}

/**
 * Sends an email via Gmail SMTP. Returns true when delivered.
 * Falls back to logging when GMAIL_USER / GMAIL_APP_PASSWORD are not
 * configured so booking flows never fail because of email issues.
 *
 * `html` overrides the generic line-styling wrapper for emails that lay
 * themselves out (see emailShell). `body` is still sent as the text part
 * either way, so every message has a plain-text alternative.
 */
export async function deliverEmail(
  to: string | null | undefined,
  subject: string,
  body: string,
  html?: string
): Promise<boolean> {
  // Phone-only leads exist now: a customer row may have no email at all. One
  // guard here covers every flow — confirmation, reminders, balance, status —
  // so "no address" degrades to "no email goes out" instead of a nodemailer
  // error in whichever flow forgot to check.
  if (!to) {
    console.log(`[Email] Skipped (no address): ${subject}`);
    return false;
  }
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[Email fallback → ${to}] ${subject}\n${body}`);
    return false;
  }
  try {
    await transporter.sendMail({
      from: `Grapefruit Cleaning Co. <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text: body,
      html: html ?? wrapEmailHtml(subject, body),
    });
    console.log(`[Email] Delivered to ${to}: ${subject}`);
    return true;
  } catch (error) {
    console.error(`[Email] Failed to deliver to ${to}:`, error);
    return false;
  }
}

export function buildCustomerConfirmation(data: BookingEmailData): { subject: string; body: string } {
  if (data.locale === "es") {
    return {
      subject: `Su limpieza está confirmada — Reserva ${data.reference} | Grapefruit Cleaning Co.`,
      body: [
        `Hola ${data.customerName},`,
        ``,
        `¡Gracias por reservar con Grapefruit Cleaning Co.! Su cita ha sido confirmada.`,
        ``,
        `DETALLES DE SU RESERVA`,
        `Referencia: ${data.reference}`,
        `Servicio: ${data.serviceName}`,
        `Fecha: ${data.date}`,
        `Hora: ${data.time}`,
        `Frecuencia: ${data.frequencyLabel}`,
        data.extras.length > 0 ? `Extras: ${data.extras.join(", ")}` : `Extras: Ninguno`,
        data.address ? `Dirección: ${data.address}` : ``,
        ``,
        `RESUMEN DE PAGO`,
        `Total estimado: ${fmtUsd(data.total)}`,
        `Depósito pagado hoy: ${fmtUsd(data.deposit)}`,
        `Saldo restante (se paga al completar el servicio): ${fmtUsd(data.total - data.deposit)}`,
        ``,
        `QUÉ SIGUE`,
        `• Le enviaremos un recordatorio 24 horas antes de su cita.`,
        `• Puede reprogramar o cancelar sin costo hasta 24 horas antes.`,
        `• Su equipo de limpieza verificado llegará puntual.`,
        ``,
        data.bizPhone
          ? `¿Preguntas? Responda a este correo o llámenos al ${data.bizPhone}.`
          : `¿Preguntas? Simplemente responda a este correo.`,
        ``,
        `Con aprecio,`,
        `El equipo de Grapefruit Cleaning Co.`,
      ]
        .filter(line => line !== undefined)
        .join("\n"),
    };
  }
  return {
    subject: `Your cleaning is confirmed — Booking ${data.reference} | Grapefruit Cleaning Co.`,
    body: [
      `Hi ${data.customerName},`,
      ``,
      `Thank you for booking with Grapefruit Cleaning Co.! Your appointment is confirmed.`,
      ``,
      `YOUR BOOKING DETAILS`,
      `Reference: ${data.reference}`,
      `Service: ${data.serviceName}`,
      `Date: ${data.date}`,
      `Time: ${data.time}`,
      `Frequency: ${data.frequencyLabel}`,
      data.extras.length > 0 ? `Extras: ${data.extras.join(", ")}` : `Extras: None`,
      data.address ? `Address: ${data.address}` : ``,
      ``,
      `PAYMENT SUMMARY`,
      `Estimated total: ${fmtUsd(data.total)}`,
      `Deposit paid today: ${fmtUsd(data.deposit)}`,
      `Remaining balance (due on completion): ${fmtUsd(data.total - data.deposit)}`,
      ``,
      `WHAT'S NEXT`,
      `• We'll send you a reminder 24 hours before your appointment.`,
      `• You can reschedule or cancel free of charge up to 24 hours ahead.`,
      `• Your vetted cleaning team will arrive right on time.`,
      ``,
      data.bizPhone
        ? `Questions? Reply to this email or call us at ${data.bizPhone}.`
        : `Questions? Just reply to this email.`,
      ``,
      `Warmly,`,
      `The Grapefruit Cleaning Co. Team`,
    ]
      .filter(line => line !== undefined)
      .join("\n"),
  };
}

/** Builds the "your cleaning is coming soon" reminder (7 days or 1 day before). */
export function buildReminderEmail(
  data: BookingEmailData,
  kind: "week" | "day",
): { subject: string; body: string } {
  if (data.locale === "es") {
    const when = kind === "week" ? "en una semana" : "mañana";
    return {
      subject:
        kind === "week"
          ? `Su limpieza se acerca — ${data.date} | Grapefruit Cleaning Co.`
          : `Recordatorio: su limpieza es mañana — ${data.time} | Grapefruit Cleaning Co.`,
      body: [
        `Hola ${data.customerName},`,
        ``,
        kind === "week"
          ? `¡Su limpieza está programada para ${when}! Queremos confirmarle que todo está listo para su cita.`
          : `Este es un recordatorio amistoso: su limpieza es mañana. Su equipo llegará puntual.`,
        ``,
        `DETALLES DE SU CITA`,
        `Referencia: ${data.reference}`,
        `Servicio: ${data.serviceName}`,
        `Fecha: ${data.date}`,
        `Hora: ${data.time}`,
        data.address ? `Dirección: ${data.address}` : ``,
        ``,
        `CÓMO PREPARARSE`,
        `• Recoja objetos personales o de valor para que podamos limpiar a fondo.`,
        `• Asegure el acceso a su hogar (llave, código o alguien presente).`,
        `• Si tiene mascotas, considere ubicarlas en un área cómoda y segura.`,
        ``,
        `Saldo restante a pagar al completar el servicio: ${fmtUsd(data.total - data.deposit)}`,
        ``,
        `¿Necesita reprogramar? ${data.bizPhone ? `Responda a este correo o llámenos al ${data.bizPhone}` : `Responda a este correo`}${kind === "week" ? " — sin costo hasta 24 horas antes de su cita" : ""}.`,
        ``,
        `Con aprecio,`,
        `El equipo de Grapefruit Cleaning Co.`,
      ]
        .filter(line => line !== undefined)
        .join("\n"),
    };
  }
  return {
    subject:
      kind === "week"
        ? `Your cleaning is coming soon — ${data.date} | Grapefruit Cleaning Co.`
        : `Reminder: your cleaning is tomorrow — ${data.time} | Grapefruit Cleaning Co.`,
    body: [
      `Hi ${data.customerName},`,
      ``,
      kind === "week"
        ? `Your cleaning is one week away! We're all set for your upcoming appointment.`
        : `Just a friendly reminder: your cleaning is tomorrow. Your team will arrive right on time.`,
      ``,
      `YOUR APPOINTMENT DETAILS`,
      `Reference: ${data.reference}`,
      `Service: ${data.serviceName}`,
      `Date: ${data.date}`,
      `Time: ${data.time}`,
      data.address ? `Address: ${data.address}` : ``,
      ``,
      `HOW TO PREPARE`,
      `• Pick up personal or valuable items so we can clean thoroughly.`,
      `• Make sure we can access your home (key, code, or someone present).`,
      `• If you have pets, consider settling them in a comfortable, safe area.`,
      ``,
      `Remaining balance due on completion: ${fmtUsd(data.total - data.deposit)}`,
      ``,
      `Need to reschedule? ${data.bizPhone ? `Reply to this email or call us at ${data.bizPhone}` : `Just reply to this email`}${kind === "week" ? " — free of charge up to 24 hours before your appointment" : ""}.`,
      ``,
      `Warmly,`,
      `The Grapefruit Cleaning Co. Team`,
    ]
      .filter(line => line !== undefined)
      .join("\n"),
  };
}

export function buildOwnerNotification(data: BookingEmailData): { title: string; content: string } {
  const headline = data.completedLink
    ? `Deposit link completed ${data.reference} — ${data.serviceName} on ${data.date} at ${data.time}`
    : `New booking ${data.reference} — ${data.serviceName} on ${data.date} at ${data.time}`;
  return {
    title: `${data.slotConflict ? "⚠️ SCHEDULING CONFLICT — " : ""}${headline}`,
    content: [
      ...(data.slotConflict
        ? [
            `⚠️ SCHEDULING CONFLICT: this booking was paid AFTER its checkout expired, and another booking now holds the same date and time. Both customers have paid — please contact one of them to reschedule.`,
            ``,
          ]
        : []),
      ...(data.completedLink
        ? [
            `${data.customerName} finished the booking link you sent and paid their deposit.`,
            ...(data.completedLink.customerChose.length > 0
              ? [`They chose: ${data.completedLink.customerChose.join(", ")}.`]
              : []),
            ``,
          ]
        : []),
      `A new booking was confirmed with a paid deposit.`,
      ``,
      `Reference: ${data.reference}`,
      `Service: ${data.serviceName}`,
      `Date & time: ${data.date} at ${data.time}`,
      `Frequency: ${data.frequencyLabel}`,
      `Extras: ${data.extras.length > 0 ? data.extras.join(", ") : "None"}`,
      ``,
      `Customer: ${data.customerName}`,
      `Email: ${data.customerEmail}`,
      data.customerPhone ? `Phone: ${data.customerPhone}` : ``,
      data.address ? `Address: ${data.address}` : ``,
      // Access instructions belong where the owner reads the booking, not only
      // on the crew's job card.
      ...(data.notes ? [``, `CUSTOMER NOTES`, data.notes] : []),
      ``,
      `Total: ${fmtUsd(data.total)} | Deposit paid: ${fmtUsd(data.deposit)} | Balance due: ${fmtUsd(data.total - data.deposit)}`,
    ]
      .filter(line => line !== undefined)
      .join("\n"),
  };
}

/**
 * Send booking confirmation to the customer via Resend (in their chosen
 * language) and notify the business owner via built-in notifications plus an
 * email copy when OWNER_EMAIL is configured.
 */
export async function sendBookingEmails(data: BookingEmailData): Promise<void> {
  const customerEmail = buildCustomerConfirmation(data);
  await deliverEmail(data.customerEmail, customerEmail.subject, customerEmail.body);

  const ownerNote = buildOwnerNotification(data);
  try {
    await notifyOwner({ title: ownerNote.title, content: ownerNote.content });
  } catch (error) {
    console.error("[Email] Failed to notify owner:", error);
  }
  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail) {
    await deliverEmail(ownerEmail, ownerNote.title, ownerNote.content);
  } else if (process.env.GMAIL_USER) {
    // Default: send the owner copy to the business Gmail inbox itself.
    await deliverEmail(process.env.GMAIL_USER, ownerNote.title, ownerNote.content);
  }
}

export interface BalanceEmailData {
  reference: string;
  invoiceNumber: string;
  serviceName: string;
  /** Date the cleaning was performed (YYYY-MM-DD). */
  date: string;
  total: number;
  deposit: number;
  /** Remaining balance in whole dollars — computed server-side. */
  balance: number;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  address?: string;
  /** Customer-facing payment link (valid for BALANCE_LINK_DAYS). */
  payUrl: string;
  /** Last day the link works (YYYY-MM-DD). */
  expiresOn: string;
  locale: "en" | "es";
  bizPhone?: string;
}

/**
 * "Your cleaning is complete — pay your remaining balance", in the language
 * stored on the booking.
 */
export function buildBalanceDueEmail(data: BalanceEmailData): { subject: string; body: string } {
  if (data.locale === "es") {
    return {
      subject: `Su limpieza está completa — pague su saldo restante | Grapefruit Cleaning Co.`,
      body: [
        `Hola ${data.customerName},`,
        ``,
        `¡Su limpieza está completa! Gracias por confiar en Grapefruit Cleaning Co. Solo queda pagar el saldo restante.`,
        ``,
        `RESUMEN DEL SERVICIO`,
        `Referencia: ${data.reference}`,
        `Factura: ${data.invoiceNumber}`,
        `Servicio: ${data.serviceName}`,
        `Fecha del servicio: ${data.date}`,
        data.address ? `Dirección: ${data.address}` : ``,
        ``,
        `RESUMEN DE PAGO`,
        `Total: ${fmtUsd(data.total)}`,
        `Depósito ya pagado: ${fmtUsd(data.deposit)}`,
        `Saldo restante a pagar: ${fmtUsd(data.balance)}`,
        ``,
        `PAGUE EN LÍNEA`,
        `Puede pagar de forma segura con tarjeta desde este enlace:`,
        `${data.payUrl}`,
        ``,
        `El enlace estará disponible hasta el ${data.expiresOn}. Si prefiere pagar en persona, con gusto lo coordinamos — avísenos y ajustaremos su factura.`,
        ``,
        data.bizPhone
          ? `¿Preguntas? Responda a este correo o llámenos al ${data.bizPhone}.`
          : `¿Preguntas? Simplemente responda a este correo.`,
        ``,
        `Con aprecio,`,
        `El equipo de Grapefruit Cleaning Co.`,
      ]
        .filter(line => line !== undefined)
        .join("\n"),
    };
  }
  return {
    subject: `Your cleaning is complete — pay your remaining balance | Grapefruit Cleaning Co.`,
    body: [
      `Hi ${data.customerName},`,
      ``,
      `Your cleaning is complete! Thank you for trusting Grapefruit Cleaning Co. All that's left is your remaining balance.`,
      ``,
      `SERVICE SUMMARY`,
      `Reference: ${data.reference}`,
      `Invoice: ${data.invoiceNumber}`,
      `Service: ${data.serviceName}`,
      `Service date: ${data.date}`,
      data.address ? `Address: ${data.address}` : ``,
      ``,
      `PAYMENT SUMMARY`,
      `Total: ${fmtUsd(data.total)}`,
      `Deposit already paid: ${fmtUsd(data.deposit)}`,
      `Remaining balance due: ${fmtUsd(data.balance)}`,
      ``,
      `PAY ONLINE`,
      `You can pay securely by card using this link:`,
      `${data.payUrl}`,
      ``,
      `The link stays available through ${data.expiresOn}. If you'd rather pay in person, just let us know and we'll settle your invoice that way.`,
      ``,
      data.bizPhone
        ? `Questions? Reply to this email or call us at ${data.bizPhone}.`
        : `Questions? Just reply to this email.`,
      ``,
      `Warmly,`,
      `The Grapefruit Cleaning Co. Team`,
    ]
      .filter(line => line !== undefined)
      .join("\n"),
  };
}

/** Owner notification for a balance paid online. */
export function buildBalancePaidNotification(data: BalanceEmailData): { title: string; content: string } {
  return {
    title: `Balance paid — ${fmtUsd(data.balance)} for booking ${data.reference} (${data.invoiceNumber})`,
    content: [
      `A customer paid their remaining balance online.`,
      ``,
      `Reference: ${data.reference}`,
      `Invoice: ${data.invoiceNumber}`,
      `Service: ${data.serviceName}`,
      `Service date: ${data.date}`,
      ``,
      `Customer: ${data.customerName}`,
      `Email: ${data.customerEmail}`,
      data.customerPhone ? `Phone: ${data.customerPhone}` : ``,
      data.address ? `Address: ${data.address}` : ``,
      ``,
      `Total: ${fmtUsd(data.total)} | Deposit: ${fmtUsd(data.deposit)} | Balance paid: ${fmtUsd(data.balance)}`,
      `This booking is now paid in full.`,
    ]
      .filter(line => line !== undefined)
      .join("\n"),
  };
}

/**
 * Owner alert for the manual-payment race: the invoice was already settled
 * (collected in person, or paid once already) when a card payment landed.
 * The invoice is NOT double-marked — this money has to be refunded.
 */
export function buildRefundNeededAlert(data: BalanceEmailData): { title: string; content: string } {
  return {
    title: `⚠️ REFUND NEEDED — duplicate balance payment on ${data.invoiceNumber} (${data.reference})`,
    content: [
      `⚠️ A card payment of ${fmtUsd(data.balance)} arrived for an invoice that was ALREADY settled.`,
      `The invoice was left as-is (the earlier payment stands) — please refund this card payment in Stripe.`,
      ``,
      `Reference: ${data.reference}`,
      `Invoice: ${data.invoiceNumber}`,
      `Service: ${data.serviceName}`,
      `Service date: ${data.date}`,
      ``,
      `Customer: ${data.customerName}`,
      `Email: ${data.customerEmail}`,
      data.customerPhone ? `Phone: ${data.customerPhone}` : ``,
      ``,
      `Amount to refund: ${fmtUsd(data.balance)}`,
      `The invoice is flagged "refund needed" in Admin → Invoices until you clear it.`,
    ]
      .filter(line => line !== undefined)
      .join("\n"),
  };
}

/**
 * Owner alert that a completed job's balance is waiting for review. Sent
 * instead of billing the customer, so nothing goes out unchecked — and nothing
 * sits forgotten either.
 */
export function buildBalanceApprovalNeededAlert(data: BalanceEmailData): { title: string; content: string } {
  return {
    title: `Approve balance — ${fmtUsd(data.balance)} for ${data.customerName} (booking ${data.reference})`,
    content: [
      `A cleaning was marked complete. Its remaining balance is ready for your review — nothing has been sent to the customer yet.`,
      ``,
      `Reference: ${data.reference}`,
      `Invoice: ${data.invoiceNumber}`,
      `Service: ${data.serviceName}`,
      `Service date: ${data.date}`,
      data.address ? `Address: ${data.address}` : ``,
      ``,
      `Customer: ${data.customerName}`,
      `Email: ${data.customerEmail}`,
      data.customerPhone ? `Phone: ${data.customerPhone}` : ``,
      ``,
      `Booking total: ${fmtUsd(data.total)}`,
      `Deposit credited: ${fmtUsd(data.deposit)}`,
      `Balance to collect: ${fmtUsd(data.balance)}`,
      ``,
      `Open Admin → Invoices to review and send the payment link. You can adjust the total first if the job turned out bigger or smaller than booked.`,
    ]
      .filter(line => line !== undefined)
      .join("\n"),
  };
}

/** Notifies the owner that a balance needs approving before it can be sent. */
export async function sendBalanceApprovalNeededAlert(data: BalanceEmailData): Promise<void> {
  await notifyOwnerWithEmailCopy(buildBalanceApprovalNeededAlert(data));
}

/** Emails the customer their balance payment link. Returns true when delivered. */
export async function sendBalanceDueEmail(data: BalanceEmailData): Promise<boolean> {
  const email = buildBalanceDueEmail(data);
  return deliverEmail(data.customerEmail, email.subject, email.body);
}

/** Notifies the owner that a balance was paid online (notification + email copy). */
export async function sendBalancePaidNotification(data: BalanceEmailData): Promise<void> {
  await notifyOwnerWithEmailCopy(buildBalancePaidNotification(data));
}

/** Notifies the owner that a duplicate card payment needs refunding. */
export async function sendRefundNeededAlert(data: BalanceEmailData): Promise<void> {
  await notifyOwnerWithEmailCopy(buildRefundNeededAlert(data));
}

/**
 * Owner notification via the built-in notification API plus an email copy to
 * OWNER_EMAIL (falling back to the business Gmail inbox), matching how booking
 * confirmations reach the owner.
 */
async function notifyOwnerWithEmailCopy(note: { title: string; content: string }): Promise<void> {
  try {
    await notifyOwner({ title: note.title, content: note.content });
  } catch (error) {
    console.error("[Email] Failed to notify owner:", error);
  }
  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail) {
    await deliverEmail(ownerEmail, note.title, note.content);
  } else if (process.env.GMAIL_USER) {
    await deliverEmail(process.env.GMAIL_USER, note.title, note.content);
  }
}

/**
 * Everything the two job-status emails need. Deliberately smaller than
 * BookingEmailData: these are told-you-where-we-are notes, not receipts, so
 * they carry no money at all.
 */
export interface JobStatusEmailData {
  reference: string;
  serviceName: string;
  /** Date the cleaning is scheduled for (YYYY-MM-DD). */
  date: string;
  customerName: string;
  customerEmail: string;
  locale: "en" | "es";
  bizPhone?: string;
  /** Public review-form URL; omitted when no public origin is known. */
  reviewUrl?: string;
}

/** "We're here and we've started" — sent when a job moves to in progress. */
export function buildJobStartedEmail(data: JobStatusEmailData): {
  subject: string;
  body: string;
  html: string;
} {
  const spanish = data.locale === "es";
  const email: BrandedEmail = spanish
    ? {
        preheader: `Su equipo de limpieza ya está en su hogar — reserva ${data.reference}.`,
        eyebrow: "Servicio en curso",
        headline: "¡Comenzamos su limpieza! 🍊",
        intro: [
          `Hola ${data.customerName},`,
          `Su equipo de Grapefruit Cleaning Co. ya llegó y está trabajando. Le avisaremos en cuanto todo quede listo.`,
        ],
        detailsTitle: "Detalles del servicio",
        details: [
          { label: "Servicio", value: data.serviceName },
          { label: "Fecha", value: data.date },
          { label: "Referencia", value: data.reference },
        ],
        outro: [
          data.bizPhone
            ? `¿Necesita algo mientras estamos ahí? Llámenos al ${data.bizPhone} o responda a este correo.`
            : `¿Necesita algo mientras estamos ahí? Simplemente responda a este correo.`,
        ],
        signOff: ["Con aprecio,", "El equipo de Grapefruit Cleaning Co."],
        footerNote: data.bizPhone
          ? `Grapefruit Cleaning Co. · ${data.bizPhone}`
          : `Grapefruit Cleaning Co.`,
      }
    : {
        preheader: `Your cleaning crew has arrived and started work — booking ${data.reference}.`,
        eyebrow: "Service in progress",
        headline: "We've started your cleaning! 🍊",
        intro: [
          `Hi ${data.customerName},`,
          `Your Grapefruit Cleaning Co. crew has arrived and is at work. We'll let you know the moment everything is done.`,
        ],
        detailsTitle: "Service details",
        details: [
          { label: "Service", value: data.serviceName },
          { label: "Date", value: data.date },
          { label: "Reference", value: data.reference },
        ],
        outro: [
          data.bizPhone
            ? `Need anything while we're there? Call us at ${data.bizPhone} or just reply to this email.`
            : `Need anything while we're there? Just reply to this email.`,
        ],
        signOff: ["Warmly,", "The Grapefruit Cleaning Co. Team"],
        footerNote: data.bizPhone
          ? `Grapefruit Cleaning Co. · ${data.bizPhone}`
          : `Grapefruit Cleaning Co.`,
      };

  return {
    subject: spanish
      ? `Comenzamos su limpieza — Reserva ${data.reference} | Grapefruit Cleaning Co.`
      : `We've started your cleaning — Booking ${data.reference} | Grapefruit Cleaning Co.`,
    body: renderBrandedEmailText(email),
    html: renderBrandedEmail(email),
  };
}

/**
 * "All done, thank you" — the completion notice for a job with nothing left to
 * collect. Balance-due jobs get their completion news from the approved-balance
 * email instead, so this one never goes to them.
 */
export function buildJobCompleteEmail(data: JobStatusEmailData): {
  subject: string;
  body: string;
  html: string;
} {
  const spanish = data.locale === "es";
  const reviewAsk = data.reviewUrl
    ? {
        text: spanish
          ? "¿Nos ayuda con unas palabras? Su reseña le dice a otras familias qué esperar."
          : "Would you share a few words? Your review tells other families what to expect.",
        ctaLabel: spanish ? "Dejar una reseña" : "Leave a review",
        ctaUrl: data.reviewUrl,
      }
    : undefined;

  const email: BrandedEmail = spanish
    ? {
        preheader: `Su limpieza está completa y pagada por completo — reserva ${data.reference}.`,
        eyebrow: "Servicio completado",
        headline: "Su limpieza está completa — ¡gracias! 🍊",
        intro: [
          `Hola ${data.customerName},`,
          `Terminamos su limpieza y su equipo ya se retiró. Gracias por confiar su hogar a Grapefruit Cleaning Co.`,
          `No queda ningún saldo por pagar — su cuenta está al día.`,
        ],
        detailsTitle: "Resumen del servicio",
        details: [
          { label: "Servicio", value: data.serviceName },
          { label: "Fecha", value: data.date },
          { label: "Referencia", value: data.reference },
        ],
        callout: reviewAsk,
        outro: [
          data.bizPhone
            ? `¿Algo no quedó como esperaba? Llámenos al ${data.bizPhone} o responda a este correo y lo resolvemos.`
            : `¿Algo no quedó como esperaba? Responda a este correo y lo resolvemos.`,
        ],
        signOff: ["Con aprecio,", "El equipo de Grapefruit Cleaning Co."],
        footerNote: data.bizPhone
          ? `Grapefruit Cleaning Co. · ${data.bizPhone}`
          : `Grapefruit Cleaning Co.`,
      }
    : {
        preheader: `Your cleaning is complete and paid in full — booking ${data.reference}.`,
        eyebrow: "Service complete",
        headline: "Your cleaning is complete — thank you! 🍊",
        intro: [
          `Hi ${data.customerName},`,
          `We've finished your cleaning and your crew has headed out. Thank you for trusting your home to Grapefruit Cleaning Co.`,
          `There's no balance left to pay — you're all settled up.`,
        ],
        detailsTitle: "Service summary",
        details: [
          { label: "Service", value: data.serviceName },
          { label: "Date", value: data.date },
          { label: "Reference", value: data.reference },
        ],
        callout: reviewAsk,
        outro: [
          data.bizPhone
            ? `Anything not quite right? Call us at ${data.bizPhone} or reply to this email and we'll make it right.`
            : `Anything not quite right? Reply to this email and we'll make it right.`,
        ],
        signOff: ["Warmly,", "The Grapefruit Cleaning Co. Team"],
        footerNote: data.bizPhone
          ? `Grapefruit Cleaning Co. · ${data.bizPhone}`
          : `Grapefruit Cleaning Co.`,
      };

  return {
    subject: spanish
      ? `Su limpieza está completa — ¡gracias! | Grapefruit Cleaning Co.`
      : `Your cleaning is complete — thank you | Grapefruit Cleaning Co.`,
    body: renderBrandedEmailText(email),
    html: renderBrandedEmail(email),
  };
}

/** Tells the customer their crew has arrived. Returns true when delivered. */
export async function sendJobStartedEmail(data: JobStatusEmailData): Promise<boolean> {
  const email = buildJobStartedEmail(data);
  return deliverEmail(data.customerEmail, email.subject, email.body, email.html);
}

/** Thanks the customer for a job with nothing left to collect. */
export async function sendJobCompleteEmail(data: JobStatusEmailData): Promise<boolean> {
  const email = buildJobCompleteEmail(data);
  return deliverEmail(data.customerEmail, email.subject, email.body, email.html);
}

export interface ContactEmailData {
  name: string;
  email: string;
  phone?: string;
  subject?: string;
  message: string;
  locale: "en" | "es";
}

/** Builds the staff dashboard invitation email for a new team member. */
export function buildStaffInviteEmail(firstName: string, inviteUrl: string): { subject: string; body: string } {
  return {
    subject: `You're invited to the Grapefruit Cleaning Co. team dashboard`,
    body: [
      `Hi ${firstName},`,
      ``,
      `Welcome to the Grapefruit Cleaning Co. team! Your staff dashboard is ready — it's where you'll see your assigned jobs, the daily schedule, customer addresses, and job details.`,
      ``,
      `GET SET UP IN 2 STEPS`,
      `1. Open your personal invite link below.`,
      `2. Sign in (or create an account) — your access is connected automatically.`,
      ``,
      `Your invite link:`,
      `${inviteUrl}`,
      ``,
      `This link is personal to you — please don't share it with anyone.`,
      ``,
      `If you have any questions, just reply to this email.`,
      ``,
      `Warmly,`,
      `Grapefruit Cleaning Co.`,
    ].join("\n"),
  };
}

export async function sendContactNotification(data: ContactEmailData): Promise<void> {
  const contactBody = [
    `From: ${data.name} <${data.email}>`,
    data.phone ? `Phone: ${data.phone}` : ``,
    data.subject ? `Subject: ${data.subject}` : ``,
    `Language: ${data.locale === "es" ? "Spanish" : "English"}`,
    ``,
    data.message,
  ]
    .filter(line => line !== undefined)
    .join("\n");
  try {
    await notifyOwner({
      title: `New contact message from ${data.name}`,
      content: contactBody,
    });
  } catch (error) {
    console.error("[Email] Failed to send contact notification:", error);
  }
  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail) {
    await deliverEmail(ownerEmail, `New contact message from ${data.name}`, contactBody);
  } else if (process.env.GMAIL_USER) {
    await deliverEmail(process.env.GMAIL_USER, `New contact message from ${data.name}`, contactBody);
  }
}

export interface DepositLinkEmailData {
  reference: string;
  /** Absent when the owner left the service for the customer to choose. */
  serviceName?: string;
  /** Scheduled date (YYYY-MM-DD); absent when the customer picks the time. */
  date?: string;
  /** Scheduled start time ("HH:MM"); absent when the customer picks it. */
  time?: string;
  customerName: string;
  customerEmail: string;
  address?: string;
  /**
   * Price before the customer's own extras, in whole dollars. Absent while
   * the booking is missing a fact pricing depends on (service or size) — the
   * email then promises a live price on the page instead of naming one.
   */
  basePrice?: number | null;
  /** Deposit due on the base price — it moves if they add extras. */
  deposit?: number | null;
  /** The personal pay page (/pay/deposit/:token). */
  payUrl: string;
  /** Last day the link works (YYYY-MM-DD). */
  expiresOn: string;
  locale: "en" | "es";
  bizPhone?: string;
}

/**
 * "Your booking is ready — confirm with your deposit."
 *
 * Sent when the owner enters a phone or text lead by hand. Its job is to get
 * the customer onto the pay page, where they choose their own extras — so the
 * price here is named as a starting point rather than a total, and the call to
 * action leads with the choosing, not the paying.
 */
export function buildDepositLinkEmail(data: DepositLinkEmailData): {
  subject: string;
  body: string;
  html: string;
} {
  const spanish = data.locale === "es";
  const priced = data.basePrice != null && data.deposit != null;
  const scheduled = Boolean(data.date && data.time);
  // Rows render only for the facts the owner actually locked; what is missing
  // is exactly what the page will ask for, and promising "$0" or "date TBD"
  // in an email reads like a mistake rather than an invitation.
  const details: { label: string; value: string }[] = spanish
    ? [
        ...(data.serviceName ? [{ label: "Servicio", value: data.serviceName }] : []),
        ...(scheduled
          ? [
              { label: "Fecha", value: data.date! },
              { label: "Hora", value: data.time! },
            ]
          : []),
        ...(data.address ? [{ label: "Dirección", value: data.address }] : []),
        ...(priced
          ? [
              { label: "Precio base", value: fmtUsd(data.basePrice!) },
              { label: "Depósito para confirmar", value: fmtUsd(data.deposit!) },
            ]
          : []),
        { label: "Referencia", value: data.reference },
      ]
    : [
        ...(data.serviceName ? [{ label: "Service", value: data.serviceName }] : []),
        ...(scheduled
          ? [
              { label: "Date", value: data.date! },
              { label: "Time", value: data.time! },
            ]
          : []),
        ...(data.address ? [{ label: "Address", value: data.address }] : []),
        ...(priced
          ? [
              { label: "Base price", value: fmtUsd(data.basePrice!) },
              { label: "Deposit to confirm", value: fmtUsd(data.deposit!) },
            ]
          : []),
        { label: "Reference", value: data.reference },
      ];

  const email: BrandedEmail = spanish
    ? {
        preheader: scheduled
          ? `Su horario está apartado — complete su reserva y pague su depósito.`
          : `Complete su reserva en línea — elija lo que falta y pague su depósito.`,
        eyebrow: "Su reserva está lista",
        headline: scheduled ? "¡Su horario está apartado! 🍊" : "¡Empecemos su reserva! 🍊",
        intro: [
          `Hola ${data.customerName},`,
          `Gracias por comunicarse con nosotros. Preparamos su reserva con lo que conversamos.`,
          scheduled
            ? `Solo falta un paso: abra su enlace, agregue los extras que desee y pague su depósito para confirmar.`
            : `Abra su enlace para completar lo que falta — toma un par de minutos y el precio se muestra al instante.`,
        ],
        detailsTitle: "Su reserva",
        details,
        callout: {
          text: priced
            ? "Elija sus extras y vea su precio actualizarse al instante. Usted decide qué incluir — nosotros nos encargamos del resto."
            : "Complete los detalles a su ritmo y vea su precio en vivo antes de pagar. Sin sorpresas.",
          ctaLabel: scheduled ? "Completar y pagar depósito" : "Completar mi reserva",
          ctaUrl: data.payUrl,
        },
        outro: [
          priced
            ? `El precio base cubre su limpieza tal como la conversamos. Si agrega extras, el total y el depósito se actualizan antes de pagar — sin sorpresas.`
            : `Su precio se calcula mientras elige, y el total y el depósito se muestran antes de pagar — sin sorpresas.`,
          scheduled
            ? `Su horario está apartado hasta el ${data.expiresOn}. Después de esa fecha podríamos ofrecerlo a otra persona.`
            : `Su enlace está disponible hasta el ${data.expiresOn}. Si expira, llámenos y le enviamos uno nuevo.`,
          data.bizPhone
            ? `¿Alguna pregunta? Llámenos al ${data.bizPhone} o responda a este correo.`
            : `¿Alguna pregunta? Simplemente responda a este correo.`,
        ],
        signOff: ["Con aprecio,", "El equipo de Grapefruit Cleaning Co."],
        footerNote: data.bizPhone
          ? `Grapefruit Cleaning Co. · ${data.bizPhone}`
          : `Grapefruit Cleaning Co.`,
      }
    : {
        preheader: scheduled
          ? `Your time is held — finish your booking and pay your deposit.`
          : `Finish your booking online — choose what's missing and pay your deposit.`,
        eyebrow: "Your booking is ready",
        headline: scheduled ? "Your time is held! 🍊" : "Let's get you booked! 🍊",
        intro: [
          `Hi ${data.customerName},`,
          `Thanks for getting in touch. We've set up your booking from what we discussed.`,
          scheduled
            ? `One step left: open your link, add any extras you'd like, and pay your deposit to confirm.`
            : `Open your link to fill in the rest — it takes a couple of minutes, and your price shows up as you go.`,
        ],
        detailsTitle: "Your booking",
        details,
        callout: {
          text: priced
            ? "Pick your extras and watch your price update instantly. You decide what's included — we'll handle the rest."
            : "Finish the details at your own pace and see your live price before you pay. No surprises.",
          ctaLabel: scheduled ? "Finish & pay deposit" : "Finish my booking",
          ctaUrl: data.payUrl,
        },
        outro: [
          priced
            ? `The base price covers your cleaning exactly as we discussed. If you add extras, your total and deposit update before you pay — no surprises.`
            : `Your price is worked out as you choose, and the total and deposit show before you pay — no surprises.`,
          scheduled
            ? `We're holding your time through ${data.expiresOn}. After that we may need to offer it to someone else.`
            : `Your link is good through ${data.expiresOn}. If it expires, just call us and we'll send a fresh one.`,
          data.bizPhone
            ? `Any questions? Call us at ${data.bizPhone} or just reply to this email.`
            : `Any questions? Just reply to this email.`,
        ],
        signOff: ["Warmly,", "The Grapefruit Cleaning Co. Team"],
        footerNote: data.bizPhone
          ? `Grapefruit Cleaning Co. · ${data.bizPhone}`
          : `Grapefruit Cleaning Co.`,
      };

  return {
    subject: spanish
      ? `Su reserva está lista — confirme con su depósito | Grapefruit Cleaning Co.`
      : `Your booking is ready — confirm with your deposit | Grapefruit Cleaning Co.`,
    body: renderBrandedEmailText(email),
    html: renderBrandedEmail(email),
  };
}

/** Sends the deposit link. Returns whether it was delivered. */
export async function sendDepositLinkEmail(data: DepositLinkEmailData): Promise<boolean> {
  const { subject, body, html } = buildDepositLinkEmail(data);
  return deliverEmail(data.customerEmail, subject, body, html);
}

/**
 * Bilingual transactional email content + delivery for Grapefruit Cleaning Co.
 * Emails are professionally written in EN and neutral Latin American Spanish.
 * Delivery: customer emails are sent through SMTP (nodemailer) as the business
 * mailbox — SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD, with the legacy
 * GMAIL_USER / GMAIL_APP_PASSWORD names still honoured for Gmail deployments.
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
/**
 * The SMTP error text from the most recent failed send, so callers (the admin
 * panel) can show what the mail server actually said instead of a generic
 * "couldn't send". Cleared on every successful delivery.
 */
let _lastEmailError: string | null = null;

/** The real SMTP failure text from the last send attempt, if it failed. */
export function lastEmailError(): string | null {
  return _lastEmailError;
}

/**
 * The mailbox this app sends AS — the SMTP login, the From address, and the
 * owner-alert fallback inbox are all the same account.
 *
 * SMTP_USER/SMTP_PASSWORD are the generic names; GMAIL_USER/GMAIL_APP_PASSWORD
 * remain as legacy fallbacks so an existing Gmail deployment keeps working
 * untouched. The provider is decided by SMTP_HOST rather than assumed: this
 * business inbox has already changed hands more than once, so nothing here is
 * allowed to hard-code a particular mail host.
 */
export function smtpUser(): string | undefined {
  return process.env.SMTP_USER || process.env.GMAIL_USER;
}

function smtpPassword(): string | undefined {
  return process.env.SMTP_PASSWORD || process.env.GMAIL_APP_PASSWORD;
}

function getTransporter(): Transporter | null {
  const user = smtpUser();
  const pass = smtpPassword();
  if (!user || !pass) return null;
  if (!_transporter) {
    const host = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
    const port = Number(process.env.SMTP_PORT) || (host === "smtp.gmail.com" ? 465 : 587);
    // Logged so a misconfigured or stale deployment is visible in the runtime
    // logs: this states which mailbox/host the process actually connected as,
    // rather than which one the environment was meant to hold.
    console.log(`[Email] SMTP transport built: ${user} via ${host}:${port} (secure=${port === 465})`);
    _transporter = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; anything else (587 on most providers) is STARTTLS,
      // which nodemailer negotiates when secure is false.
      secure: port === 465,
      auth: { user, pass },
    });
  }
  return _transporter;
}

/** Test-only helper to reset the cached transporter. */
export function __resetTransporter(): void {
  _transporter = null;
  _lastEmailError = null;
}

/**
 * Sends an email via Gmail SMTP. Returns true when delivered.
 * Falls back to logging when no SMTP credentials are configured so booking
 * flows never fail because of email issues.
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
      // Providers routinely reject a From that differs from the SMTP login, so
      // the sender is always the authenticated account itself.
      from: `Grapefruit Cleaning Co. <${smtpUser()}>`,
      to,
      subject,
      text: body,
      html: html ?? wrapEmailHtml(subject, body),
    });
    console.log(`[Email] Delivered to ${to}: ${subject}`);
    _lastEmailError = null;
    return true;
  } catch (error) {
    console.error(`[Email] Failed to deliver to ${to}:`, error);
    const err = error as { code?: string; responseCode?: number; response?: string; message?: string };
    _lastEmailError = (err.response || err.message || "Unknown SMTP error").split("\n")[0].trim();
    // An auth failure usually means the credentials changed under a
    // long-running process (the cached transport still holds the old mailbox).
    // Dropping it forces the next attempt to rebuild from current env.
    if (err.code === "EAUTH" || err.responseCode === 535) {
      console.error("[Email] Auth failure — dropping cached SMTP transport so the next send rebuilds it");
      _transporter = null;
    }
    return false;
  }
}

export function buildCustomerConfirmation(data: BookingEmailData): { subject: string; body: string } {
  // Zero-deposit mode: nothing was paid today, so there is no "deposit paid"
  // line to show — the payment story is simply "due at completion".
  const noDeposit = data.deposit <= 0;
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
        ...(noDeposit
          ? [`No se requiere depósito — el pago se realiza al completar el servicio.`]
          : [
              `Depósito pagado hoy: ${fmtUsd(data.deposit)}`,
              `Saldo restante (se paga al completar el servicio): ${fmtUsd(data.total - data.deposit)}`,
            ]),
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
      ...(noDeposit
        ? [`No deposit required — payment is due at completion.`]
        : [
            `Deposit paid today: ${fmtUsd(data.deposit)}`,
            `Remaining balance (due on completion): ${fmtUsd(data.total - data.deposit)}`,
          ]),
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
  const noDeposit = data.deposit <= 0;
  const headline = data.completedLink
    ? `${noDeposit ? "Booking link completed" : "Deposit link completed"} ${data.reference} — ${data.serviceName} on ${data.date} at ${data.time}`
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
            noDeposit
              ? `${data.customerName} finished the booking link you sent and confirmed their booking (no deposit required).`
              : `${data.customerName} finished the booking link you sent and paid their deposit.`,
            ...(data.completedLink.customerChose.length > 0
              ? [`They chose: ${data.completedLink.customerChose.join(", ")}.`]
              : []),
            ``,
          ]
        : []),
      noDeposit
        ? `A new booking was confirmed. No deposit was required — the full amount is due at completion.`
        : `A new booking was confirmed with a paid deposit.`,
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
      noDeposit
        ? `Total: ${fmtUsd(data.total)} | No deposit — full amount due at completion`
        : `Total: ${fmtUsd(data.total)} | Deposit paid: ${fmtUsd(data.deposit)} | Balance due: ${fmtUsd(data.total - data.deposit)}`,
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
/**
 * Every channel the owner has: the platform notification (best-effort) plus
 * an email to OWNER_EMAIL, falling back to the business Gmail inbox itself.
 * One helper so booking confirmations, unplaceable-clean alerts and feed
 * failures all reach the owner the same way.
 */
export async function sendOwnerAlert(title: string, content: string): Promise<void> {
  try {
    await notifyOwner({ title, content });
  } catch (error) {
    console.error("[Email] Failed to notify owner:", error);
  }
  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail) {
    await deliverEmail(ownerEmail, title, content);
  } else if (smtpUser()) {
    // Default: send the owner copy to the business inbox itself.
    await deliverEmail(smtpUser(), title, content);
  }
}

export async function sendBookingEmails(data: BookingEmailData): Promise<void> {
  const customerEmail = buildCustomerConfirmation(data);
  await deliverEmail(data.customerEmail, customerEmail.subject, customerEmail.body);

  const ownerNote = buildOwnerNotification(data);
  await sendOwnerAlert(ownerNote.title, ownerNote.content);
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

/**
 * Polite follow-up for a balance link that has sat unpaid: first at 3 days,
 * once more at 7. Warmer and shorter than the original — the details were
 * already delivered; this is a nudge with the link, not a second invoice.
 * The link's validity is renewed with each reminder, so the URL always works.
 */
export function buildBalanceReminderEmail(
  data: BalanceEmailData,
  reminderNumber: 1 | 2
): { subject: string; body: string } {
  const lastCall = reminderNumber === 2;
  if (data.locale === "es") {
    return {
      subject: lastCall
        ? `Recordatorio final — saldo pendiente de su limpieza | Grapefruit Cleaning Co.`
        : `Recordatorio amistoso — saldo pendiente de su limpieza | Grapefruit Cleaning Co.`,
      body: [
        `Hola ${data.customerName},`,
        ``,
        lastCall
          ? `Solo un último recordatorio amistoso: el saldo de su limpieza sigue pendiente. Sabemos que la vida se pone ocupada — el enlace de abajo lo resuelve en un minuto.`
          : `Esperamos que esté disfrutando su hogar recién limpio. Solo un recordatorio amistoso: el saldo de su limpieza sigue pendiente.`,
        ``,
        `RESUMEN`,
        `Referencia: ${data.reference}`,
        `Factura: ${data.invoiceNumber}`,
        `Servicio: ${data.serviceName}`,
        `Saldo pendiente: ${fmtUsd(data.balance)}`,
        ``,
        `PAGUE EN LÍNEA`,
        `Puede pagar de forma segura con tarjeta desde este enlace:`,
        `${data.payUrl}`,
        ``,
        `El enlace estará disponible hasta el ${data.expiresOn}. Si ya realizó el pago o prefiere pagarlo en persona, ignore este mensaje o avísenos y con gusto lo ajustamos.`,
        ``,
        data.bizPhone
          ? `¿Preguntas? Responda a este correo o llámenos al ${data.bizPhone}.`
          : `¿Preguntas? Simplemente responda a este correo.`,
        ``,
        `Con aprecio,`,
        `El equipo de Grapefruit Cleaning Co.`,
      ].join("\n"),
    };
  }
  return {
    subject: lastCall
      ? `Final reminder — your cleaning balance is still open | Grapefruit Cleaning Co.`
      : `Friendly reminder — your cleaning balance is still open | Grapefruit Cleaning Co.`,
    body: [
      `Hi ${data.customerName},`,
      ``,
      lastCall
        ? `Just one last friendly nudge: the balance for your cleaning is still open. We know life gets busy — the link below settles it in a minute.`
        : `We hope you're enjoying your freshly cleaned home! Just a friendly reminder that the balance for your cleaning is still open.`,
      ``,
      `SUMMARY`,
      `Reference: ${data.reference}`,
      `Invoice: ${data.invoiceNumber}`,
      `Service: ${data.serviceName}`,
      `Balance due: ${fmtUsd(data.balance)}`,
      ``,
      `PAY ONLINE`,
      `You can pay securely by card using this link:`,
      `${data.payUrl}`,
      ``,
      `The link stays available through ${data.expiresOn}. If you've already paid or would rather settle in person, just ignore this note or let us know and we'll sort it out.`,
      ``,
      data.bizPhone
        ? `Questions? Reply to this email or call us at ${data.bizPhone}.`
        : `Questions? Just reply to this email.`,
      ``,
      `Warmly,`,
      `The Grapefruit Cleaning Co. Team`,
    ].join("\n"),
  };
}

/** Emails one automatic balance reminder. Returns true when delivered. */
export async function sendBalanceReminderEmail(
  data: BalanceEmailData,
  reminderNumber: 1 | 2
): Promise<boolean> {
  const email = buildBalanceReminderEmail(data, reminderNumber);
  return deliverEmail(data.customerEmail, email.subject, email.body);
}

/**
 * The hand-off to the owner: both automatic reminders went out and the balance
 * is still open, so the machine stops emailing the customer and a person takes
 * over. Sent once per sequence.
 */
export function buildBalanceReminderExhaustedAlert(data: BalanceEmailData): { title: string; content: string } {
  return {
    title: `[ACTION NEEDED] Unpaid balance ${data.invoiceNumber} — 2 reminders sent, time for a personal follow-up (${data.reference})`,
    content: [
      `${data.customerName}'s balance of ${fmtUsd(data.balance)} is still unpaid after the original email and two automatic reminders.`,
      `No more automatic emails will be sent — a call or a personal note from you is the next step.`,
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
      `Balance due: ${fmtUsd(data.balance)}`,
      `If they pay in person, mark the invoice paid in Admin → Invoices. Resending the link from there restarts the reminder sequence.`,
    ]
      .filter(line => line !== undefined)
      .join("\n"),
  };
}

/** Alerts the owner that the reminder sequence ran its course unpaid. */
export async function sendBalanceReminderExhaustedAlert(data: BalanceEmailData): Promise<void> {
  await notifyOwnerWithEmailCopy(buildBalanceReminderExhaustedAlert(data));
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
  } else if (smtpUser()) {
    await deliverEmail(smtpUser(), note.title, note.content);
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

// ---------- Tip request (the settled-booking thank-you) ----------

export interface TipEmailData {
  reference: string;
  serviceName: string;
  /** Date the cleaning was performed (YYYY-MM-DD). */
  date: string;
  customerName: string;
  customerEmail: string;
  locale: "en" | "es";
  bizPhone?: string;
  /** Job total in whole dollars — what the presets are computed from. */
  total: number;
  /** Preset options, amounts computed SERVER-side in whole dollars. */
  presets: { percent: number; amount: number }[];
  /** The tip page (/pay/tip/:token). */
  tipUrl: string;
  /** Public review-form URL; omitted when no public origin is known. */
  reviewUrl?: string;
}

/**
 * The thank-you for a completed, fully settled booking — with a warm,
 * no-pressure tip ask for the crew. This email replaces the plain
 * "cleaning complete" note: every settled booking gets exactly one of the two,
 * and from now on it is this one (see claimTipRequestEmail).
 *
 * The buttons carry preset percentages in the URL only as a page hint; every
 * dollar figure is recomputed server-side when the customer actually pays.
 */
export function buildTipRequestEmail(data: TipEmailData): {
  subject: string;
  body: string;
  html: string;
} {
  const spanish = data.locale === "es";
  const presetUrl = (percent: number) => `${data.tipUrl}?p=${percent}`;
  const [first, ...rest] = data.presets;
  const presetLabel = (p: { percent: number; amount: number }) =>
    spanish ? `Dejar ${fmtUsd(p.amount)} (${p.percent}%)` : `Tip ${fmtUsd(p.amount)} (${p.percent}%)`;
  const tipCallout = first
    ? {
        text: spanish
          ? "Si desea dejarle una propina al equipo, aquí puede hacerlo — 100% va para ellos. Completamente opcional, siempre apreciado."
          : "If you'd like to leave the crew a tip, you can do it here — 100% goes to them. Completely optional, always appreciated.",
        ctaLabel: presetLabel(first),
        ctaUrl: presetUrl(first.percent),
        extraCtas: [
          ...rest.map(p => ({ label: presetLabel(p), url: presetUrl(p.percent) })),
          {
            label: spanish ? "Otra cantidad" : "Choose another amount",
            url: `${data.tipUrl}?p=custom`,
          },
        ],
      }
    : undefined;
  const reviewCallout = data.reviewUrl
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
        preheader: `Su limpieza está completa y pagada — reserva ${data.reference}. ¡Gracias!`,
        eyebrow: "Servicio completado",
        headline: "Su limpieza está completa — ¡gracias! 🍊",
        intro: [
          `Hola ${data.customerName},`,
          `Terminamos su limpieza y su cuenta está al día — no queda ningún saldo por pagar. Gracias por confiar su hogar a Grapefruit Cleaning Co.`,
        ],
        detailsTitle: "Resumen del servicio",
        details: [
          { label: "Servicio", value: data.serviceName },
          { label: "Fecha", value: data.date },
          { label: "Referencia", value: data.reference },
        ],
        callout: tipCallout,
        secondaryCallout: reviewCallout,
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
        preheader: `Your cleaning is complete and paid in full — booking ${data.reference}. Thank you!`,
        eyebrow: "Service complete",
        headline: "Your cleaning is complete — thank you! 🍊",
        intro: [
          `Hi ${data.customerName},`,
          `We've finished your cleaning and you're all settled up — there's no balance left to pay. Thank you for trusting your home to Grapefruit Cleaning Co.`,
        ],
        detailsTitle: "Service summary",
        details: [
          { label: "Service", value: data.serviceName },
          { label: "Date", value: data.date },
          { label: "Reference", value: data.reference },
        ],
        callout: tipCallout,
        secondaryCallout: reviewCallout,
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

/** Sends the tip-request thank-you. Returns true when delivered. */
export async function sendTipRequestEmail(data: TipEmailData): Promise<boolean> {
  const email = buildTipRequestEmail(data);
  return deliverEmail(data.customerEmail, email.subject, email.body, email.html);
}

export interface TipPaidData {
  reference: string;
  customerName: string;
  serviceName: string;
  date: string;
  /** The tip, in whole dollars. */
  amount: number;
}

/** The cheerful owner note for a tip landing. */
export function buildTipReceivedNotification(data: TipPaidData): { title: string; content: string } {
  return {
    title: `🎉 Tip received — ${fmtUsd(data.amount)} from ${data.customerName} (booking ${data.reference})`,
    content: [
      `Great news — ${data.customerName} left the crew a ${fmtUsd(data.amount)} tip!`,
      ``,
      `Reference: ${data.reference}`,
      `Service: ${data.serviceName}`,
      `Service date: ${data.date}`,
      ``,
      `It's recorded in Admin → Payments as a tip. Pass it along to the crew — happy customers say it best.`,
    ].join("\n"),
  };
}

/** Notifies the owner that a tip was paid (notification + email copy). */
export async function sendTipReceivedNotification(data: TipPaidData): Promise<void> {
  await notifyOwnerWithEmailCopy(buildTipReceivedNotification(data));
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
  } else if (smtpUser()) {
    await deliverEmail(smtpUser(), `New contact message from ${data.name}`, contactBody);
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
  // Zero-deposit mode: the link ends in a confirm button, not a pay button, so
  // every "pay your deposit" phrase becomes "confirm your booking" and no
  // deposit row is promised.
  const zeroDeposit = priced && data.deposit === 0;
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
              ...(zeroDeposit
                ? [{ label: "Depósito", value: "No se requiere" }]
                : [{ label: "Depósito para confirmar", value: fmtUsd(data.deposit!) }]),
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
              ...(zeroDeposit
                ? [{ label: "Deposit", value: "None required" }]
                : [{ label: "Deposit to confirm", value: fmtUsd(data.deposit!) }]),
            ]
          : []),
        { label: "Reference", value: data.reference },
      ];

  const email: BrandedEmail = spanish
    ? {
        preheader: scheduled
          ? zeroDeposit
            ? `Su horario está apartado — complete y confirme su reserva.`
            : `Su horario está apartado — complete su reserva y pague su depósito.`
          : zeroDeposit
            ? `Complete su reserva en línea — elija lo que falta y confirme.`
            : `Complete su reserva en línea — elija lo que falta y pague su depósito.`,
        eyebrow: "Su reserva está lista",
        headline: scheduled ? "¡Su horario está apartado! 🍊" : "¡Empecemos su reserva! 🍊",
        intro: [
          `Hola ${data.customerName},`,
          `Gracias por comunicarse con nosotros. Preparamos su reserva con lo que conversamos.`,
          scheduled
            ? zeroDeposit
              ? `Solo falta un paso: abra su enlace, agregue los extras que desee y confirme su reserva. No se requiere depósito — el pago se realiza al completar el servicio.`
              : `Solo falta un paso: abra su enlace, agregue los extras que desee y pague su depósito para confirmar.`
            : `Abra su enlace para completar lo que falta — toma un par de minutos y el precio se muestra al instante.`,
        ],
        detailsTitle: "Su reserva",
        details,
        callout: {
          text: priced
            ? "Elija sus extras y vea su precio actualizarse al instante. Usted decide qué incluir — nosotros nos encargamos del resto."
            : "Complete los detalles a su ritmo y vea su precio en vivo antes de pagar. Sin sorpresas.",
          ctaLabel: zeroDeposit
            ? scheduled
              ? "Completar y confirmar"
              : "Completar mi reserva"
            : scheduled
              ? "Completar y pagar depósito"
              : "Completar mi reserva",
          ctaUrl: data.payUrl,
        },
        outro: [
          zeroDeposit
            ? `No se requiere depósito para confirmar. El total se paga al completar el servicio — sin sorpresas.`
            : priced
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
          ? zeroDeposit
            ? `Your time is held — finish and confirm your booking.`
            : `Your time is held — finish your booking and pay your deposit.`
          : zeroDeposit
            ? `Finish your booking online — choose what's missing and confirm.`
            : `Finish your booking online — choose what's missing and pay your deposit.`,
        eyebrow: "Your booking is ready",
        headline: scheduled ? "Your time is held! 🍊" : "Let's get you booked! 🍊",
        intro: [
          `Hi ${data.customerName},`,
          `Thanks for getting in touch. We've set up your booking from what we discussed.`,
          scheduled
            ? zeroDeposit
              ? `One step left: open your link, add any extras you'd like, and confirm your booking. No deposit is required — payment is due at completion.`
              : `One step left: open your link, add any extras you'd like, and pay your deposit to confirm.`
            : `Open your link to fill in the rest — it takes a couple of minutes, and your price shows up as you go.`,
        ],
        detailsTitle: "Your booking",
        details,
        callout: {
          text: priced
            ? "Pick your extras and watch your price update instantly. You decide what's included — we'll handle the rest."
            : "Finish the details at your own pace and see your live price before you pay. No surprises.",
          ctaLabel: zeroDeposit
            ? scheduled
              ? "Finish & confirm"
              : "Finish my booking"
            : scheduled
              ? "Finish & pay deposit"
              : "Finish my booking",
          ctaUrl: data.payUrl,
        },
        outro: [
          zeroDeposit
            ? `No deposit is needed to confirm. Your total is due when the cleaning is complete — no surprises.`
            : priced
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
    subject: zeroDeposit
      ? spanish
        ? `Su reserva está lista — confírmela en línea | Grapefruit Cleaning Co.`
        : `Your booking is ready — confirm it online | Grapefruit Cleaning Co.`
      : spanish
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

// ---------- Connected-property (Airbnb auto-booking) emails ----------

export interface PropertyEmailData {
  label: string;
  address: string;
  customerName: string;
  customerEmail: string | null;
  serviceName: string;
  defaultTime: string;
  reservationCount: number;
  locale: "en" | "es";
  bizPhone?: string;
}

/**
 * The one email a host gets at setup — after this, silence until each clean's
 * balance link, unless they asked for per-clean notices. Hosts running every
 * turnover through us must not get a marketing-sized inbox out of it.
 */
export function buildPropertyConnectedEmail(data: PropertyEmailData): {
  subject: string;
  body: string;
  html: string;
} {
  const spanish = data.locale === "es";
  const email: BrandedEmail = spanish
    ? {
        preheader: `Su calendario está conectado — cada salida se agenda sola.`,
        eyebrow: "Calendario conectado",
        headline: "¡Sus limpiezas ahora son automáticas! 🍊",
        intro: [
          `Hola ${data.customerName},`,
          `Conectamos el calendario de ${data.label}. De ahora en adelante, cada salida de huéspedes se convierte en una limpieza agendada — sin formularios, sin llamadas.`,
        ],
        detailsTitle: "Su propiedad",
        details: [
          { label: "Propiedad", value: data.label },
          { label: "Dirección", value: data.address },
          { label: "Servicio", value: data.serviceName },
          { label: "Hora preferida", value: data.defaultTime },
          { label: "Reservas encontradas", value: String(data.reservationCount) },
        ],
        outro: [
          `Revisamos su calendario cada hora. Después de cada limpieza le llegará su enlace de pago, como siempre.`,
          data.bizPhone
            ? `¿Cambios o preguntas? Llámenos al ${data.bizPhone} o responda a este correo.`
            : `¿Cambios o preguntas? Simplemente responda a este correo.`,
        ],
        signOff: ["Con aprecio,", "El equipo de Grapefruit Cleaning Co."],
        footerNote: data.bizPhone ? `Grapefruit Cleaning Co. · ${data.bizPhone}` : `Grapefruit Cleaning Co.`,
      }
    : {
        preheader: `Your calendar is connected — every checkout books itself.`,
        eyebrow: "Calendar connected",
        headline: "Your cleanings are now automatic! 🍊",
        intro: [
          `Hi ${data.customerName},`,
          `We've connected the calendar for ${data.label}. From here on, every guest checkout becomes a scheduled cleaning — no forms, no calls.`,
        ],
        detailsTitle: "Your property",
        details: [
          { label: "Property", value: data.label },
          { label: "Address", value: data.address },
          { label: "Service", value: data.serviceName },
          { label: "Preferred time", value: data.defaultTime },
          { label: "Reservations found", value: String(data.reservationCount) },
        ],
        outro: [
          `We check your calendar every hour. After each clean you'll get your payment link, same as always.`,
          data.bizPhone
            ? `Changes or questions? Call us at ${data.bizPhone} or just reply to this email.`
            : `Changes or questions? Just reply to this email.`,
        ],
        signOff: ["Warmly,", "The Grapefruit Cleaning Co. Team"],
        footerNote: data.bizPhone ? `Grapefruit Cleaning Co. · ${data.bizPhone}` : `Grapefruit Cleaning Co.`,
      };
  return {
    subject: spanish
      ? `Su calendario está conectado — limpiezas automáticas | Grapefruit Cleaning Co.`
      : `Your calendar is connected — automatic cleanings | Grapefruit Cleaning Co.`,
    body: renderBrandedEmailText(email),
    html: renderBrandedEmail(email),
  };
}

export async function sendPropertyConnectedEmail(data: PropertyEmailData): Promise<boolean> {
  const { subject, body, html } = buildPropertyConnectedEmail(data);
  return deliverEmail(data.customerEmail, subject, body, html);
}

/** [ACTION NEEDED] — a turnover exists that the calendar could not place. */
export function buildUnplacedCleanAlert(args: {
  label: string;
  reference: string;
  checkoutDate: string;
  reason: string;
}): { title: string; content: string } {
  return {
    title: `[ACTION NEEDED] Unscheduled turnover ${args.reference} — ${args.label} checkout ${args.checkoutDate}`,
    content: [
      `A guest checkout on ${args.checkoutDate} at ${args.label} needs a cleaning, but no slot could be placed automatically.`,
      ``,
      `Why: ${args.reason}`,
      ``,
      `The booking exists (${args.reference}) with no time. Open Admin → Appointments and use "Set time" to place it — the turnover is NOT covered until you do.`,
    ].join("\n"),
  };
}

/** The feed has failed enough times in a row that it's a problem, not a blip. */
export function buildFeedFailureAlert(args: {
  label: string;
  failures: number;
  lastError: string;
}): { title: string; content: string } {
  return {
    title: `Airbnb calendar for ${args.label} has stopped syncing`,
    content: [
      `The calendar feed for ${args.label} has failed ${args.failures} times in a row.`,
      ``,
      `Last error: ${args.lastError}`,
      ``,
      `Until it recovers, NEW reservations will not create cleanings. The usual causes: the host regenerated or revoked the calendar link, or the listing was unpublished. Ask them for a fresh iCal URL and update it in Admin → Properties.`,
    ].join("\n"),
  };
}

/** Optional per-clean notice for hosts who asked for one. */
export function buildAutoCleanScheduledEmail(args: {
  label: string;
  date: string;
  time: string | null;
  customerName: string;
  locale: "en" | "es";
}): { subject: string; body: string } {
  const spanish = args.locale === "es";
  const when = args.time ? `${args.date} · ${args.time}` : args.date;
  return spanish
    ? {
        subject: `Limpieza agendada — ${args.label} el ${args.date} | Grapefruit Cleaning Co.`,
        body: `Hola ${args.customerName},\n\nSu calendario marcó una salida y agendamos la limpieza de ${args.label}: ${when}.\n\nNo necesita hacer nada — este es el aviso por limpieza que usted pidió.\n\nEl equipo de Grapefruit Cleaning Co.`,
      }
    : {
        subject: `Cleaning scheduled — ${args.label} on ${args.date} | Grapefruit Cleaning Co.`,
        body: `Hi ${args.customerName},\n\nYour calendar showed a checkout, so we've scheduled the ${args.label} clean: ${when}.\n\nNothing to do — this is the per-clean notice you asked for.\n\nThe Grapefruit Cleaning Co. Team`,
      };
}

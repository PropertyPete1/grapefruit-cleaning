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

export interface BookingEmailData {
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
  /** Live business phone from Admin → Settings; omitted when not configured. */
  bizPhone?: string;
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
 */
export async function deliverEmail(to: string, subject: string, body: string): Promise<boolean> {
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
      html: wrapEmailHtml(subject, body),
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
  return {
    title: `New booking ${data.reference} — ${data.serviceName} on ${data.date} at ${data.time}`,
    content: [
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

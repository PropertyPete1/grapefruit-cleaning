/**
 * Bilingual transactional email content + delivery for Grapefruit Cleaning Co.
 * Emails are professionally written in EN and neutral Latin American Spanish.
 * Delivery: owner notifications use the built-in notification API; customer
 * emails are logged and stored (swap in a real provider like Resend when a
 * production API key is available).
 */
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
}

const fmtUsd = (n: number) => `$${n.toFixed(0)} USD`;

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
        `¿Preguntas? Responda a este correo o llámenos al (555) 472-3384.`,
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
      `Questions? Reply to this email or call us at (555) 472-3384.`,
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
 * Send booking confirmation to the customer (logged; ready to swap in a real
 * email provider) and notify the business owner via built-in notifications.
 */
export async function sendBookingEmails(data: BookingEmailData): Promise<void> {
  const customerEmail = buildCustomerConfirmation(data);
  // Customer email — logged for audit; integrate an SMTP/Resend key to send externally.
  console.log(`[Email → ${data.customerEmail}] ${customerEmail.subject}`);

  const ownerNote = buildOwnerNotification(data);
  try {
    await notifyOwner({ title: ownerNote.title, content: ownerNote.content });
  } catch (error) {
    console.error("[Email] Failed to notify owner:", error);
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

export async function sendContactNotification(data: ContactEmailData): Promise<void> {
  try {
    await notifyOwner({
      title: `New contact message from ${data.name}`,
      content: [
        `From: ${data.name} <${data.email}>`,
        data.phone ? `Phone: ${data.phone}` : ``,
        data.subject ? `Subject: ${data.subject}` : ``,
        `Language: ${data.locale === "es" ? "Spanish" : "English"}`,
        ``,
        data.message,
      ]
        .filter(line => line !== undefined)
        .join("\n"),
    });
  } catch (error) {
    console.error("[Email] Failed to send contact notification:", error);
  }
}

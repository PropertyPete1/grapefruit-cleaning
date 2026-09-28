/**
 * What a payment is CALLED in front of the customer: "Service Type — Service
 * Date", as in "Deep Cleaning — September 28, 2026".
 *
 * Invoice numbers (INV-…) are bookkeeping. A customer reading "Invoice #1048"
 * has to go looking for what it was; "Residential Cleaning — October 3, 2026"
 * tells them. So every customer-facing email, pay page and Stripe line uses
 * this, and the number stays where it belongs: the admin pages and the owner's
 * own alerts.
 *
 * Pure and dependency-free so both the server (emails, Stripe) and the admin
 * client can render the identical string.
 */

export type ReferenceLocale = "en" | "es";

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/**
 * A YYYY-MM-DD date spelled out in the customer's language, with no time-zone
 * arithmetic: the string is read digit by digit, so "2026-09-28" is September
 * 28 wherever the server runs. Anything that is not a full date comes back as
 * given (a legacy row may hold "" or a free-form value).
 */
export function formatServiceDate(date: string | null | undefined, locale: ReferenceLocale): string {
  if (!date) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return date;
  return locale === "es"
    ? `${day} de ${MONTHS_ES[monthIndex]} de ${year}`
    : `${MONTHS_EN[monthIndex]} ${day}, ${year}`;
}

/**
 * "Service Type — Month D, YYYY". Without a date (a manual invoice the owner
 * raised without one) the service name stands alone rather than inventing a
 * day: "Cleaning services" is honest, "Cleaning services — <today>" is not.
 */
export function serviceReference(
  serviceName: string,
  date: string | null | undefined,
  locale: ReferenceLocale
): string {
  const spelled = formatServiceDate(date, locale);
  return spelled ? `${serviceName} — ${spelled}` : serviceName;
}

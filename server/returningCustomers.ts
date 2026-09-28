/**
 * Returning customers, server side: loading what the shared rule needs.
 *
 * The rule itself — normalized email or phone matching a customer with a
 * completed, paid cleaning — lives in shared/returningCustomer.ts, so the
 * booking form's unlock, booking.create's refusal and the review email's
 * "recurring plans are now yours" all read one definition. This file only
 * adds the database: a prefilter on the contact details, then the same
 * in-memory match every other contact lookup uses.
 */
import { isReturningFrom } from "@shared/returningCustomer";
import * as db from "./db";

/**
 * Whether these contact details belong to a returning customer. Blank details
 * belong to nobody, and so does anyone whose email and phone are both new to
 * us — a recurring plan is never granted on a guess.
 */
export async function isReturningCustomer(contact: { email?: string | null; phone?: string | null }): Promise<boolean> {
  if (!contact.email?.trim() && !contact.phone?.trim()) return false;
  const customers = await db.findCustomersByContact(contact);
  if (customers.length === 0) return false;
  const bookings = await db.listCompletedBookingsForCustomers(customers.map(customer => customer.id));
  if (bookings.length === 0) return false;
  const invoices = await db.listInvoiceStatesForBookings(bookings.map(booking => booking.id));
  return isReturningFrom({ contact, customers, bookings, invoices });
}

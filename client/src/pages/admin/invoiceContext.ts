/**
 * What an Admin → Invoices row shows when it is opened: the house and the job
 * behind the invoice, and who it bills.
 *
 * The row used to expand to "Due date —" and "Payment link —", because the list
 * never looked past the invoice table. Pure so the wording can be pinned without
 * a DOM; InvoiceContextPanel only lays these rows out, and every fallback lives
 * here.
 *
 * Keyed on whether a booking came back, never on the invoice kind. Balance
 * invoices always have one and manual invoices raised today never do, but manual
 * invoices from before Aug 19 could carry one — and when a booking exists its
 * property is worth showing whatever created the invoice.
 */
import { composeAddress } from "@shared/property";
import { en } from "@/i18n/translations/en";
import { SERVICE_LABELS, fmtDate } from "./adminShared";

export type InvoiceBookingContext = {
  id: number;
  reference: string;
  status: string;
  serviceType: string | null;
  frequency: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  propertyType: string;
  addressLine: string | null;
  unitNumber: string | null;
  city: string | null;
  zip: string | null;
  sqft: number | null;
  verifiedSqft: number | null;
  bedrooms: number;
  bathrooms: number;
  /** Legacy JSON array of extra ids, read only when there are no add-on snapshots. */
  extras: string | null;
  notes: string | null;
  addons: { nameEn: string; quantity: number }[];
};

export type InvoiceCustomerContext = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
};

export type ContextRow = { label: string; value: string };

export type InvoiceContextView =
  | {
      kind: "booking";
      property: ContextRow[];
      service: ContextRow[];
      customer: ContextRow[];
      notes: string | null;
    }
  | {
      kind: "no_booking";
      heading: string;
      explanation: string;
      customer: ContextRow[];
    };

export type InvoiceContextInput = {
  kind: string;
  booking: InvoiceBookingContext | null;
  customer: InvoiceCustomerContext | null;
};

const NOT_ON_FILE = "Not on file";

const FREQUENCY_LABELS: Record<string, string> = {
  onetime: en.pricing.onetime,
  weekly: en.pricing.weekly,
  biweekly: en.pricing.biweekly,
  monthly: en.pricing.monthly,
};

function sizeLabel(booking: InvoiceBookingContext): string {
  if (booking.verifiedSqft) return `${booking.verifiedSqft.toLocaleString("en-US")} ft² verified`;
  if (booking.sqft != null) return `${booking.sqft.toLocaleString("en-US")} ft²`;
  return "Not recorded";
}

function legacyExtras(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

/** Snapshots first, legacy extras as the fallback — the same order the booking emails use. */
function addonsLabel(booking: InvoiceBookingContext): string {
  if (booking.addons.length > 0) {
    return booking.addons.map(addon => (addon.quantity > 1 ? `${addon.nameEn} ×${addon.quantity}` : addon.nameEn)).join(", ");
  }
  const extras = legacyExtras(booking.extras);
  if (extras.length > 0) return extras.map(id => (en.extras as Record<string, string>)[id] ?? id).join(", ");
  return "None";
}

function customerRows(customer: InvoiceCustomerContext | null, withAddress: boolean): ContextRow[] {
  if (!customer) return [{ label: "Customer", value: "No customer record found" }];
  const rows: ContextRow[] = [
    { label: "Name", value: `${customer.firstName} ${customer.lastName}`.trim() || NOT_ON_FILE },
    { label: "Phone", value: customer.phone?.trim() || NOT_ON_FILE },
    { label: "Email", value: customer.email?.trim() || NOT_ON_FILE },
  ];
  if (withAddress) {
    rows.push({
      label: "Address",
      value: composeAddress({ addressLine: customer.address, city: customer.city, zip: customer.zip }) || "No address on file",
    });
  }
  return rows;
}

export function describeInvoiceContext(invoice: InvoiceContextInput): InvoiceContextView {
  const { booking, customer } = invoice;

  if (!booking) {
    const manual = invoice.kind !== "balance";
    return {
      kind: "no_booking",
      heading: manual ? "No property linked to this invoice" : "Booking no longer available",
      explanation: manual
        ? "This is a manual invoice — it was raised by hand, not from a booking, so there are no house or service details to show. The customer on file is below."
        : "The booking behind this balance invoice is no longer in the system, so its house and service details can't be shown. The customer on file is below.",
      // With no booking, the customer's own address is the only location there is.
      customer: customerRows(customer, true),
    };
  }

  return {
    kind: "booking",
    property: [
      { label: "Address", value: composeAddress(booking) || "No address on the booking" },
      // propertyType defaults to "house" in the schema, so this can't tell a
      // chosen house from an unanswered question — the same limit BookingDetails has.
      { label: "Type", value: booking.propertyType === "apartment" ? "Apartment / Condo" : "House" },
      { label: "Size", value: sizeLabel(booking) },
      { label: "Rooms", value: `${booking.bedrooms} bed · ${booking.bathrooms} bath` },
    ],
    service: [
      {
        label: "Service",
        value: booking.serviceType ? (SERVICE_LABELS[booking.serviceType] ?? booking.serviceType) : "Not chosen",
      },
      { label: "Frequency", value: FREQUENCY_LABELS[booking.frequency] ?? booking.frequency },
      {
        label: "Scheduled",
        value: booking.scheduledDate
          ? `${fmtDate(booking.scheduledDate)}${booking.scheduledTime ? ` · ${booking.scheduledTime}` : ""}`
          : "Not scheduled",
      },
      { label: "Add-ons", value: addonsLabel(booking) },
      { label: "Booking", value: `${booking.reference} · ${booking.status.replace(/_/g, " ")}` },
    ],
    customer: customerRows(customer, false),
    notes: booking.notes?.trim() ? booking.notes : null,
  };
}

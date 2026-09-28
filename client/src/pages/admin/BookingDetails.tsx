/**
 * Everything the owner needs about one booking, organized the way he reads
 * it: WHO first (tap-to-call on a phone), then WHERE, then MONEY — not a wall
 * of rows. Rendered inside the mobile card's Details disclosure and the
 * desktop table's Details dialog, so both views say the same things.
 *
 * Contact fields are editable here at any status — a typo'd email is not a
 * price input, and the fix has to reach the customer record before Resend can
 * reach the customer.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Banknote, Loader2, Mail, Pencil, Phone } from "lucide-react";
import { isAirbnbBooking } from "@shared/bookingStatus";
import { canMarkPaidInCash, type BookingPaymentStatus } from "@shared/paymentStatus";
import { composeAddressOr } from "@shared/property";
import { en } from "@/i18n/translations/en";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GrandfatheredBadge, NotesBlock, PaymentStatusBadge, SERVICE_LABELS, fmtDate, fmtMoney } from "./adminShared";
import { ApplyGrandfatheredRateDialog, type RateSuggestion } from "./ApplyGrandfatheredRateDialog";
import { PaidInCashDialog } from "./PaidInCashDialog";

/** The booking-list row shape this panel reads (admin.bookings output). */
export interface BookingDetailsRow {
  id: number;
  reference: string;
  kind: string;
  status: string;
  serviceType: string | null;
  frequency: string;
  extras: string | null;
  couponCode: string | null;
  discountApplied: number;
  addressLine: string | null;
  unitNumber: string | null;
  propertyType: "house" | "apartment";
  city: string | null;
  zip: string | null;
  sqft: number | null;
  verifiedSqft: number | null;
  totalAmount: number;
  depositAmount: number;
  notes: string | null;
  depositLink: string;
  /** Derived server-side from the booking and its balance invoice. */
  paymentStatus?: BookingPaymentStatus;
  /** "cash" when the customer chose to pay in person. */
  paymentPreference?: string | null;
  /** What Paid in Cash would collect, from the server; null when nothing is collectable yet. */
  balanceDue?: number | null;
  payTokenExpiresAt: Date | string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  customerLocale: "en" | "es";
  /** Set when a grandfathered rate priced this booking instead of the catalog. */
  grandfatheredBaseCents?: number | null;
  grandfatheredCustomerId?: number | null;
  grandfatheredCustomerName?: string | null;
  /** A grandfathered customer this booking probably belongs to but was not priced for. */
  grandfatheredSuggestion?: RateSuggestion | null;
}

/** The statuses whose price can still change — the same set the server enforces. */
const REPRICEABLE = new Set(["pending_deposit", "confirmed", "in_progress"]);

const KIND_LABELS: Record<string, string> = {
  self_serve: "Booked online",
  admin: "Phone lead (deposit link)",
  ical_auto: "Auto · Airbnb calendar",
};

const LINK_LABELS: Record<string, string> = {
  incomplete: "Link out — customer still choosing",
  awaiting_payment: "Link out — awaiting payment",
  paid: "Link paid",
  expired: "Link expired",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-muted/50 p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="mt-1.5 space-y-1.5 text-xs">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

/** Edit dialog for the contact block — the typo'd-email fix. */
function EditContactDialog({ row, onClose }: { row: BookingDetailsRow; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [firstName, ...restName] = row.customerName.split(/\s+/);
  const [first, setFirst] = useState(firstName ?? "");
  const [last, setLast] = useState(restName.join(" "));
  const [email, setEmail] = useState(row.customerEmail ?? "");
  const [phone, setPhone] = useState(row.customerPhone ?? "");
  const [locale, setLocale] = useState<"en" | "es">(row.customerLocale);

  const save = trpc.admin.updateBookingContact.useMutation({
    onSuccess: () => {
      utils.admin.bookings.invalidate();
      utils.admin.customers.invalidate();
      toast.success(
        row.kind === "admin" && row.depositLink !== "paid"
          ? "Contact saved — hit Resend on the link to reach the corrected address"
          : "Contact saved"
      );
      onClose();
    },
    onError: error => toast.error(error.message || "Couldn't save"),
  });

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit contact — {row.reference}</DialogTitle>
          <DialogDescription>
            Fixes the customer record itself, so every booking and email for this person uses the correction.
            Price and schedule are not touched here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-semibold">First name</Label>
              <Input className="mt-1.5 rounded-xl" value={first} onChange={e => setFirst(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs font-semibold">Last name</Label>
              <Input className="mt-1.5 rounded-xl" value={last} onChange={e => setLast(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className="text-xs font-semibold">Email</Label>
            <Input
              type="email"
              className="mt-1.5 rounded-xl"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs font-semibold">Phone</Label>
            <Input type="tel" className="mt-1.5 rounded-xl" value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs font-semibold">Language</Label>
            <select
              className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
              value={locale}
              onChange={e => setLocale(e.target.value as "en" | "es")}
            >
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </div>
          {email.trim() === "" && phone.trim() === "" && (
            <p className="text-xs text-amber-700">Keep at least one way to reach them.</p>
          )}
          <DialogFooter sticky>
            <Button
              className="w-full rounded-xl"
              disabled={save.isPending || first.trim() === "" || (email.trim() === "" && phone.trim() === "")}
              onClick={() =>
                save.mutate({
                  bookingId: row.id,
                  firstName: first.trim(),
                  lastName: last.trim() || undefined,
                  email: email.trim(),
                  phone: phone.trim(),
                  locale,
                })
              }
            >
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save contact
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BookingDetails({ row }: { row: BookingDetailsRow }) {
  const [editing, setEditing] = useState(false);
  const [changingRate, setChangingRate] = useState(false);
  const grandfathered = row.grandfatheredBaseCents != null;
  const canReprice = REPRICEABLE.has(row.status) && row.serviceType != null && row.sqft != null;
  const [payingCash, setPayingCash] = useState(false);
  const airbnb = isAirbnbBooking(row);
  const chosenCash = row.paymentPreference === "cash";
  const extras: string[] = (() => {
    try {
      return JSON.parse(row.extras ?? "[]");
    } catch {
      return [];
    }
  })();
  const extrasLabel =
    extras.length > 0
      ? extras.map(id => (en.extras as Record<string, string>)[id] ?? id).join(", ")
      : "None";
  const linkLine =
    row.kind === "admin" && row.depositLink !== "none" ? (LINK_LABELS[row.depositLink] ?? row.depositLink) : null;

  return (
    <div className="space-y-2">
      <Section title="Customer">
        <Row
          label="Name"
          value={
            <span className="inline-flex items-center gap-1.5">
              {row.customerName || "—"}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-muted-foreground hover:text-foreground"
                title="Edit contact info"
                aria-label="Edit contact info"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </span>
          }
        />
        <Row
          label="Phone"
          value={
            row.customerPhone ? (
              <a href={`tel:${row.customerPhone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 text-primary underline">
                <Phone className="h-3 w-3" /> {row.customerPhone}
              </a>
            ) : (
              "—"
            )
          }
        />
        <Row
          label="Email"
          value={
            row.customerEmail ? (
              <a href={`mailto:${row.customerEmail}`} className="inline-flex items-center gap-1 text-primary underline">
                <Mail className="h-3 w-3" /> {row.customerEmail}
              </a>
            ) : (
              "—"
            )
          }
        />
        <Row label="Language" value={row.customerLocale === "es" ? "Español" : "English"} />
        <Row label="Source" value={KIND_LABELS[row.kind] ?? row.kind} />
        {linkLine && (
          <Row
            label="Deposit link"
            value={
              <>
                {linkLine}
                {row.payTokenExpiresAt && row.depositLink !== "paid" && (
                  <span className="block text-[10px] text-muted-foreground">
                    until {fmtDate(row.payTokenExpiresAt)}
                  </span>
                )}
              </>
            }
          />
        )}
      </Section>

      <Section title="Property">
        <Row
          label="Address"
          value={composeAddressOr(row, "No address yet")}
        />
        <Row
          label="Type"
          value={`${row.propertyType === "apartment" ? "Apartment / Condo" : "House"}${row.unitNumber ? ` · Unit ${row.unitNumber}` : ""}`}
        />
        <Row
          label="Size"
          value={
            row.verifiedSqft
              ? `${row.verifiedSqft.toLocaleString()} ft² verified`
              : row.sqft != null
                ? `${row.sqft.toLocaleString()} ft²`
                : "Customer picks"
          }
        />
        <Row
          label="Service"
          value={row.serviceType ? (SERVICE_LABELS[row.serviceType] ?? row.serviceType) : "Customer picks"}
        />
        <Row label="Extras" value={extrasLabel} />
      </Section>

      <Section title="Money">
        <Row
          label="Rate"
          value={
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
              {grandfathered ? (
                <>
                  <GrandfatheredBadge />
                  <span>
                    {fmtMoney((row.grandfatheredBaseCents ?? 0) / 100)} per cleaning
                    {row.grandfatheredCustomerName && row.grandfatheredCustomerName !== row.customerName
                      ? ` — ${row.grandfatheredCustomerName}'s rate`
                      : ""}
                  </span>
                </>
              ) : (
                <span>Catalog price</span>
              )}
              {canReprice && (
                <button
                  type="button"
                  onClick={() => setChangingRate(true)}
                  className="text-[11px] font-semibold text-primary underline"
                >
                  Change rate
                </button>
              )}
            </span>
          }
        />
        {!grandfathered && row.grandfatheredSuggestion && canReprice && (
          <div
            className="rounded-lg bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-900"
            data-testid="grandfathered-hint"
          >
            {row.grandfatheredSuggestion.reason === "address"
              ? `This address matches ${row.grandfatheredSuggestion.customerName}'s record`
              : row.grandfatheredSuggestion.reason === "contact"
                ? `The contact details match ${row.grandfatheredSuggestion.customerName}'s record`
                : `${row.grandfatheredSuggestion.customerName} has a grandfathered rate`}{" "}
            ({fmtMoney(row.grandfatheredSuggestion.basePrice)} per cleaning) — this booking is at the catalog price.{" "}
            <button type="button" onClick={() => setChangingRate(true)} className="font-semibold underline">
              Apply their rate
            </button>
          </div>
        )}
        {row.paymentStatus && <Row label="Payment" value={<PaymentStatusBadge status={row.paymentStatus} />} />}
        {chosenCash && <Row label="Customer chose" value="Cash — collect in person" />}
        {row.couponCode && (
          <Row label="Coupon" value={`${row.couponCode} (−${fmtMoney(row.discountApplied)})`} />
        )}
        <Row label="Total" value={fmtMoney(row.totalAmount)} />
        {row.depositAmount > 0 ? (
          <>
            <Row
              label="Deposit"
              value={`${fmtMoney(row.depositAmount)}${row.status === "pending_deposit" ? " — not paid yet" : ""}`}
            />
            <Row label="Balance after deposit" value={fmtMoney(row.totalAmount - row.depositAmount)} />
          </>
        ) : (
          <>
            {/* No deposit was ever part of this job: say why, not "$0". */}
            <Row
              label="Deposit"
              value={airbnb ? "None — Airbnb pays in full after the cleaning" : chosenCash ? "None — paying in cash" : "None"}
            />
            <Row label="Due after cleaning" value={fmtMoney(row.totalAmount)} />
          </>
        )}
        {canMarkPaidInCash(row) && (
          <Button
            type="button"
            size="sm"
            className="mt-2 w-full rounded-xl"
            onClick={() => setPayingCash(true)}
            data-testid="paid-in-cash-button"
          >
            <Banknote className="mr-1.5 h-4 w-4" />
            Paid in cash{row.balanceDue != null && row.balanceDue > 0 ? ` — ${fmtMoney(row.balanceDue)}` : ""}
          </Button>
        )}
      </Section>

      {row.notes && <NotesBlock notes={row.notes} />}

      {editing && <EditContactDialog row={row} onClose={() => setEditing(false)} />}
      {payingCash && <PaidInCashDialog booking={row} onClose={() => setPayingCash(false)} />}
      {changingRate && <ApplyGrandfatheredRateDialog row={row} onClose={() => setChangingRate(false)} />}
    </div>
  );
}

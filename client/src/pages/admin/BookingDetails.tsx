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
import { Loader2, Mail, Pencil, Phone } from "lucide-react";
import { composeAddressOr } from "@shared/property";
import { en } from "@/i18n/translations/en";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NotesBlock, SERVICE_LABELS, fmtDate, fmtMoney } from "./adminShared";

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
  payTokenExpiresAt: Date | string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  customerLocale: "en" | "es";
}

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
          {email.trim() === "" && phone.trim() === "" && (
            <p className="text-xs text-amber-700">Keep at least one way to reach them.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BookingDetails({ row }: { row: BookingDetailsRow }) {
  const [editing, setEditing] = useState(false);
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
        {row.couponCode && (
          <Row label="Coupon" value={`${row.couponCode} (−${fmtMoney(row.discountApplied)})`} />
        )}
        <Row label="Total" value={fmtMoney(row.totalAmount)} />
        <Row
          label="Deposit"
          value={`${fmtMoney(row.depositAmount)}${row.status === "pending_deposit" ? " — not paid yet" : ""}`}
        />
        <Row label="Balance after deposit" value={fmtMoney(row.totalAmount - row.depositAmount)} />
      </Section>

      {row.notes && <NotesBlock notes={row.notes} />}

      {editing && <EditContactDialog row={row} onClose={() => setEditing(false)} />}
    </div>
  );
}

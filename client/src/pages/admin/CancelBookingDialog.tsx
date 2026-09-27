/**
 * Admin → Appointments → status → Cancelled.
 *
 * Cancelling used to be one flick of a select with nothing said about what it
 * did. It releases the slot, voids any unpaid balance, and can email the
 * customer — so it asks first, says exactly that, and lets the owner choose
 * whether the customer (or, for a turnover, the host) hears about it and what
 * the note in that email should say.
 *
 * The customer's record and the booking's history are kept: this changes one
 * status, nothing is deleted.
 */
import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SERVICE_LABELS, fmtDate, fmtMoney } from "./adminShared";

/** The admin.bookings row fields the dialog reads — a structural subset. */
export interface CancelDialogBooking {
  id: number;
  reference: string;
  kind: string;
  status: string;
  serviceType: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  customerName: string;
  customerEmail: string | null;
  totalAmount: number;
  depositAmount: number;
}

export function CancelBookingDialog({
  booking,
  pendingBalance,
  pending,
  onClose,
  onConfirm,
}: {
  booking: CancelDialogBooking;
  /** An unpaid balance awaiting approval for this job, when one exists. */
  pendingBalance?: number;
  pending: boolean;
  onClose: () => void;
  onConfirm: (input: { notifyCustomer: boolean; note?: string }) => void;
}) {
  const hasEmail = Boolean(booking.customerEmail);
  const host = booking.kind === "ical_auto";
  const [notifyCustomer, setNotifyCustomer] = useState(hasEmail);
  const [note, setNote] = useState("");

  const when = booking.scheduledDate
    ? `${fmtDate(booking.scheduledDate)}${booking.scheduledTime ? ` · ${booking.scheduledTime}` : " · time to be decided"}`
    : "no time chosen yet";
  const service = booking.serviceType ? (SERVICE_LABELS[booking.serviceType] ?? booking.serviceType) : "Service not chosen";
  const depositCollected = booking.status !== "pending_deposit" && booking.depositAmount > 0;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel booking {booking.reference}?</DialogTitle>
          <DialogDescription>
            The date and time go back on the calendar right away. {booking.customerName || "The customer"}'s record and
            this booking's history are kept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <dl className="space-y-1.5 rounded-xl bg-muted/50 p-3 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Customer</dt>
              <dd className="text-right font-medium text-foreground">{booking.customerName || "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Service</dt>
              <dd className="text-right font-medium text-foreground">{service}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">When</dt>
              <dd className="text-right font-medium text-foreground">{when}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Total</dt>
              <dd className="text-right font-medium text-foreground">{fmtMoney(booking.totalAmount)}</dd>
            </div>
          </dl>

          <ul className="space-y-1.5 text-xs text-muted-foreground">
            {pendingBalance !== undefined && (
              <li className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                The {fmtMoney(pendingBalance)} balance waiting for your approval is voided — nobody is chased for it.
              </li>
            )}
            {pendingBalance === undefined && (
              <li>Any unpaid balance invoice for this job is voided, so no payment reminders go out for it.</li>
            )}
            {depositCollected && (
              <li className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                A {fmtMoney(booking.depositAmount)} deposit was collected. Refunds are handled in Stripe by hand; the email
                only promises a follow-up.
              </li>
            )}
            {booking.status === "pending_deposit" && (
              <li>Any open checkout is closed first. If the deposit already landed, the booking is confirmed instead.</li>
            )}
          </ul>

          <label
            className={`flex items-start gap-2.5 rounded-xl border border-border px-4 py-3 ${hasEmail ? "" : "opacity-60"}`}
          >
            <Checkbox
              checked={notifyCustomer && hasEmail}
              disabled={!hasEmail}
              onCheckedChange={v => setNotifyCustomer(v === true)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-semibold text-foreground">
                {host ? "Email the host that this turnover is cancelled" : `Email ${booking.customerName || "the customer"} a cancellation notice`}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {hasEmail
                  ? host
                    ? `Bilingual, in the host's language, to ${booking.customerEmail}. Their calendar stays connected.`
                    : `Bilingual, in their language, to ${booking.customerEmail}. Says the cleaning is off and nothing will be charged.`
                  : "No email on file — let them know by phone or text."}
              </span>
            </span>
          </label>

          {notifyCustomer && hasEmail && (
            <div>
              <Label htmlFor="cancel-note" className="text-xs font-semibold">
                Add a short note to the email <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="cancel-note"
                className="mt-1.5 rounded-xl"
                rows={2}
                maxLength={500}
                placeholder="e.g. Our crew is out sick this week — we'd love to rebook you."
                value={note}
                onChange={e => setNote(e.target.value)}
              />
            </div>
          )}

          <DialogFooter sticky>
            <Button variant="outline" className="rounded-xl" onClick={onClose} disabled={pending}>
              Keep booking
            </Button>
            <Button
              variant="destructive"
              className="rounded-xl"
              disabled={pending}
              onClick={() =>
                onConfirm({ notifyCustomer: notifyCustomer && hasEmail, note: note.trim() || undefined })
              }
            >
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Cancel booking
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

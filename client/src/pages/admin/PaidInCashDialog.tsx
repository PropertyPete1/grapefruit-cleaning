/**
 * Paid in Cash — the owner's one tap after a cleaning that was paid in person.
 *
 * Shows what will be recorded and nothing to type that could go wrong: the
 * amount is the job's own outstanding balance (the server settles the invoice
 * at its exact figure), the date defaults to today, a tip is optional, and the
 * receipt goes out unless unticked. Behind it is the same offline settlement
 * Admin → Invoices uses — one system, two doors.
 */
import { useState } from "react";
import { Banknote, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { BookingPaymentStatus } from "@shared/paymentStatus";
import { trpc } from "@/lib/trpc";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fmtMoney } from "./adminShared";

export interface PaidInCashBooking {
  id: number;
  reference: string;
  customerName: string;
  customerEmail: string | null;
  totalAmount: number;
  /** What Paid in Cash will settle, from the server; null when unknown. */
  balanceDue?: number | null;
  paymentStatus?: BookingPaymentStatus;
  paymentPreference?: string | null;
}

function localDateInputValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function PaidInCashDialog({ booking, onClose }: { booking: PaidInCashBooking; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [tipAmount, setTipAmount] = useState("0");
  const [receivedOn, setReceivedOn] = useState(localDateInputValue);
  const [note, setNote] = useState("");
  const [emailReceipt, setEmailReceipt] = useState(Boolean(booking.customerEmail));

  const mark = trpc.admin.markPaidInCash.useMutation({
    onSuccess: result => {
      utils.admin.bookings.invalidate();
      utils.admin.invoices.invalidate();
      utils.admin.awaitingApprovalInvoices.invalidate();
      utils.admin.payments.invalidate();
      utils.admin.stats.invalidate();
      utils.admin.monthlyRevenue.invalidate();
      toast.success(
        result.nothingDue
          ? "Nothing left to collect — this job was already covered"
          : [
              `Paid in cash — ${fmtMoney(result.amount)} recorded`,
              result.tipAmount > 0 ? `${fmtMoney(result.tipAmount)} tip` : null,
              result.receiptSent ? "receipt emailed" : null,
            ]
              .filter(Boolean)
              .join(" · ")
      );
      onClose();
    },
    onError: error => toast.error(error.message || "Couldn't record the cash payment"),
  });

  const parsedTip = Number(tipAmount || 0);
  const tipValid = Number.isFinite(parsedTip) && parsedTip >= 0;
  const amount = booking.balanceDue;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="rounded-2xl sm:max-w-md" data-testid="paid-in-cash-dialog">
        <DialogHeader>
          <DialogTitle>Paid in cash — {booking.reference}</DialogTitle>
          <DialogDescription>
            Records the money as received in cash, marks the invoice paid, and leaves a $0 balance. Nothing to edit
            by hand.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-xl bg-muted/60 p-3 text-sm">
            <p className="font-semibold text-foreground">{booking.customerName || "Customer"}</p>
            <p className="text-muted-foreground">
              {amount != null && amount > 0
                ? `Collecting ${fmtMoney(amount)} in cash`
                : amount === 0
                  ? "Nothing outstanding on this job"
                  : `Collecting the outstanding balance in cash (job total ${fmtMoney(booking.totalAmount)})`}
            </p>
            {booking.paymentPreference === "cash" && (
              <p className="mt-1 text-xs text-lime-800">The customer chose cash when they booked.</p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="cash-tip">Tip received (optional)</Label>
              <Input
                id="cash-tip"
                type="number"
                min="0"
                step="0.01"
                className="mt-1.5 rounded-xl"
                value={tipAmount}
                onChange={event => setTipAmount(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cash-date">Date received</Label>
              <Input
                id="cash-date"
                type="date"
                className="mt-1.5 rounded-xl"
                value={receivedOn}
                onChange={event => setReceivedOn(event.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="cash-note">Note (optional)</Label>
            <Textarea
              id="cash-note"
              maxLength={1000}
              className="mt-1.5 rounded-xl"
              placeholder="Who collected it, anything worth remembering"
              value={note}
              onChange={event => setNote(event.target.value)}
            />
          </div>
          <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
            <Checkbox
              checked={emailReceipt}
              disabled={!booking.customerEmail}
              onCheckedChange={checked => setEmailReceipt(checked === true)}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">Email receipt to customer</span>
              <span className="block text-xs text-muted-foreground">
                {booking.customerEmail ? `Goes to ${booking.customerEmail}.` : "No email on file — no receipt can be sent."}
              </span>
            </span>
          </label>
          <DialogFooter sticky>
            <Button
              className="w-full rounded-xl"
              disabled={mark.isPending || !tipValid || !receivedOn}
              onClick={() =>
                mark.mutate({
                  bookingId: booking.id,
                  tipAmount: parsedTip,
                  receivedOn,
                  note: note.trim() || undefined,
                  emailReceipt,
                })
              }
            >
              {mark.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Banknote className="mr-1.5 h-4 w-4" />
              )}
              {mark.isPending
                ? "Recording…"
                : amount != null && amount > 0
                  ? `Paid in cash — ${fmtMoney(amount + (tipValid ? parsedTip : 0))}`
                  : "Paid in cash"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

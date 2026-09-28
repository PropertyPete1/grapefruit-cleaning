/**
 * Setting one customer's grandfathered price — the original client who keeps
 * her old rate while the catalog moves on.
 *
 * The dialog leads with what she has actually been paying: her completed
 * bookings, most recent first, with the per-visit figure each one came to
 * (extras taken back out where the exact snapshot exists). The rate field is
 * prefilled from the latest of them, so confirming her price is a matter of
 * reading the history and pressing Save — not remembering a number. The owner
 * confirms; the dialog never sets a rate on its own.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { CLEANING_TYPES, type CleaningType } from "@shared/pricing";
import { paidPerVisitCents } from "@shared/priceLock";
import { completedHistory, suggestedRate, type HistoryBooking } from "./grandfathered";
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
import { SERVICE_LABELS, fmtDate, fmtMoney } from "./adminShared";

export interface GrandfatheredCustomer {
  id: number;
  firstName: string;
  lastName: string;
  grandfatheredPriceCents: number | null;
  grandfatheredServiceType: string | null;
  grandfatheredNote: string | null;
  grandfatheredAt: Date | string | null;
}

const FREQUENCY_LABELS: Record<string, string> = {
  onetime: "one-time",
  weekly: "weekly",
  biweekly: "every two weeks",
  monthly: "monthly",
};

export function GrandfatheredPriceDialog({
  customer,
  bookings,
  onClose,
}: {
  customer: GrandfatheredCustomer;
  bookings: readonly HistoryBooking[];
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const history = completedHistory(bookings);
  const suggestion = suggestedRate(customer, history);
  const [price, setPrice] = useState(suggestion.price);
  const [serviceType, setServiceType] = useState<CleaningType>(suggestion.serviceType);
  const [note, setNote] = useState(customer.grandfatheredNote ?? "");
  const hasRate = customer.grandfatheredPriceCents != null;
  const name = `${customer.firstName} ${customer.lastName}`.trim();

  const refresh = () => {
    utils.admin.customers.invalidate();
    utils.admin.customerDetail.invalidate();
    utils.admin.grandfatheredCustomers.invalidate();
    utils.admin.bookings.invalidate();
  };
  const save = trpc.admin.setGrandfatheredPrice.useMutation({
    onSuccess: result => {
      refresh();
      toast.success(
        result.lock
          ? `${name} keeps ${fmtMoney(result.lock.price)} per ${SERVICE_LABELS[result.lock.serviceType] ?? result.lock.serviceType} cleaning`
          : `${name} now pays the catalog price`
      );
      onClose();
    },
    onError: error => toast.error(error.message || "Couldn't save the price"),
  });

  const parsed = Number(price);
  const priceValid = price.trim() !== "" && Number.isFinite(parsed) && parsed > 0;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="rounded-2xl sm:max-w-lg" data-testid="grandfathered-dialog">
        <DialogHeader>
          <DialogTitle>Grandfathered price — {name}</DialogTitle>
          <DialogDescription>
            Their whole per-cleaning price for one service, before extras. It applies only to this customer — matched
            by email or phone when they book — and never to anyone else. Recurring discounts don't stack on it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl bg-muted/50 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">What they've been paying</p>
            {history.length === 0 ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                No completed cleanings on record yet — enter the price by hand.
              </p>
            ) : (
              <>
                <p className="mt-1.5 text-xs text-foreground" data-testid="latest-paid">
                  Last completed cleaning:{" "}
                  <span className="font-semibold">
                    {history[0].serviceType ? (SERVICE_LABELS[history[0].serviceType] ?? history[0].serviceType) : "Cleaning"} on{" "}
                    {fmtDate(history[0].scheduledDate)} — {fmtMoney(paidPerVisitCents(history[0]) / 100)}
                  </span>
                  {history[0].addonsAmountCents ? ` before ${fmtMoney(history[0].addonsAmountCents / 100)} of extras` : ""}
                  {` (${FREQUENCY_LABELS[history[0].frequency] ?? history[0].frequency})`}.
                </p>
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
                  {history.slice(0, 8).map(b => (
                    <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg bg-card px-2.5 py-1.5">
                      {/* Wraps rather than truncates: a nowrap row would set the dialog's width on a phone. */}
                      <span className="min-w-0 break-words text-muted-foreground">
                        {fmtDate(b.scheduledDate)} · {b.serviceType ? (SERVICE_LABELS[b.serviceType] ?? b.serviceType) : "—"}
                        {b.sqft != null ? ` · ${b.sqft.toLocaleString()} ft²` : ""}
                        {` · ${FREQUENCY_LABELS[b.frequency] ?? b.frequency}`}
                      </span>
                      <span className="shrink-0 font-semibold text-foreground">
                        {fmtMoney(paidPerVisitCents(b) / 100)}
                        {b.grandfatheredBaseCents != null ? " ★" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Per-visit price with that visit's extras taken out. ★ already at a grandfathered rate.
                </p>
              </>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs font-semibold" htmlFor="gf-service">
                Service
              </Label>
              <select
                id="gf-service"
                className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                value={serviceType}
                onChange={e => setServiceType(e.target.value as CleaningType)}
              >
                {CLEANING_TYPES.map(type => (
                  <option key={type} value={type}>
                    {SERVICE_LABELS[type] ?? type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs font-semibold" htmlFor="gf-price">
                Price per cleaning
              </Label>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  id="gf-price"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  step="0.01"
                  className="h-10 rounded-xl pl-7 text-right font-semibold"
                  value={price}
                  onChange={e => setPrice(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div>
            <Label className="text-xs font-semibold" htmlFor="gf-note">
              Note (optional)
            </Label>
            <Input
              id="gf-note"
              className="mt-1.5 rounded-xl"
              placeholder="e.g. Original client since 2019"
              value={note}
              maxLength={500}
              onChange={e => setNote(e.target.value)}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Bookings already on the calendar keep their price — open one from Appointments and use{" "}
            <span className="font-medium text-foreground">Change rate</span> to re-price it. Extras still add on top of
            this figure; a coupon still applies.
          </p>

          <DialogFooter sticky className="gap-2 sm:justify-between">
            {hasRate ? (
              <Button
                variant="outline"
                className="rounded-xl text-destructive hover:text-destructive"
                disabled={save.isPending}
                onClick={() => save.mutate({ customerId: customer.id, price: null })}
              >
                Remove rate — back to catalog
              </Button>
            ) : (
              <span />
            )}
            <Button
              className="rounded-xl"
              disabled={save.isPending || !priceValid}
              onClick={() =>
                save.mutate({
                  customerId: customer.id,
                  price: Math.round(parsed * 100) / 100,
                  serviceType,
                  note: note.trim() || undefined,
                })
              }
            >
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {hasRate ? "Save rate" : `Set ${priceValid ? fmtMoney(Math.round(parsed * 100) / 100) : "price"} as their rate`}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

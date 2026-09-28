/**
 * The manual fallback for grandfathered pricing: re-price ONE booking at a
 * chosen customer's locked rate — for the original client who booked under a
 * different email or phone, or whose rate was set after she booked — or back
 * at the catalog. Nothing here touches the customer record or any other
 * booking; the choice is recorded on this booking alone.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
import { SERVICE_LABELS, fmtMoney } from "./adminShared";

export interface RateSuggestion {
  customerId: number;
  customerName: string;
  basePrice: number;
  reason: "same_customer" | "contact" | "address";
}

const REASON_TEXT: Record<RateSuggestion["reason"], string> = {
  same_customer: "this is their own record",
  contact: "same email or phone",
  address: "same service address",
};

export function ApplyGrandfatheredRateDialog({
  row,
  onClose,
}: {
  row: {
    id: number;
    reference: string;
    serviceType: string | null;
    totalAmount: number;
    grandfatheredCustomerId?: number | null;
    grandfatheredSuggestion?: RateSuggestion | null;
  };
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const customers = trpc.admin.grandfatheredCustomers.useQuery();
  const [choice, setChoice] = useState<number | null>(
    row.grandfatheredCustomerId ?? row.grandfatheredSuggestion?.customerId ?? null
  );
  const reprice = trpc.admin.repriceBooking.useMutation({
    onSuccess: result => {
      utils.admin.bookings.invalidate();
      utils.admin.customerDetail.invalidate();
      toast.success(
        result.grandfathered
          ? `${row.reference} re-priced at ${result.grandfathered.customerName}'s grandfathered rate — total ${fmtMoney(result.total)}${result.depositKept ? " (deposit already paid stays as is)" : ""}`
          : `${row.reference} re-priced at the catalog — total ${fmtMoney(result.total)}`
      );
      onClose();
    },
    onError: error => toast.error(error.message || "Couldn't re-price this booking"),
  });

  const serviceLabel = row.serviceType ? (SERVICE_LABELS[row.serviceType] ?? row.serviceType) : "this service";
  const options = customers.data ?? [];

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="rounded-2xl sm:max-w-md" data-testid="apply-rate-dialog">
        <DialogHeader>
          <DialogTitle>Change rate — {row.reference}</DialogTitle>
          <DialogDescription>
            Re-price this one booking at a customer's grandfathered rate, or back at the catalog. Extras and any coupon
            stay as they are; a deposit already paid stays paid.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {row.grandfatheredSuggestion && (
            <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900" data-testid="rate-suggestion">
              Looks like <span className="font-semibold">{row.grandfatheredSuggestion.customerName}</span> —{" "}
              {REASON_TEXT[row.grandfatheredSuggestion.reason]}. Their grandfathered rate is{" "}
              {fmtMoney(row.grandfatheredSuggestion.basePrice)} per cleaning.
            </p>
          )}
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 text-sm ${
              choice === null ? "border-primary bg-primary/5" : "border-border"
            }`}
          >
            <input
              type="radio"
              name="rate"
              className="mt-0.5 accent-primary"
              checked={choice === null}
              onChange={() => setChoice(null)}
            />
            <span>
              <span className="font-semibold text-foreground">Catalog price</span>
              <span className="block text-xs text-muted-foreground">The current tier table for {serviceLabel}.</span>
            </span>
          </label>
          {customers.isLoading ? (
            <p className="px-1 text-xs text-muted-foreground">Loading grandfathered customers…</p>
          ) : options.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              No customer has a grandfathered price yet — set one from their record under Customers.
            </p>
          ) : (
            options.map(customer => {
              const applies = customer.serviceType === row.serviceType;
              return (
                <label
                  key={customer.id}
                  className={`flex items-start gap-3 rounded-xl border-2 p-3 text-sm ${
                    !applies ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                  } ${choice === customer.id ? "border-primary bg-primary/5" : "border-border"}`}
                >
                  <input
                    type="radio"
                    name="rate"
                    className="mt-0.5 accent-primary"
                    disabled={!applies}
                    checked={choice === customer.id}
                    onChange={() => setChoice(customer.id)}
                  />
                  <span className="min-w-0">
                    <span className="font-semibold text-foreground">{customer.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {fmtMoney(customer.price)} per {SERVICE_LABELS[customer.serviceType] ?? customer.serviceType} cleaning
                      {applies ? "" : ` — not for ${serviceLabel}`}
                    </span>
                    <span className="block break-words text-[11px] text-muted-foreground">
                      {[customer.email, customer.phone].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </label>
              );
            })
          )}
        </div>

        <DialogFooter sticky>
          <Button
            className="w-full rounded-xl"
            disabled={reprice.isPending || (row.grandfatheredCustomerId ?? null) === choice}
            onClick={() => reprice.mutate({ bookingId: row.id, grandfatheredCustomerId: choice })}
          >
            {reprice.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {choice === null ? "Re-price at the catalog" : "Apply grandfathered rate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

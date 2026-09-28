/**
 * Admin → Invoices: the customer behind a bill, popped out.
 *
 * Tap the customer's name on any invoice row and this opens with who they are
 * — contact details, language, recent bookings — and the two facts that name
 * the bill on every email and on the pay page: the service type and the
 * service date. Both are editable here, after the fact, because a manual
 * invoice is often created before anyone knows exactly which visit it is for.
 * Nothing about money lives in this dialog.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { CLEANING_TYPES } from "@shared/pricing";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SERVICE_LABELS, StatusBadge, fmtDate, fmtMoney } from "./adminShared";

/** What the invoices list already carries about a row — enough to open on, before the detail query lands. */
export interface InvoiceCustomerTarget {
  id: number;
  number: string;
  customerId: number;
  serviceType: string | null;
  serviceDate: string | null;
  customer?: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    zip: string | null;
    /** The list carries no language; the detail query fills it in. */
    preferredLocale?: string | null;
  } | null;
}

/** The "no service type" choice — a Select item cannot carry an empty value. */
const NONE = "none";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function InvoiceCustomerDialog({
  invoice,
  onClose,
}: {
  invoice: InvoiceCustomerTarget | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const detail = trpc.admin.customerDetail.useQuery(
    { id: invoice?.customerId ?? 0 },
    { enabled: invoice !== null }
  );
  const [serviceType, setServiceType] = useState<string>("");
  const [serviceDate, setServiceDate] = useState("");
  // Re-seed the form for each invoice opened; edits never leak between rows.
  useEffect(() => {
    setServiceType(invoice?.serviceType ?? "");
    setServiceDate(invoice?.serviceDate ?? "");
  }, [invoice?.id, invoice?.serviceType, invoice?.serviceDate]);

  const save = trpc.admin.updateInvoiceReference.useMutation({
    onSuccess: () => {
      utils.admin.invoices.invalidate();
      toast.success("Invoice updated — the customer's emails and pay page use the new name");
      onClose();
    },
    onError: e => toast.error(e.message || "Failed to update the invoice"),
  });

  const customer = detail.data?.customer ?? invoice?.customer ?? null;
  const bookings = (detail.data?.bookings ?? []).slice(0, 5);
  const dirty = invoice
    ? serviceType !== (invoice.serviceType ?? "") || serviceDate !== (invoice.serviceDate ?? "")
    : false;

  return (
    <Dialog open={invoice !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="rounded-2xl sm:max-w-md" data-testid="invoice-customer-dialog">
        <DialogHeader>
          <DialogTitle>{customer ? `${customer.firstName} ${customer.lastName}`.trim() : "Customer"}</DialogTitle>
          <DialogDescription>
            Invoice {invoice?.number} — the customer on this bill, and what the bill is called.
          </DialogDescription>
        </DialogHeader>
        {invoice && (
          <div className="space-y-4">
            <section className="rounded-xl bg-muted/50 p-3 text-sm" data-testid="invoice-customer-contact">
              <dl className="space-y-1.5">
                <Row label="Email" value={customer?.email || "—"} />
                <Row label="Phone" value={customer?.phone || "—"} />
                <Row
                  label="Address"
                  value={[customer?.address, customer?.city, customer?.zip].filter(Boolean).join(", ") || "—"}
                />
                <Row label="Language" value={customer?.preferredLocale === "es" ? "Español" : "English"} />
              </dl>
            </section>

            <section className="space-y-3 rounded-xl border border-border p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">On the invoice</p>
              <div>
                <Label htmlFor="inv-edit-service-type">Service type</Label>
                <Select value={serviceType || NONE} onValueChange={v => setServiceType(v === NONE ? "" : v)}>
                  <SelectTrigger id="inv-edit-service-type" className="mt-1.5 rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Cleaning services (no type)</SelectItem>
                    {CLEANING_TYPES.map(type => (
                      <SelectItem key={type} value={type}>
                        {SERVICE_LABELS[type] ?? type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="inv-edit-service-date">Service date</Label>
                <Input
                  id="inv-edit-service-date"
                  type="date"
                  className="mt-1.5 rounded-xl"
                  value={serviceDate}
                  onChange={e => setServiceDate(e.target.value)}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Together these name the bill — "Deep Cleaning — September 28, 2026" — on every email and the pay page.
                </p>
              </div>
            </section>

            <section>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Recent bookings</p>
              {detail.isLoading ? (
                <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
              ) : bookings.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No bookings on file.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border rounded-xl border border-border text-sm" data-testid="invoice-customer-bookings">
                  {bookings.map(b => (
                    <li key={b.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                      <span className="min-w-0 break-words">
                        <span className="font-mono text-xs text-muted-foreground">{b.reference}</span>{" "}
                        · {SERVICE_LABELS[b.serviceType ?? ""] ?? "Service TBD"} ·{" "}
                        {b.scheduledDate ? fmtDate(b.scheduledDate) : "date TBD"}
                      </span>
                      <span className="flex items-center gap-2">
                        <StatusBadge status={b.status} />
                        <span className="font-semibold">{fmtMoney(b.totalAmount)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <DialogFooter sticky>
              <Button variant="outline" className="rounded-xl" onClick={onClose}>
                Close
              </Button>
              <Button
                className="rounded-xl"
                disabled={!dirty || save.isPending}
                onClick={() =>
                  save.mutate({
                    id: invoice.id,
                    serviceType: (serviceType || null) as (typeof CLEANING_TYPES)[number] | null,
                    serviceDate: serviceDate || null,
                  })
                }
              >
                {save.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                  </>
                ) : (
                  "Save invoice details"
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

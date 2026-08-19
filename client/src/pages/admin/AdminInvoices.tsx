import { useState } from "react";
import { AlertTriangle, Plus, Send, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NotesBlock, PageHeader, RowCard, StatusBadge, TableOrCards, fmtDate, fmtMoney } from "./adminShared";

const INVOICE_STATUSES = ["draft", "sent", "paid", "overdue", "void"] as const;

/** Payment-link state → an existing StatusBadge colour. */
const LINK_BADGE_STATUS: Record<string, string> = {
  sent: "sent",
  paid: "paid",
  expired: "expired",
  none: "draft",
  awaiting_approval: "pending_deposit",
};

type PendingInvoice = {
  id: number;
  number: string;
  amount: number;
  computedAmount: number | null;
  bookingReference: string | null;
  serviceDate: string | null;
  bookingNotes: string | null;
  bookingTotal: number | null;
  depositCredited: number;
  customerName: string | null;
  customerEmail: string | null;
};

/**
 * Review dialog for a balance waiting on approval. Shows how the balance was
 * computed and lets an admin correct the total (a bigger home than booked, say)
 * before the customer is billed. The server re-checks the amount and the role.
 */
function ReviewAndSendDialog({
  invoice,
  onClose,
  onApprove,
  pending,
}: {
  invoice: PendingInvoice | null;
  onClose: () => void;
  onApprove: (invoiceId: number, adjustedAmount: number | undefined) => void;
  pending: boolean;
}) {
  const [amount, setAmount] = useState("");
  const computed = invoice?.computedAmount ?? invoice?.amount ?? 0;
  const parsed = amount.trim() === "" ? computed : Number(amount);
  const valid = Number.isFinite(parsed) && parsed >= 0;
  const adjusted = valid && Math.round(parsed) !== computed;

  return (
    <Dialog
      open={Boolean(invoice)}
      onOpenChange={o => {
        if (!o) {
          setAmount("");
          onClose();
        }
      }}
    >
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review &amp; send balance</DialogTitle>
        </DialogHeader>
        {invoice && (
          <div className="space-y-4">
            <div className="rounded-xl bg-muted/50 p-4 text-sm">
              <p className="font-medium text-foreground">
                {invoice.customerName ?? "Customer"}
                {invoice.bookingReference && (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{invoice.bookingReference}</span>
                )}
              </p>
              {invoice.serviceDate && (
                <p className="mt-0.5 text-xs text-muted-foreground">Service on {fmtDate(invoice.serviceDate)}</p>
              )}
              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Booking total</dt>
                  <dd className="font-medium text-foreground">{fmtMoney(invoice.bookingTotal ?? 0)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Deposit credited</dt>
                  <dd className="font-medium text-foreground">−{fmtMoney(invoice.depositCredited)}</dd>
                </div>
                <div className="flex justify-between border-t border-border pt-1.5">
                  <dt className="font-semibold text-foreground">Computed balance</dt>
                  <dd className="font-semibold text-foreground">{fmtMoney(computed)}</dd>
                </div>
              </dl>
            </div>

            {/* What the customer asked for. Worth re-reading before billing —
                an access note or a special request often explains why the job
                ran bigger or smaller than the booking. */}
            {invoice.bookingNotes && <NotesBlock notes={invoice.bookingNotes} />}

            <div>
              <Label htmlFor="approve-amount">Final amount to charge (USD)</Label>
              <Input
                id="approve-amount"
                type="number"
                min="0"
                step="1"
                className="mt-1.5 rounded-xl"
                placeholder={String(computed)}
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {adjusted
                  ? `Adjusted from the computed ${fmtMoney(computed)} — the customer is charged ${fmtMoney(Math.round(parsed))}.`
                  : "Leave blank to charge the computed balance."}
              </p>
              {!valid && <p className="mt-1.5 text-xs text-destructive">Enter a valid amount.</p>}
            </div>

            <p className="text-xs text-muted-foreground">
              Approving emails {invoice.customerEmail ?? "the customer"} a payment link valid for 7 days.
            </p>

            <Button
              className="w-full rounded-xl"
              disabled={!valid || pending}
              onClick={() => onApprove(invoice.id, adjusted ? Math.round(parsed) : undefined)}
            >
              {pending ? "Sending…" : `Approve & send ${fmtMoney(valid ? Math.round(parsed) : computed)}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function AdminInvoices() {
  const utils = trpc.useUtils();
  const invoices = trpc.admin.invoices.useQuery();
  const customers = trpc.admin.customers.useQuery({});
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ customerId: "", amount: "", dueDate: "" });

  const create = trpc.admin.createInvoice.useMutation({
    onSuccess: r => {
      utils.admin.invoices.invalidate();
      setOpen(false);
      setForm({ customerId: "", amount: "", dueDate: "" });
      toast.success(`Invoice ${r.number} created`);
    },
    onError: () => toast.error("Failed to create invoice"),
  });
  const updateStatus = trpc.admin.updateInvoiceStatus.useMutation({
    onSuccess: () => {
      utils.admin.invoices.invalidate();
      toast.success("Invoice updated");
    },
    onError: () => toast.error("Failed to update invoice"),
  });
  const pendingApproval = trpc.admin.awaitingApprovalInvoices.useQuery();
  const [reviewing, setReviewing] = useState<PendingInvoice | null>(null);
  const approve = trpc.admin.approveBalanceInvoice.useMutation({
    onSuccess: r => {
      utils.admin.invoices.invalidate();
      utils.admin.awaitingApprovalInvoices.invalidate();
      setReviewing(null);
      toast.success(
        r.sent
          ? r.emailed
            ? `Payment link sent — ${fmtMoney(r.amount)} due by ${r.expiresOn}`
            : `Approved ${fmtMoney(r.amount)} (email not configured)`
          : "Balance settled — nothing left to collect"
      );
    },
    onError: e => toast.error(e.message || "Failed to approve balance"),
  });
  const [resendingId, setResendingId] = useState<number | null>(null);
  const resend = trpc.admin.resendBalanceLink.useMutation({
    onSuccess: r => {
      utils.admin.invoices.invalidate();
      if (r.emailed) {
        toast.success(`Payment link re-sent — valid through ${r.expiresOn}`);
        return;
      }
      // The link itself is valid either way; what failed is the email. Show
      // what the mail server actually said so a broken mailbox is diagnosable
      // from here instead of only in the server logs.
      toast.error(
        r.emailError
          ? `Link regenerated, but the email did not send: ${r.emailError}`
          : `Link regenerated, but no email was sent (email not configured)`,
        { duration: 12000 }
      );
    },
    onError: e => toast.error(e.message || "Failed to resend payment link"),
    onSettled: () => setResendingId(null),
  });

  const customerName = (id: number) => {
    const c = (customers.data ?? []).find(c => c.id === id);
    return c ? `${c.firstName} ${c.lastName}` : `#${id}`;
  };

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle="Create and track customer invoices"
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="rounded-xl">
                <Plus className="mr-1.5 h-4 w-4" /> New invoice
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-2xl sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create invoice</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Customer</Label>
                  <Select value={form.customerId} onValueChange={v => setForm(f => ({ ...f, customerId: v }))}>
                    <SelectTrigger className="mt-1.5 rounded-xl">
                      <SelectValue placeholder="Select customer" />
                    </SelectTrigger>
                    <SelectContent>
                      {(customers.data ?? []).map(c => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.firstName} {c.lastName} — {c.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="inv-amount">Amount (USD)</Label>
                  <Input
                    id="inv-amount"
                    type="number"
                    min="1"
                    className="mt-1.5 rounded-xl"
                    value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="inv-due">Due date</Label>
                  <Input
                    id="inv-due"
                    type="date"
                    className="mt-1.5 rounded-xl"
                    value={form.dueDate}
                    onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                  />
                </div>
                <Button
                  className="w-full rounded-xl"
                  disabled={!form.customerId || !form.amount || create.isPending}
                  onClick={() =>
                    create.mutate({
                      customerId: Number(form.customerId),
                      amount: Math.round(Number(form.amount)),
                      dueDate: form.dueDate || undefined,
                    })
                  }
                >
                  {create.isPending ? "Creating…" : "Create invoice"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        }
      />

      {/* Balances waiting on review — nothing has reached the customer yet. */}
      {(pendingApproval.data ?? []).length > 0 && (
        <div className="mb-6 overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-amber-300">
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-3">
            <ShieldCheck className="h-4 w-4 text-amber-700" />
            <h2 className="text-sm font-semibold text-amber-900">
              {pendingApproval.data!.length} balance{pendingApproval.data!.length === 1 ? "" : "s"} awaiting your approval
            </h2>
            <span className="text-xs text-amber-800">— no payment link has been sent yet</span>
          </div>
          <ul className="divide-y divide-border">
            {(pendingApproval.data ?? []).map(inv => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {inv.customerName ?? `#${inv.customerId}`}
                    {inv.bookingReference && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{inv.bookingReference}</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {inv.serviceDate ? `Completed ${fmtDate(inv.serviceDate)} · ` : ""}
                    Total {fmtMoney(inv.bookingTotal ?? 0)} − deposit {fmtMoney(inv.depositCredited)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-display text-base font-bold text-foreground">{fmtMoney(inv.amount)}</span>
                  <Button size="sm" className="rounded-xl" onClick={() => setReviewing(inv)}>
                    Review &amp; send
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ReviewAndSendDialog
        invoice={reviewing}
        pending={approve.isPending}
        onClose={() => setReviewing(null)}
        onApprove={(invoiceId, adjustedAmount) => approve.mutate({ invoiceId, adjustedAmount })}
      />

      <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
        {invoices.isLoading ? (
          <div className="space-y-3 p-6">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (invoices.data ?? []).length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <TableOrCards
            table={
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-3 font-medium">Number</th>
                  <th className="px-6 py-3 font-medium">Customer</th>
                  <th className="px-6 py-3 font-medium">Amount</th>
                  <th className="px-6 py-3 font-medium">Due date</th>
                  <th className="px-6 py-3 font-medium">Payment link</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(invoices.data ?? []).map(inv => (
                  <tr key={inv.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-6 py-3.5 font-mono text-xs font-semibold text-primary">{inv.number}</td>
                    <td className="px-6 py-3.5">{customerName(inv.customerId)}</td>
                    <td className="px-6 py-3.5 font-semibold">{fmtMoney(inv.amount)}</td>
                    <td className="px-6 py-3.5 text-muted-foreground">{inv.dueDate ? fmtDate(inv.dueDate) : "—"}</td>
                    <td className="px-6 py-3.5">
                      {inv.linkStatus === "none" ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <StatusBadge status={LINK_BADGE_STATUS[inv.linkStatus]} />
                          {inv.linkStatus !== "paid" && (inv.reminderCount ?? 0) > 0 && (
                            <span
                              className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
                              title={
                                inv.reminderExhaustedAlertAt
                                  ? "Both automatic reminders sent and you've been alerted — personal follow-up is the next step. Resend restarts the sequence."
                                  : "Automatic unpaid-balance reminders sent so far (3 and 7 days after send)."
                              }
                            >
                              {inv.reminderCount} reminder{inv.reminderCount === 1 ? "" : "s"}
                            </span>
                          )}
                          {inv.refundNeeded && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"
                              title="A card payment arrived after this invoice was already settled — refund it in Stripe."
                            >
                              <AlertTriangle className="h-3 w-3" /> Refund needed
                            </span>
                          )}
                          {inv.linkStatus !== "paid" && inv.linkStatus !== "awaiting_approval" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 rounded-lg px-2 text-xs"
                              disabled={resend.isPending && resendingId === inv.id}
                              onClick={() => {
                                setResendingId(inv.id);
                                resend.mutate({ invoiceId: inv.id });
                              }}
                            >
                              <Send className="mr-1 h-3 w-3" />
                              {resend.isPending && resendingId === inv.id ? "Sending…" : "Resend"}
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-3.5">
                      <Select
                        value={inv.status}
                        onValueChange={v =>
                          updateStatus.mutate({ id: inv.id, status: v as (typeof INVOICE_STATUSES)[number] })
                        }
                      >
                        <SelectTrigger className="h-8 w-32 rounded-lg text-xs">
                          <SelectValue>
                            <StatusBadge status={inv.status} />
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {INVOICE_STATUSES.map(s => (
                            <SelectItem key={s} value={s} className="capitalize">
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            }
            cards={(invoices.data ?? []).map(inv => (
              <RowCard
                key={inv.id}
                title={<span className="font-mono text-xs font-semibold text-primary">{inv.number}</span>}
                subtitle={customerName(inv.customerId)}
                amount={fmtMoney(inv.amount)}
                badge={<StatusBadge status={inv.status} />}
                details={[
                  { label: "Due date", value: inv.dueDate ? fmtDate(inv.dueDate) : "—" },
                  {
                    label: "Payment link",
                    value:
                      inv.linkStatus === "none" ? "—" : <StatusBadge status={LINK_BADGE_STATUS[inv.linkStatus]} />,
                  },
                  ...(inv.linkStatus !== "paid" && (inv.reminderCount ?? 0) > 0
                    ? [
                        {
                          label: "Reminders",
                          value: `${inv.reminderCount} sent${inv.reminderExhaustedAlertAt ? " — follow up personally" : ""}`,
                        },
                      ]
                    : []),
                  ...(inv.refundNeeded ? [{ label: "Action", value: "Refund needed in Stripe" }] : []),
                ]}
                actions={
                  <>
                    <Select
                      value={inv.status}
                      onValueChange={v =>
                        updateStatus.mutate({ id: inv.id, status: v as (typeof INVOICE_STATUSES)[number] })
                      }
                    >
                      <SelectTrigger className="h-9 flex-1 rounded-lg text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INVOICE_STATUSES.map(st => (
                          <SelectItem key={st} value={st} className="capitalize">
                            {st}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {inv.linkStatus !== "paid" && inv.linkStatus !== "awaiting_approval" && inv.linkStatus !== "none" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 rounded-lg text-xs"
                        disabled={resend.isPending && resendingId === inv.id}
                        onClick={() => {
                          setResendingId(inv.id);
                          resend.mutate({ invoiceId: inv.id });
                        }}
                      >
                        <Send className="mr-1 h-3 w-3" />
                        {resend.isPending && resendingId === inv.id ? "Sending…" : "Resend"}
                      </Button>
                    )}
                  </>
                }
              />
            ))}
          />
        )}
      </div>
    </div>
  );
}

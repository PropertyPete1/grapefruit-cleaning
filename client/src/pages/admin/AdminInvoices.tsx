import { useState } from "react";
import { Plus } from "lucide-react";
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
import { PageHeader, StatusBadge, fmtDate, fmtMoney } from "./adminShared";

const INVOICE_STATUSES = ["draft", "sent", "paid", "overdue", "void"] as const;

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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-3 font-medium">Number</th>
                  <th className="px-6 py-3 font-medium">Customer</th>
                  <th className="px-6 py-3 font-medium">Amount</th>
                  <th className="px-6 py-3 font-medium">Due date</th>
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
          </div>
        )}
      </div>
    </div>
  );
}

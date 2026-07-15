import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PageHeader } from "./adminShared";

export default function AdminCoupons() {
  const utils = trpc.useUtils();
  const coupons = trpc.admin.coupons.useQuery();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: "", description: "", percentOff: "", amountOff: "", maxRedemptions: "", expiresAt: "" });

  const create = trpc.admin.createCoupon.useMutation({
    onSuccess: () => {
      utils.admin.coupons.invalidate();
      setOpen(false);
      setForm({ code: "", description: "", percentOff: "", amountOff: "", maxRedemptions: "", expiresAt: "" });
      toast.success("Coupon created");
    },
    onError: () => toast.error("Failed to create coupon (code may already exist)"),
  });
  const update = trpc.admin.updateCoupon.useMutation({
    onSuccess: () => utils.admin.coupons.invalidate(),
    onError: () => toast.error("Failed to update"),
  });
  const remove = trpc.admin.deleteCoupon.useMutation({
    onSuccess: () => {
      utils.admin.coupons.invalidate();
      toast.success("Coupon deleted");
    },
    onError: () => toast.error("Failed to delete"),
  });

  return (
    <div>
      <PageHeader
        title="Coupons"
        subtitle="Discount codes customers can apply at booking"
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="rounded-xl">
                <Plus className="mr-1.5 h-4 w-4" /> New coupon
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-2xl sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create coupon</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor="c-code">Code</Label>
                  <Input
                    id="c-code"
                    placeholder="WELCOME20"
                    className="mt-1.5 rounded-xl uppercase"
                    value={form.code}
                    onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="c-desc">Description</Label>
                  <Input
                    id="c-desc"
                    className="mt-1.5 rounded-xl"
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="c-pct">% off</Label>
                  <Input
                    id="c-pct"
                    type="number"
                    min="1"
                    max="100"
                    className="mt-1.5 rounded-xl"
                    value={form.percentOff}
                    onChange={e => setForm(f => ({ ...f, percentOff: e.target.value, amountOff: "" }))}
                  />
                </div>
                <div>
                  <Label htmlFor="c-amt">$ off (or)</Label>
                  <Input
                    id="c-amt"
                    type="number"
                    min="1"
                    className="mt-1.5 rounded-xl"
                    value={form.amountOff}
                    onChange={e => setForm(f => ({ ...f, amountOff: e.target.value, percentOff: "" }))}
                  />
                </div>
                <div>
                  <Label htmlFor="c-max">Max uses</Label>
                  <Input
                    id="c-max"
                    type="number"
                    min="1"
                    className="mt-1.5 rounded-xl"
                    value={form.maxRedemptions}
                    onChange={e => setForm(f => ({ ...f, maxRedemptions: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="c-exp">Expires</Label>
                  <Input
                    id="c-exp"
                    type="date"
                    className="mt-1.5 rounded-xl"
                    value={form.expiresAt}
                    onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                  />
                </div>
              </div>
              <Button
                className="mt-2 w-full rounded-xl"
                disabled={!form.code || (!form.percentOff && !form.amountOff) || create.isPending}
                onClick={() =>
                  create.mutate({
                    code: form.code,
                    description: form.description || undefined,
                    percentOff: form.percentOff ? Number(form.percentOff) : undefined,
                    amountOff: form.amountOff ? Number(form.amountOff) : undefined,
                    maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : undefined,
                    expiresAt: form.expiresAt || undefined,
                  })
                }
              >
                {create.isPending ? "Creating…" : "Create coupon"}
              </Button>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
        {coupons.isLoading ? (
          <div className="space-y-3 p-6">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (coupons.data ?? []).length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No coupons yet. Create one to offer discounts at checkout.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-3 font-medium">Code</th>
                  <th className="px-6 py-3 font-medium">Discount</th>
                  <th className="px-6 py-3 font-medium">Used</th>
                  <th className="px-6 py-3 font-medium">Expires</th>
                  <th className="px-6 py-3 font-medium">Active</th>
                  <th className="px-6 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {(coupons.data ?? []).map(c => (
                  <tr key={c.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-6 py-3.5">
                      <span className="font-mono font-semibold text-primary">{c.code}</span>
                      {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
                    </td>
                    <td className="px-6 py-3.5 font-semibold">
                      {c.percentOff ? `${c.percentOff}%` : c.amountOff ? `$${c.amountOff}` : "—"}
                    </td>
                    <td className="px-6 py-3.5 text-muted-foreground">
                      {c.timesRedeemed}
                      {c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}
                    </td>
                    <td className="px-6 py-3.5 text-muted-foreground">{c.expiresAt ?? "Never"}</td>
                    <td className="px-6 py-3.5">
                      <Switch checked={c.active} onCheckedChange={v => update.mutate({ id: c.id, active: v })} />
                    </td>
                    <td className="px-6 py-3.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => remove.mutate({ id: c.id })}
                        aria-label="Delete coupon"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
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

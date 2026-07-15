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

export default function AdminEmployees() {
  const utils = trpc.useUtils();
  const employees = trpc.admin.employees.useQuery();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "", role: "Cleaner" });

  const create = trpc.admin.createEmployee.useMutation({
    onSuccess: () => {
      utils.admin.employees.invalidate();
      setOpen(false);
      setForm({ firstName: "", lastName: "", email: "", phone: "", role: "Cleaner" });
      toast.success("Team member added");
    },
    onError: () => toast.error("Failed to add team member"),
  });
  const update = trpc.admin.updateEmployee.useMutation({
    onSuccess: () => utils.admin.employees.invalidate(),
    onError: () => toast.error("Failed to update"),
  });
  const remove = trpc.admin.deleteEmployee.useMutation({
    onSuccess: () => {
      utils.admin.employees.invalidate();
      toast.success("Team member removed");
    },
    onError: () => toast.error("Failed to remove"),
  });

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle="Your cleaning team"
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="rounded-xl">
                <Plus className="mr-1.5 h-4 w-4" /> Add member
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-2xl sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Add team member</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="emp-first">First name</Label>
                  <Input
                    id="emp-first"
                    className="mt-1.5 rounded-xl"
                    value={form.firstName}
                    onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="emp-last">Last name</Label>
                  <Input
                    id="emp-last"
                    className="mt-1.5 rounded-xl"
                    value={form.lastName}
                    onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="emp-email">Email</Label>
                  <Input
                    id="emp-email"
                    type="email"
                    className="mt-1.5 rounded-xl"
                    value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="emp-phone">Phone</Label>
                  <Input
                    id="emp-phone"
                    className="mt-1.5 rounded-xl"
                    value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="emp-role">Role</Label>
                  <Input
                    id="emp-role"
                    className="mt-1.5 rounded-xl"
                    value={form.role}
                    onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  />
                </div>
              </div>
              <Button
                className="mt-2 w-full rounded-xl"
                disabled={!form.firstName || !form.lastName || create.isPending}
                onClick={() =>
                  create.mutate({
                    firstName: form.firstName,
                    lastName: form.lastName,
                    email: form.email || undefined,
                    phone: form.phone || undefined,
                    role: form.role || undefined,
                  })
                }
              >
                {create.isPending ? "Adding…" : "Add member"}
              </Button>
            </DialogContent>
          </Dialog>
        }
      />

      {employees.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-2xl" />
          ))}
        </div>
      ) : (employees.data ?? []).length === 0 ? (
        <div className="rounded-2xl bg-card p-10 text-center text-sm text-muted-foreground shadow-sm ring-1 ring-border">
          No team members yet. Add your first cleaner to start assigning bookings.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(employees.data ?? []).map(e => (
            <div key={e.id} className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 font-bold text-primary">
                    {e.firstName[0]}
                    {e.lastName[0]}
                  </span>
                  <div>
                    <p className="font-semibold text-foreground">
                      {e.firstName} {e.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">{e.role ?? "Cleaner"}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => remove.mutate({ id: e.id })}
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="mt-4 space-y-1 text-sm text-muted-foreground">
                {e.email && <p>{e.email}</p>}
                {e.phone && <p>{e.phone}</p>}
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                <span className="text-xs font-medium text-muted-foreground">
                  {e.active ? "Active" : "Inactive"}
                </span>
                <Switch checked={e.active} onCheckedChange={v => update.mutate({ id: e.id, active: v })} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

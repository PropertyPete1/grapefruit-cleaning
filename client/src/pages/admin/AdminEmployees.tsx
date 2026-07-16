import { useState } from "react";
import { Check, Copy, KeyRound, Mail, Plus, Send, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const authUsers = trpc.admin.listUsers.useQuery();
  const [open, setOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<{ id: number; name: string; userId: number | null } | null>(null);
  const [inviteResult, setInviteResult] = useState<{ name: string; url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "", role: "Cleaner" });
  const [sendInviteOnCreate, setSendInviteOnCreate] = useState(true);

  const create = trpc.admin.createEmployee.useMutation({
    onSuccess: async (data) => {
      utils.admin.employees.invalidate();
      setOpen(false);
      const name = `${form.firstName} ${form.lastName}`;
      if (sendInviteOnCreate) {
        try {
          const res = await sendInvite.mutateAsync({ employeeId: data.id, origin: window.location.origin });
          setInviteResult({ name, url: res.inviteUrl, emailed: res.emailed });
        } catch {
          toast.error("Member added, but the invite could not be created. Use 'Send invite' on their card.");
        }
      }
      setForm({ firstName: "", lastName: "", email: "", phone: "", role: "Cleaner" });
      toast.success("Team member added");
    },
    onError: () => toast.error("Failed to add team member"),
  });
  const sendInvite = trpc.admin.sendStaffInvite.useMutation({
    onSuccess: () => utils.admin.employees.invalidate(),
  });
  const revokeInvite = trpc.admin.revokeStaffInvite.useMutation({
    onSuccess: () => {
      utils.admin.employees.invalidate();
      toast.success("Invite revoked — the link no longer works");
    },
    onError: () => toast.error("Failed to revoke invite"),
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
  const link = trpc.admin.linkEmployeeUser.useMutation({
    onSuccess: () => {
      utils.admin.employees.invalidate();
      utils.admin.listUsers.invalidate();
      setLinkTarget(null);
      toast.success("Staff access updated");
    },
    onError: e => toast.error(e.message || "Failed to update staff access"),
  });

  const userById = (id: number | null) => (authUsers.data ?? []).find(u => u.id === id);

  const copyInviteUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Invite link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy — select and copy the link manually");
    }
  };

  const handleSendInvite = async (e: { id: number; firstName: string; lastName: string; email: string | null }) => {
    try {
      const res = await sendInvite.mutateAsync({ employeeId: e.id, origin: window.location.origin });
      setInviteResult({ name: `${e.firstName} ${e.lastName}`, url: res.inviteUrl, emailed: res.emailed });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create invite");
    }
  };

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
              <label className="flex cursor-pointer items-center gap-2.5 rounded-xl bg-muted/50 p-3">
                <Switch checked={sendInviteOnCreate} onCheckedChange={setSendInviteOnCreate} />
                <span className="text-sm text-foreground">
                  Send staff dashboard invite right away
                  <span className="block text-xs text-muted-foreground">
                    Creates their personal join link{form.email ? ` and emails it to ${form.email}` : " (add an email to auto-send it)"}
                  </span>
                </span>
              </label>
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
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">Staff dashboard access</p>
                  <p className="truncate text-xs font-semibold text-foreground">
                    {e.userId
                      ? `Connected — ${userById(e.userId)?.name ?? userById(e.userId)?.email ?? `User #${e.userId}`}`
                      : e.inviteToken
                        ? "Invite pending"
                        : "Not connected"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full bg-card"
                  onClick={() => setLinkTarget({ id: e.id, name: `${e.firstName} ${e.lastName}`, userId: e.userId ?? null })}
                >
                  <KeyRound className="mr-1.5 h-3.5 w-3.5" /> {e.userId ? "Manage" : "Grant"}
                </Button>
              </div>
              {!e.userId && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                  <Button
                    size="sm"
                    className="rounded-full"
                    disabled={sendInvite.isPending}
                    onClick={() => handleSendInvite(e)}
                  >
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                    {e.inviteToken ? "Resend invite" : "Send invite"}
                  </Button>
                  {e.inviteToken && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full bg-card text-muted-foreground"
                      disabled={revokeInvite.isPending}
                      onClick={() => revokeInvite.mutate({ employeeId: e.id })}
                    >
                      <XCircle className="mr-1.5 h-3.5 w-3.5" /> Revoke
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Invite created dialog: shows the link to copy/share */}
      <Dialog open={inviteResult !== null} onOpenChange={v => !v && setInviteResult(null)}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite ready — {inviteResult?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {inviteResult?.emailed ? (
              <>
                <Mail className="mr-1.5 inline h-4 w-4 text-secondary" />
                The invite was emailed to them. You can also share this personal link directly (text message works
                great):
              </>
            ) : (
              <>Share this personal link with them (text message works great). When they open it and sign in, their
                staff dashboard access connects automatically:</>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={inviteResult?.url ?? ""} className="rounded-xl text-xs" onFocus={ev => ev.target.select()} />
            <Button
              size="icon"
              variant="outline"
              className="shrink-0 rounded-xl bg-card"
              onClick={() => inviteResult && copyInviteUrl(inviteResult.url)}
              aria-label="Copy invite link"
            >
              {copied ? <Check className="h-4 w-4 text-secondary" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The link is single-use and personal. You can resend or revoke it anytime from their card.
          </p>
          <Button className="mt-1 w-full rounded-xl" onClick={() => setInviteResult(null)}>
            Done
          </Button>
        </DialogContent>
      </Dialog>

      {/* Staff access linking dialog */}
      <Dialog open={linkTarget !== null} onOpenChange={v => !v && setLinkTarget(null)}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Staff access — {linkTarget?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Link this team member to a signed-in account. They'll get the <strong>staff</strong> role and can
            view bookings, schedules, and job details at <code className="rounded bg-muted px-1">/staff</code>.
            The person must sign in to the website at least once to appear in this list.
          </p>
          {authUsers.isLoading ? (
            <Skeleton className="h-10 w-full rounded-xl" />
          ) : (
            <Select
              value={linkTarget?.userId ? String(linkTarget.userId) : "none"}
              onValueChange={v =>
                setLinkTarget(t => (t ? { ...t, userId: v === "none" ? null : Number(v) } : t))
              }
            >
              <SelectTrigger className="w-full rounded-xl bg-card">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No access (unlink)</SelectItem>
                {(authUsers.data ?? []).map(u => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name ?? u.email ?? `User #${u.id}`}
                    {u.role !== "user" ? ` (${u.role})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            className="mt-2 w-full rounded-xl"
            disabled={link.isPending}
            onClick={() => linkTarget && link.mutate({ employeeId: linkTarget.id, userId: linkTarget.userId })}
          >
            {link.isPending ? "Saving…" : "Save access"}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

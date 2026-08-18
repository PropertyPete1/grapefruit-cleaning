/**
 * Admin → Properties: recurring hosts' listings, wired to their Airbnb/VRBO
 * calendars.
 *
 * Each card is one listing: whose it is, where, how it's priced, the feed
 * health (last sync, consecutive failures), and the next synced cleans. The
 * feed URL is validated at save time — a typo should bounce here with the
 * reservation count as proof of life, not fail silently every hour.
 */
import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Home, Loader2, Plus, RefreshCw } from "lucide-react";
import { CLEANING_TYPES } from "@shared/pricing";
import { composeAddress } from "@shared/property";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PageHeader, SERVICE_LABELS, StatusBadge, fmtDate } from "./adminShared";

const HOURS = Array.from({ length: 13 }, (_, i) => `${String(i + 8).padStart(2, "0")}:00`);

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <Label className="text-xs font-semibold">{label}</Label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

type EditTarget =
  | { mode: "create" }
  | {
      mode: "edit";
      id: number;
      seed: {
        label: string;
        addressLine: string;
        unitNumber: string;
        propertyType: "house" | "apartment";
        city: string;
        zip: string;
        sqft: string;
        serviceType: string;
        icalUrl: string;
        defaultTime: string;
        autoBook: boolean;
        perCleanEmails: boolean;
        active: boolean;
      };
    };

function PropertyDialog({ target, onClose }: { target: EditTarget; onClose: () => void }) {
  const utils = trpc.useUtils();
  const customers = trpc.admin.customers.useQuery({});
  const seed = target.mode === "edit" ? target.seed : null;

  const [customerId, setCustomerId] = useState<string>("");
  const [label, setLabel] = useState(seed?.label ?? "");
  const [addressLine, setAddressLine] = useState(seed?.addressLine ?? "");
  const [unitNumber, setUnitNumber] = useState(seed?.unitNumber ?? "");
  const [propertyType, setPropertyType] = useState<"house" | "apartment">(seed?.propertyType ?? "apartment");
  const [city, setCity] = useState(seed?.city ?? "San Antonio");
  const [zip, setZip] = useState(seed?.zip ?? "");
  const [sqft, setSqft] = useState(seed?.sqft ?? "");
  const [serviceType, setServiceType] = useState(seed?.serviceType ?? "airbnb");
  const [icalUrl, setIcalUrl] = useState(seed?.icalUrl ?? "");
  const [defaultTime, setDefaultTime] = useState(seed?.defaultTime ?? "11:00");
  const [autoBook, setAutoBook] = useState(seed?.autoBook ?? true);
  const [perCleanEmails, setPerCleanEmails] = useState(seed?.perCleanEmails ?? false);
  const [active, setActive] = useState(seed?.active ?? true);

  const done = (message: string) => {
    utils.admin.properties.invalidate();
    toast.success(message);
    onClose();
  };
  const create = trpc.admin.createProperty.useMutation({
    onSuccess: result =>
      done(
        `Connected — ${result.reservationsFound} reservation${result.reservationsFound === 1 ? "" : "s"} found${
          result.emailSent ? ", setup email sent" : ""
        }`
      ),
    onError: error => toast.error(error.message || "Failed to connect the property"),
  });
  const update = trpc.admin.updateProperty.useMutation({
    onSuccess: result =>
      done(
        result.reservationsFound !== undefined
          ? `Saved — new feed has ${result.reservationsFound} reservation${result.reservationsFound === 1 ? "" : "s"}`
          : "Saved"
      ),
    onError: error => toast.error(error.message || "Failed to save"),
  });

  const sqftNumber = Math.min(20000, Math.max(200, Number(sqft)));
  const valid =
    label.trim() !== "" &&
    addressLine.trim().length >= 3 &&
    sqft.trim() !== "" &&
    Number.isFinite(Number(sqft)) &&
    Number(sqft) >= 200 &&
    /^https?:\/\//.test(icalUrl.trim()) &&
    (target.mode === "edit" || customerId !== "");

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{target.mode === "create" ? "Connect a property" : "Edit property"}</DialogTitle>
          <DialogDescription>
            Paste the listing's iCal export link — every guest checkout becomes a cleaning automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {target.mode === "create" && (
            <Field label="Customer" hint="The host this property bills to.">
              <select
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                value={customerId}
                onChange={e => setCustomerId(e.target.value)}
              >
                <option value="">Choose…</option>
                {(customers.data ?? []).map(c => (
                  <option key={c.id} value={String(c.id)}>
                    {c.firstName} {c.lastName} {c.email ? `· ${c.email}` : c.phone ? `· ${c.phone}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Label" hint={'How it shows everywhere — "Riverwalk condo".'}>
            <Input className="rounded-xl" value={label} onChange={e => setLabel(e.target.value)} />
          </Field>
          <Field label="Address">
            <div className="flex gap-2">
              <Input className="flex-1 rounded-xl" value={addressLine} onChange={e => setAddressLine(e.target.value)} />
              <Input
                className="w-24 rounded-xl"
                placeholder="Unit #"
                value={unitNumber}
                onChange={e => setUnitNumber(e.target.value)}
              />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City">
              <Input className="rounded-xl" value={city} onChange={e => setCity(e.target.value)} />
            </Field>
            <Field label="ZIP">
              <Input className="rounded-xl" value={zip} onChange={e => setZip(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Property type">
              <select
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                value={propertyType}
                onChange={e => setPropertyType(e.target.value as "house" | "apartment")}
              >
                <option value="apartment">Apartment / Condo</option>
                <option value="house">House</option>
              </select>
            </Field>
            <Field label="Sq ft" hint="Priced from this. Exact number.">
              <Input
                type="number"
                inputMode="numeric"
                min={200}
                max={20000}
                className="rounded-xl"
                value={sqft}
                onChange={e => setSqft(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Service">
              <select
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                value={serviceType}
                onChange={e => setServiceType(e.target.value)}
              >
                {CLEANING_TYPES.map(t => (
                  <option key={t} value={t}>
                    {SERVICE_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Cleaning time" hint="On checkout day; later slots are tried if taken.">
              <select
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                value={defaultTime}
                onChange={e => setDefaultTime(e.target.value)}
              >
                {HOURS.map(h => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="iCal feed URL" hint="Airbnb: Listing → Availability → Connect calendars → Export. Validated on save.">
            <Input
              className="rounded-xl font-mono text-xs"
              placeholder="https://www.airbnb.com/calendar/ical/…"
              value={icalUrl}
              onChange={e => setIcalUrl(e.target.value)}
            />
          </Field>
          <label className="flex items-start gap-2.5 rounded-xl border border-border px-4 py-3">
            <Checkbox checked={autoBook} onCheckedChange={v => setAutoBook(v === true)} className="mt-0.5" />
            <span>
              <span className="block text-sm font-semibold">Auto-book turnovers</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Every reservation's checkout becomes a confirmed cleaning. Off = sync visibility only.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 rounded-xl border border-border px-4 py-3">
            <Checkbox checked={perCleanEmails} onCheckedChange={v => setPerCleanEmails(v === true)} className="mt-0.5" />
            <span>
              <span className="block text-sm font-semibold">Per-clean emails to the host</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Off by default — hosts get one setup email and the balance link per clean, nothing else.
              </span>
            </span>
          </label>
          <Button
            className="w-full rounded-xl"
            disabled={!valid || pending}
            onClick={() => {
              const shared = {
                label: label.trim(),
                addressLine: addressLine.trim(),
                unitNumber: unitNumber.trim() || undefined,
                propertyType,
                city: city.trim() || undefined,
                zip: zip.trim() || undefined,
                sqft: sqftNumber,
                serviceType: serviceType as (typeof CLEANING_TYPES)[number],
                icalUrl: icalUrl.trim(),
                defaultTime,
                autoBook,
                perCleanEmails,
                active,
              };
              if (target.mode === "create") {
                create.mutate({ ...shared, customerId: Number(customerId) });
              } else {
                update.mutate({ id: target.id, ...shared });
              }
            }}
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking the feed…
              </>
            ) : target.mode === "create" ? (
              "Validate feed & connect"
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminProperties() {
  const utils = trpc.useUtils();
  const properties = trpc.admin.properties.useQuery();
  const [dialog, setDialog] = useState<EditTarget | null>(null);

  const sync = trpc.admin.syncProperty.useMutation({
    onSuccess: result => {
      utils.admin.properties.invalidate();
      utils.admin.bookings.invalidate();
      toast.success(
        result.ok
          ? `Synced — ${result.reservations} reservations, ${result.created} new, ${result.moved} moved, ${result.cancelled} cancelled${result.unplaced ? `, ${result.unplaced} need a time` : ""}`
          : `Sync failed: ${result.error}`
      );
    },
    onError: error => toast.error(error.message || "Sync failed"),
  });
  const toggle = trpc.admin.updateProperty.useMutation({
    onSuccess: () => utils.admin.properties.invalidate(),
    onError: error => toast.error(error.message || "Failed to save"),
  });

  return (
    <div>
      <PageHeader
        title="Properties"
        subtitle="Recurring hosts — every checkout on their calendar books itself"
        action={
          <Button className="rounded-xl" onClick={() => setDialog({ mode: "create" })}>
            <Plus className="mr-2 h-4 w-4" /> Connect property
          </Button>
        }
      />

      {properties.isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      ) : (properties.data ?? []).length === 0 ? (
        <div className="rounded-2xl bg-card p-10 text-center shadow-sm ring-1 ring-border">
          <Home className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            No properties connected yet. Connect a host's listing and their turnovers book themselves.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {(properties.data ?? []).map(p => (
            <div key={p.id} className="rounded-2xl bg-card p-5 shadow-sm ring-1 ring-border">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-display text-base font-bold text-foreground">{p.label}</p>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-accent-foreground">
                      Auto · Airbnb
                    </span>
                    {!p.active && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        Paused
                      </span>
                    )}
                    {p.active && !p.autoBook && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                        Sync only — not booking
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.customerName} · {composeAddress(p)} · {SERVICE_LABELS[p.serviceType] ?? p.serviceType} ·{" "}
                    {p.sqft.toLocaleString()} ft² · {p.defaultTime}
                  </p>
                  <p className="mt-1 text-xs">
                    {p.lastSyncStatus === "ok" ? (
                      <span className="text-emerald-700">
                        ✓ Synced {p.lastSyncAt ? fmtDate(p.lastSyncAt) : ""} · {p.reservationCount ?? 0} reservations on the
                        calendar
                      </span>
                    ) : p.lastSyncStatus ? (
                      <span className="font-medium text-red-700">
                        ⚠ {p.lastSyncStatus}
                        {p.consecutiveFailures > 1 ? ` (${p.consecutiveFailures} in a row)` : ""}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not synced yet</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch
                      checked={p.active}
                      onCheckedChange={activeNow => toggle.mutate({ id: p.id, active: activeNow })}
                      aria-label="Active"
                    />
                    Active
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-lg"
                    disabled={sync.isPending}
                    onClick={() => sync.mutate({ id: p.id })}
                    title="Poll the feed now — the same reconcile the hourly sync runs"
                  >
                    {sync.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    <span className="ml-1.5">Sync now</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-lg"
                    onClick={() =>
                      setDialog({
                        mode: "edit",
                        id: p.id,
                        seed: {
                          label: p.label,
                          addressLine: p.addressLine,
                          unitNumber: p.unitNumber ?? "",
                          propertyType: p.propertyType,
                          city: p.city ?? "",
                          zip: p.zip ?? "",
                          sqft: String(p.sqft),
                          serviceType: p.serviceType,
                          icalUrl: p.icalUrl,
                          defaultTime: p.defaultTime,
                          autoBook: p.autoBook,
                          perCleanEmails: p.perCleanEmails,
                          active: p.active,
                        },
                      })
                    }
                  >
                    Edit
                  </Button>
                </div>
              </div>
              {p.upcoming.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold text-muted-foreground">Next synced cleans:</span>
                  {p.upcoming.map(b => (
                    <span
                      key={b.id}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        b.scheduledDate
                          ? "bg-secondary/15 text-secondary-foreground"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {b.scheduledDate ? `${fmtDate(b.scheduledDate)} · ${b.scheduledTime}` : "NEEDS A TIME"}
                      {"  "}
                      <StatusBadge status={b.status} />
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {dialog && <PropertyDialog target={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

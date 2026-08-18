/**
 * Admin → Appointments → "New booking".
 *
 * Built for the way leads actually arrive: a text or a call, answered from the
 * owner's phone, with anywhere between a full job scope and a bare name and
 * number in hand. The form's hard floor is a name plus one way to reach them;
 * everything else lives in collapsed "add what you know" sections that cost
 * nothing to skip. Whatever is left blank, the CUSTOMER answers on the link —
 * service, size, time — watching the price assemble as they go.
 *
 * Still deliberately absent: extras, and any price field. Extras are the
 * customer's upsell to take on the pay page, and every dollar figure is
 * computed on the server from the live pricing config — there is nowhere here
 * to type an amount, because there is nowhere for one to be trusted from.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, ChevronDown, Copy, Loader2 } from "lucide-react";
import { CLEANING_TYPES, FREQUENCIES } from "@shared/pricing";
import { todayInBookingZone } from "@shared/leadTime";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SERVICE_LABELS } from "./adminShared";

type Result = {
  reference: string;
  payUrl: string;
  basePrice: number | null;
  deposit: number | null;
  emailSent: boolean;
  sqftCorrected: boolean;
  sqft: number | null;
  customerWillChoose: string[];
};

const FREQUENCY_LABELS: Record<string, string> = {
  onetime: "One-time",
  weekly: "Weekly",
  biweekly: "Every two weeks",
  monthly: "Monthly",
};

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <Label className="text-xs font-semibold">{label}</Label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A collapsed optional section. Filled-in state is surfaced on the trigger so
 * the owner can see at a glance what the link will still ask for.
 */
function KnowSection({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span>
          <span className="block text-sm font-semibold text-foreground">{title}</span>
          {summary && <span className="mt-0.5 block text-xs text-muted-foreground">{summary}</span>}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="space-y-3 border-t border-border px-4 py-3">{children}</div>}
    </div>
  );
}

export function NewBookingDialog() {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [openSection, setOpenSection] = useState<string | null>(null);

  // The floor: who, and how to reach them.
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [locale, setLocale] = useState<"en" | "es">("en");

  // Everything he happens to know.
  const [serviceType, setServiceType] = useState<string>("");
  const [frequency, setFrequency] = useState<string>("onetime");
  const [sqft, setSqft] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [bathrooms, setBathrooms] = useState("");
  const [address, setAddress] = useState("");
  const [propertyType, setPropertyType] = useState<"house" | "apartment">("house");
  const [unitNumber, setUnitNumber] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [overrideNotice, setOverrideNotice] = useState(false);
  const [notes, setNotes] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [sendEmail, setSendEmail] = useState(true);

  // Exact figure, clamped to the range the server accepts (200–20,000): the
  // owner types "1732", not a step on a slider.
  const sqftNumber = Math.min(20000, Math.max(200, Number(sqft)));
  const sqftValid = sqft.trim() !== "" && Number.isFinite(Number(sqft)) && Number(sqft) >= 200;

  /**
   * Slot grid from the same public availability query the booking calendar
   * uses — hours, lunch, taken slots and all. Only fetched once a date is
   * typed, and only offered at all inside the schedule section.
   */
  const availability = trpc.booking.availability.useQuery(
    {
      date,
      serviceType: (serviceType || undefined) as (typeof CLEANING_TYPES)[number] | undefined,
      sqft: sqftValid ? sqftNumber : undefined,
    },
    { enabled: open && /^\d{4}-\d{2}-\d{2}$/.test(date) }
  );
  const slots = useMemo(() => availability.data ?? [], [availability.data]);

  const create = trpc.admin.createBooking.useMutation({
    onSuccess: data => {
      setResult(data);
      utils.admin.bookings.invalidate();
      utils.admin.stats.invalidate();
      utils.booking.availability.invalidate();
      toast.success(
        data.emailSent ? "Booking created — deposit link emailed" : "Booking created — copy the link below"
      );
    },
    onError: error => toast.error(error.message || "Failed to create booking"),
  });

  const contactValid = name.trim() !== "" && (phone.trim().length >= 7 || /.+@.+\..+/.test(email));
  const scheduleConsistent = Boolean(date) === Boolean(time);
  const valid = contactValid && scheduleConsistent;

  const reset = () => {
    setResult(null);
    setOpenSection(null);
    setName("");
    setPhone("");
    setEmail("");
    setServiceType("");
    setSqft("");
    setBedrooms("");
    setBathrooms("");
    setAddress("");
    setPropertyType("house");
    setUnitNumber("");
    setCity("");
    setZip("");
    setDate("");
    setTime("");
    setOverrideNotice(false);
    setNotes("");
    setCouponCode("");
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied — paste it into a text message");
    } catch {
      toast.error("Couldn't copy — select the link and copy it manually");
    }
  };

  // Summaries let the collapsed form show what is already locked.
  const serviceSummary = serviceType
    ? `${SERVICE_LABELS[serviceType] ?? serviceType}${frequency !== "onetime" ? ` · ${FREQUENCY_LABELS[frequency]}` : ""}`
    : "They'll choose on the link";
  const sizeSummary = address
    ? `${address}${propertyType === "apartment" ? `${unitNumber ? ` · Apt ${unitNumber}` : ""} · apartment` : ""}${
        sqftValid
          ? ` · ${sqftNumber.toLocaleString()} ft²`
          : propertyType === "house"
            ? " · county records will size it"
            : ""
      }`
    : sqftValid
      ? `${sqftNumber.toLocaleString()} ft²${propertyType === "apartment" ? " · apartment" : ""}`
      : "They'll size it on the link";
  const scheduleSummary = date && time ? `${date} at ${time} — held 24h` : "They'll pick a time on the link";

  // Split "Maria de la Cruz" on the first space: firstName carries the
  // greeting, everything else is the last name.
  const [firstName, ...restName] = name.trim().split(/\s+/);

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button className="rounded-xl">
          <CalendarDays className="mr-2 h-4 w-4" /> New booking
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New booking</DialogTitle>
          <DialogDescription>
            Name and one way to reach them is enough — whatever you skip, they fill in on their link.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-900">
                Booking {result.reference} created{time ? " — the slot is held" : ""}.
              </p>
              {result.basePrice != null && result.deposit != null ? (
                <p className="mt-1 text-xs text-emerald-800">
                  Base price {`$${result.basePrice}`} · deposit {`$${result.deposit}`}. Both go up if they add
                  extras — the link recalculates before they pay.
                </p>
              ) : (
                <p className="mt-1 text-xs text-emerald-800">
                  Price appears once they finish choosing — it's computed live as they go.
                </p>
              )}
              {result.sqftCorrected && result.sqft != null && (
                <p className="mt-1 text-xs text-emerald-800">
                  Size corrected to {result.sqft.toLocaleString()} sq ft from county records — priced from the
                  verified figure.
                </p>
              )}
              {result.customerWillChoose.length > 0 && (
                <p className="mt-1 text-xs text-emerald-800">
                  They'll choose: {result.customerWillChoose.join(", ")}.
                </p>
              )}
              <p className="mt-1 text-xs text-emerald-800">
                {result.emailSent
                  ? "The deposit link has been emailed to them."
                  : "No email sent — copy the link below and text it to them."}
              </p>
            </div>
            <div>
              <Label className="text-xs font-semibold">Deposit link</Label>
              <div className="mt-1.5 flex gap-2">
                <Input readOnly value={result.payUrl} className="rounded-xl font-mono text-xs" />
                <Button type="button" variant="outline" className="rounded-xl" onClick={() => copyLink(result.payUrl)}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex gap-2">
              <Button className="rounded-xl" onClick={() => setOpen(false)}>
                Done
              </Button>
              <Button variant="outline" className="rounded-xl" onClick={reset}>
                Add another
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* The floor — everything the link cannot work without. */}
            <Field label="Customer name">
              <Input
                className="rounded-xl"
                autoFocus
                placeholder="Maria Lopez"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Phone" hint="For texting them the link.">
                <Input
                  className="rounded-xl"
                  type="tel"
                  inputMode="tel"
                  placeholder="(210) 555-0134"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                />
              </Field>
              <Field label="Email" hint="For emailing it instead — either works.">
                <Input
                  className="rounded-xl"
                  type="email"
                  inputMode="email"
                  placeholder="maria@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Their language" hint="Drives their email and their booking page.">
              <select
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                value={locale}
                onChange={e => setLocale(e.target.value as "en" | "es")}
              >
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </Field>

            {/* Add what you know. */}
            <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Add what you know — optional
            </p>

            <KnowSection
              title="Service"
              summary={serviceSummary}
              open={openSection === "service"}
              onToggle={() => setOpenSection(openSection === "service" ? null : "service")}
            >
              <Field label="Service type">
                <select
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                  value={serviceType}
                  onChange={e => setServiceType(e.target.value)}
                >
                  <option value="">Let them choose</option>
                  {CLEANING_TYPES.map(t => (
                    <option key={t} value={t}>
                      {SERVICE_LABELS[t] ?? t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Frequency">
                <select
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                  value={frequency}
                  onChange={e => setFrequency(e.target.value)}
                >
                  {FREQUENCIES.map(f => (
                    <option key={f} value={f}>
                      {FREQUENCY_LABELS[f] ?? f}
                    </option>
                  ))}
                </select>
              </Field>
            </KnowSection>

            <KnowSection
              title="Home"
              summary={sizeSummary}
              open={openSection === "home"}
              onToggle={() => setOpenSection(openSection === "home" ? null : "home")}
            >
              <Field
                label="Property type"
                hint={
                  propertyType === "apartment"
                    ? "County records size whole buildings, not units — verification is skipped and the sqft you enter stands."
                    : "Houses verify against county records; the verified figure wins if it prices higher."
                }
              >
                <div className="grid grid-cols-2 gap-2">
                  {(["house", "apartment"] as const).map(kind => (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={propertyType === kind}
                      onClick={() => setPropertyType(kind)}
                      className={`h-10 rounded-xl border text-sm font-semibold transition-colors ${
                        propertyType === kind
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {kind === "house" ? "House" : "Apartment / Condo"}
                    </button>
                  ))}
                </div>
              </Field>
              <Field
                label="Street address"
                hint={propertyType === "house" ? "With an address, county records size the home for you." : undefined}
              >
                <div className="flex gap-2">
                  <Input className="flex-1 rounded-xl" value={address} onChange={e => setAddress(e.target.value)} />
                  {propertyType === "apartment" && (
                    <Input
                      className="w-24 rounded-xl"
                      placeholder="Unit #"
                      value={unitNumber}
                      onChange={e => setUnitNumber(e.target.value)}
                    />
                  )}
                </div>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="City">
                  <Input className="rounded-xl" placeholder="San Antonio" value={city} onChange={e => setCity(e.target.value)} />
                </Field>
                <Field label="ZIP">
                  <Input className="rounded-xl" value={zip} onChange={e => setZip(e.target.value)} />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Sq ft (if known)" hint="Exact number, 200–20,000.">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={200}
                    max={20000}
                    step={1}
                    className="rounded-xl"
                    value={sqft}
                    onChange={e => setSqft(e.target.value)}
                  />
                </Field>
                <Field label="Bedrooms">
                  <Input type="number" inputMode="numeric" className="rounded-xl" placeholder="2" value={bedrooms} onChange={e => setBedrooms(e.target.value)} />
                </Field>
                <Field label="Bathrooms">
                  <Input type="number" inputMode="numeric" className="rounded-xl" placeholder="1" value={bathrooms} onChange={e => setBathrooms(e.target.value)} />
                </Field>
              </div>
            </KnowSection>

            <KnowSection
              title="Schedule"
              summary={scheduleSummary}
              open={openSection === "schedule"}
              onToggle={() => setOpenSection(openSection === "schedule" ? null : "schedule")}
            >
              <Field label="Date">
                <Input
                  type="date"
                  className="rounded-xl"
                  min={todayInBookingZone()}
                  value={date}
                  onChange={e => {
                    setDate(e.target.value);
                    setTime("");
                  }}
                />
              </Field>
              {date && (
                <Field
                  label="Time"
                  hint={
                    overrideNotice
                      ? "Notice period overridden — times inside it are offered, but a slot that has already started is not."
                      : "Only times the calendar would offer a customer. Picking one holds the slot for 24 hours."
                  }
                >
                  {availability.isLoading ? (
                    <div className="flex h-10 items-center text-xs text-muted-foreground">
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Checking availability…
                    </div>
                  ) : slots.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Closed that day — pick another date.</p>
                  ) : (
                    <div className="grid grid-cols-4 gap-1.5">
                      {slots.map(slot => {
                        // The override only relaxes the notice period, so a
                        // slot the schedule never offers stays unavailable
                        // either way. The server re-checks all of it.
                        const selectable = slot.available || overrideNotice;
                        return (
                          <button
                            key={slot.time}
                            type="button"
                            disabled={!selectable}
                            onClick={() => setTime(slot.time)}
                            className={`h-9 rounded-lg border text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                              time === slot.time
                                ? "border-primary bg-primary text-primary-foreground"
                                : slot.available
                                  ? "border-border bg-card hover:border-primary/40"
                                  : "border-dashed border-amber-400 bg-amber-50 text-amber-800"
                            }`}
                            title={slot.available ? undefined : "Inside the notice period — needs the override"}
                          >
                            {slot.time}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </Field>
              )}
              {date && (
                <label className="flex items-start gap-2.5 rounded-xl border border-border px-4 py-3">
                  <Checkbox
                    checked={overrideNotice}
                    onCheckedChange={v => setOverrideNotice(v === true)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-foreground">Override notice period</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Lets you book inside the minimum-notice window for someone on the phone. Every other rule
                      still applies. If they pick their own time on the link instead, the normal notice period
                      applies to them.
                    </span>
                  </span>
                </label>
              )}
            </KnowSection>

            <KnowSection
              title="Notes & coupon"
              summary={notes || couponCode ? [notes && "notes", couponCode && couponCode].filter(Boolean).join(" · ") : "Internal notes, discount code"}
              open={openSection === "notes"}
              onToggle={() => setOpenSection(openSection === "notes" ? null : "notes")}
            >
              <Field label="Internal notes" hint="Never shown to the customer. Their own access notes get appended when they book.">
                <Textarea className="rounded-xl" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
              </Field>
              <Field label="Coupon code">
                <Input
                  className="rounded-xl uppercase"
                  value={couponCode}
                  onChange={e => setCouponCode(e.target.value.toUpperCase())}
                />
              </Field>
            </KnowSection>

            <label
              className={`flex items-start gap-2.5 rounded-xl border border-border px-4 py-3 ${
                /.+@.+\..+/.test(email) ? "" : "opacity-50"
              }`}
            >
              <Checkbox
                checked={sendEmail && /.+@.+\..+/.test(email)}
                disabled={!/.+@.+\..+/.test(email)}
                onCheckedChange={v => setSendEmail(v === true)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-semibold text-foreground">Email them the deposit link</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Needs an email address. Leave it off — or blank — and you'll get the link to copy into a text.
                </span>
              </span>
            </label>

            <Button
              className="w-full rounded-xl"
              disabled={!valid || create.isPending}
              onClick={() =>
                create.mutate({
                  firstName: firstName ?? "",
                  lastName: restName.join(" ") || undefined,
                  email: email.trim() || undefined,
                  phone: phone.trim() || undefined,
                  locale,
                  serviceType: (serviceType || undefined) as (typeof CLEANING_TYPES)[number] | undefined,
                  frequency: frequency as (typeof FREQUENCIES)[number],
                  bedrooms: bedrooms.trim() ? Number(bedrooms) : undefined,
                  bathrooms: bathrooms.trim() ? Number(bathrooms) : undefined,
                  sqft: sqftValid ? sqftNumber : undefined,
                  address: address.trim() || undefined,
                  propertyType,
                  unitNumber: propertyType === "apartment" ? unitNumber.trim() || undefined : undefined,
                  city: city.trim() || (address.trim() ? "San Antonio" : undefined),
                  zip: zip.trim() || undefined,
                  date: date || undefined,
                  time: time || undefined,
                  notes: notes.trim() || undefined,
                  couponCode: couponCode.trim() || undefined,
                  overrideNotice,
                  sendEmail: sendEmail && /.+@.+\..+/.test(email),
                })
              }
            >
              {create.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…
                </>
              ) : (
                "Create booking & get link"
              )}
            </Button>
            {!scheduleConsistent && (
              <p className="text-xs text-amber-700">Pick a time for that date — or clear the date and let them choose.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

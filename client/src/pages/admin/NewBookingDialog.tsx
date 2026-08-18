/**
 * Admin → Appointments → "New booking".
 *
 * For the customer who called or texted for a price and will never open the
 * website. The owner takes down what they need to hold a slot; the customer
 * finishes the rest on a link.
 *
 * Deliberately absent from this form: extras, and any price field. Extras are
 * the customer's own choice on the pay page, and every dollar figure is
 * computed on the server from the live pricing config — there is nowhere here
 * to type an amount, because there is nowhere for one to be trusted from.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, Copy, Loader2 } from "lucide-react";
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
  basePrice: number;
  deposit: number;
  emailSent: boolean;
  sqftCorrected: boolean;
  sqft: number;
};

const FREQUENCY_LABELS: Record<string, string> = {
  onetime: "One-time",
  weekly: "Weekly",
  biweekly: "Every two weeks",
  monthly: "Monthly",
};

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <Label className="text-xs font-semibold">{label}</Label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NewBookingDialog() {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const [serviceType, setServiceType] = useState<string>("residential");
  const [frequency, setFrequency] = useState<string>("onetime");
  const [bedrooms, setBedrooms] = useState("2");
  const [bathrooms, setBathrooms] = useState("1");
  const [sqft, setSqft] = useState("1200");
  const [date, setDate] = useState(todayInBookingZone());
  const [time, setTime] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("San Antonio");
  const [zip, setZip] = useState("");
  const [notes, setNotes] = useState("");
  const [locale, setLocale] = useState<"en" | "es">("en");
  const [couponCode, setCouponCode] = useState("");
  const [overrideNotice, setOverrideNotice] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);

  const sqftNumber = Number(sqft);

  /**
   * The slots the calendar would offer for this job, from the same query the
   * public booking page uses — so the owner is choosing from exactly what a
   * customer could choose from, hours, lunch, taken slots and all.
   *
   * The notice-period override is applied on top here rather than asked of the
   * server: the query is the public one, and the whole point of the override is
   * that it is the owner's to make.
   */
  const availability = trpc.booking.availability.useQuery(
    {
      date,
      serviceType: serviceType as (typeof CLEANING_TYPES)[number],
      sqft: Number.isFinite(sqftNumber) && sqftNumber >= 200 ? sqftNumber : undefined,
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

  const valid =
    firstName.trim() !== "" &&
    lastName.trim() !== "" &&
    /.+@.+\..+/.test(email) &&
    phone.trim().length >= 7 &&
    address.trim() !== "" &&
    city.trim() !== "" &&
    zip.trim().length >= 3 &&
    time !== "" &&
    Number.isFinite(sqftNumber) &&
    sqftNumber >= 200;

  const reset = () => {
    setResult(null);
    setTime("");
    setFirstName("");
    setLastName("");
    setEmail("");
    setPhone("");
    setAddress("");
    setZip("");
    setNotes("");
    setCouponCode("");
    setOverrideNotice(false);
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied — paste it into a text message");
    } catch {
      toast.error("Couldn't copy — select the link and copy it manually");
    }
  };

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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New booking</DialogTitle>
          <DialogDescription>
            For a customer who called or texted. Enter what you agreed — they'll pick their own extras and pay
            the deposit on a personal link.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-900">
                Booking {result.reference} created — the slot is held.
              </p>
              <p className="mt-1 text-xs text-emerald-800">
                Base price {`$${result.basePrice}`} · deposit {`$${result.deposit}`}. Both go up if they add
                extras — the link recalculates before they pay.
              </p>
              {result.sqftCorrected && (
                <p className="mt-1 text-xs text-emerald-800">
                  Size corrected to {result.sqft.toLocaleString()} sq ft from county records — priced from the
                  verified figure.
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
            <div className="grid gap-3 sm:grid-cols-2">
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
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Square feet" hint="Checked against county records — the verified figure wins if it prices higher.">
                <Input type="number" inputMode="numeric" className="rounded-xl" value={sqft} onChange={e => setSqft(e.target.value)} />
              </Field>
              <Field label="Bedrooms">
                <Input type="number" inputMode="numeric" className="rounded-xl" value={bedrooms} onChange={e => setBedrooms(e.target.value)} />
              </Field>
              <Field label="Bathrooms">
                <Input type="number" inputMode="numeric" className="rounded-xl" value={bathrooms} onChange={e => setBathrooms(e.target.value)} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date">
                <Input type="date" className="rounded-xl" value={date} onChange={e => { setDate(e.target.value); setTime(""); }} />
              </Field>
              <Field
                label="Time"
                hint={
                  overrideNotice
                    ? "Notice period overridden — times inside it are offered, but a slot that has already started is not."
                    : "Only times the calendar would offer a customer."
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
                      // The override only relaxes the notice period, so a slot
                      // the schedule never offers stays unavailable either way.
                      // The server re-checks all of it regardless.
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
            </div>

            <label className="flex items-start gap-2.5 rounded-xl border border-border px-4 py-3">
              <Checkbox
                checked={overrideNotice}
                onCheckedChange={v => setOverrideNotice(v === true)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-semibold text-foreground">Override notice period</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Lets you book inside the minimum-notice window for someone on the phone. Every other rule —
                  opening hours, the lunch break, jobs already booked, finishing before closing — still applies,
                  and a slot that has already started is still refused.
                </span>
              </span>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name">
                <Input className="rounded-xl" value={firstName} onChange={e => setFirstName(e.target.value)} />
              </Field>
              <Field label="Last name">
                <Input className="rounded-xl" value={lastName} onChange={e => setLastName(e.target.value)} />
              </Field>
              <Field label="Email">
                <Input type="email" className="rounded-xl" value={email} onChange={e => setEmail(e.target.value)} />
              </Field>
              <Field label="Phone">
                <Input className="rounded-xl" value={phone} onChange={e => setPhone(e.target.value)} />
              </Field>
            </div>

            <Field label="Street address">
              <Input className="rounded-xl" value={address} onChange={e => setAddress(e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="City">
                <Input className="rounded-xl" value={city} onChange={e => setCity(e.target.value)} />
              </Field>
              <Field label="ZIP">
                <Input className="rounded-xl" value={zip} onChange={e => setZip(e.target.value)} />
              </Field>
            </div>

            <Field label="Notes" hint="Gate codes, parking, pets, anything the crew should know.">
              <Textarea className="rounded-xl" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Language" hint="Their email and pay page use this.">
                <select
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                  value={locale}
                  onChange={e => setLocale(e.target.value as "en" | "es")}
                >
                  <option value="en">English</option>
                  <option value="es">Español</option>
                </select>
              </Field>
              <Field label="Coupon code (optional)">
                <Input
                  className="rounded-xl uppercase"
                  value={couponCode}
                  onChange={e => setCouponCode(e.target.value.toUpperCase())}
                />
              </Field>
            </div>

            <label className="flex items-start gap-2.5 rounded-xl border border-border px-4 py-3">
              <Checkbox checked={sendEmail} onCheckedChange={v => setSendEmail(v === true)} className="mt-0.5" />
              <span>
                <span className="block text-sm font-semibold text-foreground">Email them the deposit link</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Leave this off if you'd rather text it — you'll get the link to copy either way.
                </span>
              </span>
            </label>

            <Button
              className="w-full rounded-xl"
              disabled={!valid || create.isPending}
              onClick={() =>
                create.mutate({
                  serviceType: serviceType as (typeof CLEANING_TYPES)[number],
                  frequency: frequency as (typeof FREQUENCIES)[number],
                  bedrooms: Number(bedrooms) || 0,
                  bathrooms: Number(bathrooms) || 1,
                  sqft: sqftNumber,
                  date,
                  time,
                  firstName: firstName.trim(),
                  lastName: lastName.trim(),
                  email: email.trim(),
                  phone: phone.trim(),
                  address: address.trim(),
                  city: city.trim(),
                  zip: zip.trim(),
                  notes: notes.trim() || undefined,
                  locale,
                  couponCode: couponCode.trim() || undefined,
                  overrideNotice,
                  sendEmail,
                })
              }
            >
              {create.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…
                </>
              ) : (
                "Create booking & issue deposit link"
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_SCHEDULE,
  parseSchedule,
  SCHEDULE_SETTING_KEY,
  type WeeklySchedule,
} from "@shared/schedule";
import { PageHeader } from "./adminShared";

type Field = { key: string; label: string; placeholder: string; hint?: string };

const SECTIONS: { title: string; description: string; fields: Field[] }[] = [
  {
    title: "Contact information",
    description: "Shown in the site footer, contact page, confirmation emails, and search-engine listings.",
    fields: [
      { key: "business_phone", label: "Business phone", placeholder: "(210) 555-0123" },
      { key: "business_email", label: "Business email", placeholder: "hello@yourbusiness.com" },
      { key: "business_hours", label: "Business hours", placeholder: "Mon–Sat, 8:00 AM – 6:00 PM" },
      { key: "service_area", label: "Service area", placeholder: "San Antonio metro & surrounding areas" },
    ],
  },
  {
    title: "Social links",
    description: "Added to the site footer when filled in.",
    fields: [
      { key: "instagram_url", label: "Instagram URL", placeholder: "https://instagram.com/yourbusiness" },
      { key: "facebook_url", label: "Facebook URL", placeholder: "https://facebook.com/yourbusiness" },
    ],
  },
  {
    title: "Homepage stats",
    description:
      "The stats band on the homepage only appears when these are filled in — enter real numbers as your business grows. Leave blank to hide.",
    fields: [
      { key: "stats_clients", label: "Happy clients", placeholder: "e.g. 150+" },
      { key: "stats_cleanings", label: "Cleanings completed", placeholder: "e.g. 1,200+" },
      { key: "stats_years", label: "Years of experience", placeholder: "e.g. 5" },
      { key: "stats_rating", label: "Average rating", placeholder: "e.g. 4.9" },
    ],
  },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Render order: Monday first, Sunday last. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
/** Selectable hours (6 AM – 9 PM start, up to 10 PM close). */
const HOUR_OPTIONS = Array.from({ length: 17 }, (_, i) => i + 6);

function hourLabel(h: number): string {
  if (h === 12) return "12:00 PM";
  if (h === 24) return "12:00 AM";
  return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
}

function BookingHoursSection() {
  const utils = trpc.useUtils();
  const settings = trpc.admin.settings.useQuery();
  const save = trpc.admin.saveSetting.useMutation({
    onSuccess: () => {
      utils.admin.settings.invalidate();
      utils.booking.schedule.invalidate();
      toast.success("Booking hours saved — live on the booking calendar");
    },
    onError: () => toast.error("Failed to save booking hours"),
  });

  const [schedule, setSchedule] = useState<WeeklySchedule>(DEFAULT_SCHEDULE);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (settings.data && !dirty) {
      const raw = settings.data.find(s => s.settingKey === SCHEDULE_SETTING_KEY)?.settingValue ?? null;
      setSchedule(parseSchedule(raw));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);

  const updateDay = (day: number, patch: Partial<WeeklySchedule[number]>) => {
    setDirty(true);
    setSchedule(prev => {
      const current = { ...prev[day], ...patch };
      if (current.start >= current.end) current.end = Math.min(24, current.start + 1);
      return { ...prev, [day]: current };
    });
  };

  return (
    <div className="rounded-2xl bg-card p-8 shadow-sm ring-1 ring-border">
      <h2 className="font-display text-lg font-bold text-foreground">Booking hours</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Controls which days and time slots customers can book. Slots are hourly; the last appointment starts one
        hour before closing. Sunday stays closed unless you switch it on here.
      </p>
      <div className="mt-6 space-y-3">
        {DAY_ORDER.map(day => {
          const d = schedule[day];
          return (
            <div
              key={day}
              className={`flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-3 transition-opacity ${
                d.open ? "" : "opacity-60"
              }`}
            >
              <div className="flex w-36 items-center gap-3">
                <Switch
                  checked={d.open}
                  onCheckedChange={open => updateDay(day, { open })}
                  aria-label={`${DAY_NAMES[day]} open`}
                />
                <span className="text-sm font-semibold text-foreground">{DAY_NAMES[day]}</span>
              </div>
              {d.open ? (
                <div className="flex items-center gap-2 text-sm">
                  <select
                    className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                    value={d.start}
                    onChange={e => updateDay(day, { start: Number(e.target.value) })}
                    aria-label={`${DAY_NAMES[day]} opening time`}
                  >
                    {HOUR_OPTIONS.map(h => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">to</span>
                  <select
                    className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                    value={d.end}
                    onChange={e => updateDay(day, { end: Number(e.target.value) })}
                    aria-label={`${DAY_NAMES[day]} closing time`}
                  >
                    {HOUR_OPTIONS.filter(h => h > d.start).map(h => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Closed — no bookings accepted</span>
              )}
            </div>
          );
        })}
      </div>
      <Button
        className="mt-5 rounded-xl"
        disabled={save.isPending || !dirty}
        onClick={() => {
          save.mutate({ key: SCHEDULE_SETTING_KEY, value: JSON.stringify(schedule) });
          setDirty(false);
        }}
      >
        Save booking hours
      </Button>
    </div>
  );
}

export default function AdminSettings() {
  const utils = trpc.useUtils();
  const settings = trpc.admin.settings.useQuery();
  const save = trpc.admin.saveSetting.useMutation({
    onSuccess: () => {
      utils.admin.settings.invalidate();
      utils.content.siteInfo.invalidate();
      toast.success("Setting saved — live on the site");
    },
    onError: () => toast.error("Failed to save setting"),
  });

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (settings.data) {
      const map: Record<string, string> = {};
      for (const s of settings.data) map[s.settingKey] = s.settingValue ?? "";
      setValues(map);
    }
  }, [settings.data]);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Business information that powers the public site, emails, and search listings"
      />
      {settings.isLoading ? (
        <div className="max-w-2xl space-y-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div className="max-w-2xl space-y-6">
          {SECTIONS.map(section => (
            <div key={section.title} className="rounded-2xl bg-card p-8 shadow-sm ring-1 ring-border">
              <h2 className="font-display text-lg font-bold text-foreground">{section.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
              <div className="mt-6 space-y-5">
                {section.fields.map(f => (
                  <div key={f.key}>
                    <Label htmlFor={`setting-${f.key}`}>{f.label}</Label>
                    <div className="mt-1.5 flex gap-2">
                      <Input
                        id={`setting-${f.key}`}
                        placeholder={f.placeholder}
                        className="rounded-xl"
                        value={values[f.key] ?? ""}
                        onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                      />
                      <Button
                        variant="outline"
                        className="rounded-xl bg-card"
                        disabled={save.isPending}
                        onClick={() => save.mutate({ key: f.key, value: (values[f.key] ?? "").trim() })}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <BookingHoursSection />
          <p className="rounded-xl bg-muted/50 p-4 text-xs leading-relaxed text-muted-foreground">
            Changes go live on the public site right away. Anything left blank is hidden automatically, so the site
            never shows placeholder details.
          </p>
        </div>
      )}
    </div>
  );
}

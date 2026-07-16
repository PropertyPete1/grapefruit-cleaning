import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
          <p className="rounded-xl bg-muted/50 p-4 text-xs leading-relaxed text-muted-foreground">
            Changes go live on the public site right away. Anything left blank is hidden automatically, so the site
            never shows placeholder details.
          </p>
        </div>
      )}
    </div>
  );
}

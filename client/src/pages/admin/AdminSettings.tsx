import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "./adminShared";

const FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: "business_phone", label: "Business phone", placeholder: "(555) 472-3384" },
  { key: "business_email", label: "Business email", placeholder: "hello@grapefruitcleaning.com" },
  { key: "business_hours", label: "Business hours", placeholder: "Mon–Sat, 8:00 AM – 6:00 PM" },
  { key: "service_area", label: "Service area", placeholder: "Austin metro & surrounding areas" },
  { key: "instagram_url", label: "Instagram URL", placeholder: "https://instagram.com/…" },
  { key: "facebook_url", label: "Facebook URL", placeholder: "https://facebook.com/…" },
];

export default function AdminSettings() {
  const utils = trpc.useUtils();
  const settings = trpc.admin.settings.useQuery();
  const save = trpc.admin.saveSetting.useMutation({
    onSuccess: () => {
      utils.admin.settings.invalidate();
      toast.success("Setting saved");
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
      <PageHeader title="Settings" subtitle="Business information used across the site" />
      <div className="max-w-2xl rounded-2xl bg-card p-8 shadow-sm ring-1 ring-border">
        {settings.isLoading ? (
          <div className="space-y-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            {FIELDS.map(f => (
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
                    onClick={() => save.mutate({ key: f.key, value: values[f.key] ?? "" })}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ))}
            <p className="rounded-xl bg-muted/50 p-4 text-xs leading-relaxed text-muted-foreground">
              Note: the public site currently displays the brand's default contact details. Settings saved here are
              stored in the database and can be wired to the public pages on request.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}


import { useState } from "react";
import { CheckCircle2, Clock, Loader2, Mail, MapPin, Phone, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { useSiteInfo } from "@/hooks/useSiteInfo";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function Contact() {
  const { t, locale } = useLocale();
  const { info: site } = useSiteInfo();
  useSeo({ title: t.meta.contact.title, description: t.meta.contact.description, jsonLd: [localBusinessJsonLd(site)] });
  useReveal([locale]);

  const [form, setForm] = useState({ name: "", email: "", phone: "", subject: "", message: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  const submitMutation = trpc.contact.submit.useMutation({
    onSuccess: () => setSent(true),
    onError: () => toast.error(t.common.error),
  });

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = t.booking.validation.required;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errs.email = t.booking.validation.email;
    if (!form.message.trim()) errs.message = t.booking.validation.required;
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    submitMutation.mutate({ ...form, locale });
  };

  const info = [
    { icon: Phone, label: t.contact.phoneLabel, value: site.business_phone },
    { icon: Mail, label: t.contact.emailLabel, value: site.business_email },
    { icon: Clock, label: t.contact.hoursLabel, value: site.business_hours },
    { icon: MapPin, label: t.contact.areaLabel, value: site.service_area },
  ].filter((item) => item.value);

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-12 md:pt-44 md:pb-16">
        <div
          className="pointer-events-none absolute -top-32 left-1/4 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <h1 className="reveal font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.contact.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "80ms" }}>
            {t.contact.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-24 md:pb-32">
        <div className="grid gap-10 lg:grid-cols-5 lg:gap-14">
          <div className="lg:col-span-2">
            <div className="reveal space-y-5">
              <h2 className="font-display text-xl font-bold text-foreground">{t.contact.infoTitle}</h2>
              {info.length === 0 && (
                <p className="rounded-2xl border border-border bg-card p-5 text-sm leading-relaxed text-muted-foreground shadow-soft">
                  {locale === "es"
                    ? "La forma más rápida de contactarnos es enviando el formulario — respondemos en menos de una hora hábil."
                    : "The fastest way to reach us is the message form — we respond within one business hour."}
                </p>
              )}
              {info.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="flex items-start gap-4 rounded-2xl border border-border bg-card p-5 shadow-soft">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </span>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</p>
                      <p className="mt-0.5 text-sm font-medium text-foreground">{item.value}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-3">
            <div className="reveal rounded-3xl border border-border bg-card p-6 shadow-soft-lg md:p-10" style={{ transitionDelay: "100ms" }}>
              {sent ? (
                <div className="py-12 text-center">
                  <CheckCircle2 className="mx-auto h-14 w-14 text-secondary" />
                  <h2 className="mt-5 font-display text-2xl font-bold text-foreground">{t.contact.successTitle}</h2>
                  <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">{t.contact.successText}</p>
                </div>
              ) : (
                <>
                  <h2 className="font-display text-xl font-bold text-foreground">{t.contact.formTitle}</h2>
                  <form onSubmit={onSubmit} className="mt-6 space-y-5" noValidate>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="name">{t.contact.name}</Label>
                        <Input
                          id="name"
                          value={form.name}
                          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                          className="rounded-xl"
                          aria-invalid={!!errors.name}
                        />
                        {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="email">{t.contact.email}</Label>
                        <Input
                          id="email"
                          type="email"
                          value={form.email}
                          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                          className="rounded-xl"
                          aria-invalid={!!errors.email}
                        />
                        {errors.email && <p className="text-xs text-destructive">{errors.email}</p>}
                      </div>
                    </div>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="phone">
                          {t.contact.phone} <span className="text-muted-foreground">({t.common.optional})</span>
                        </Label>
                        <Input
                          id="phone"
                          type="tel"
                          value={form.phone}
                          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                          className="rounded-xl"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="subject">
                          {t.contact.subject} <span className="text-muted-foreground">({t.common.optional})</span>
                        </Label>
                        <Input
                          id="subject"
                          value={form.subject}
                          onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                          className="rounded-xl"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="message">{t.contact.message}</Label>
                      <Textarea
                        id="message"
                        rows={5}
                        placeholder={t.contact.messagePlaceholder}
                        value={form.message}
                        onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                        className="rounded-xl"
                        aria-invalid={!!errors.message}
                      />
                      {errors.message && <p className="text-xs text-destructive">{errors.message}</p>}
                    </div>
                    <Button
                      type="submit"
                      size="lg"
                      disabled={submitMutation.isPending}
                      className="press w-full rounded-full shadow-soft-lg sm:w-auto sm:px-10"
                    >
                      {submitMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t.contact.sending}
                        </>
                      ) : (
                        <>
                          <Send className="mr-2 h-4 w-4" />
                          {t.contact.send}
                        </>
                      )}
                    </Button>
                  </form>
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

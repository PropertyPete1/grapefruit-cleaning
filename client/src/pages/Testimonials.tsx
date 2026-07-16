import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Loader2, MessageSquareQuote, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { useSiteInfo } from "@/hooks/useSiteInfo";
import { useSpamGuard } from "@/hooks/useSpamGuard";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function Testimonials() {
  const { t, locale, path } = useLocale();
  const { info: site } = useSiteInfo();
  useSeo({
    title: t.meta.testimonials.title,
    description: t.meta.testimonials.description,
    jsonLd: [localBusinessJsonLd(site)],
  });

  // Live approved reviews — no seeded or illustrative testimonials.
  const reviews = trpc.content.reviews.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  useReveal([locale, reviews.data?.length]);

  const isSpanish = locale === "es";

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-12 md:pt-44 md:pb-16">
        <div
          className="pointer-events-none absolute -top-32 left-1/3 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <div className="reveal flex items-center justify-center gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} className="h-6 w-6 fill-amber-400 text-amber-400" />
            ))}
          </div>
          <h1 className="reveal mt-5 font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl" style={{ transitionDelay: "60ms" }}>
            {t.testimonials.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "120ms" }}>
            {t.testimonials.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-20 md:pb-28">
        {reviews.isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-48 rounded-3xl" />
            ))}
          </div>
        ) : (reviews.data ?? []).length > 0 ? (
          <div className="columns-1 gap-6 md:columns-2 lg:columns-3 [&>*]:mb-6">
            {(reviews.data ?? []).map((item, i) => (
              <figure
                key={item.id}
                className="reveal hover-lift break-inside-avoid rounded-3xl border border-border bg-card p-7 shadow-soft"
                style={{ transitionDelay: `${(i % 3) * 70}ms` }}
              >
                <div className="flex">
                  {Array.from({ length: item.rating }).map((_, j) => (
                    <Star key={j} className="h-4 w-4 fill-amber-400 text-amber-400" />
                  ))}
                </div>
                <blockquote className="mt-4 text-sm leading-relaxed text-foreground md:text-base">“{item.text}”</blockquote>
                <figcaption className="mt-5 border-t border-border pt-4">
                  <p className="font-display text-sm font-bold text-foreground">{item.customerName}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="reveal mx-auto max-w-xl rounded-3xl border border-dashed border-border bg-card/50 p-10 text-center">
            <MessageSquareQuote className="mx-auto h-10 w-10 text-muted-foreground/50" />
            <h2 className="mt-4 font-display text-lg font-bold text-foreground">
              {isSpanish ? "Sea el primero en dejar una reseña" : "Be the first to leave a review"}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {isSpanish
                ? "Las reseñas de clientes reales aparecerán aquí una vez aprobadas."
                : "Reviews from real clients will appear here once approved."}
            </p>
          </div>
        )}

        <ReviewForm />

        <div className="reveal mt-10 text-center">
          <Button asChild size="lg" className="press rounded-full px-8 shadow-soft-lg">
            <Link href={path("booking")}>
              {t.common.bookYourCleaning}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </>
  );
}

function ReviewForm() {
  const { locale } = useLocale();
  const isSpanish = locale === "es";
  const [form, setForm] = useState({ customerName: "", rating: 5, text: "" });
  const [sent, setSent] = useState(false);
  const { honeypotField, spamSignals } = useSpamGuard();

  const submit = trpc.content.submitReview.useMutation({
    onSuccess: () => setSent(true),
    onError: () => toast.error(isSpanish ? "No se pudo enviar la reseña" : "Could not submit your review"),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.customerName.trim() || !form.text.trim()) {
      toast.error(isSpanish ? "Complete su nombre y reseña" : "Please fill in your name and review");
      return;
    }
    submit.mutate({ ...form, ...spamSignals });
  };

  return (
    <div className="reveal mx-auto mt-14 max-w-xl rounded-3xl border border-border bg-card p-8 shadow-soft md:p-10">
      {sent ? (
        <div className="py-6 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-secondary" />
          <h3 className="mt-4 font-display text-xl font-bold text-foreground">
            {isSpanish ? "¡Gracias por su reseña!" : "Thank you for your review!"}
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {isSpanish
              ? "Su reseña será publicada después de ser revisada por nuestro equipo."
              : "Your review will be published after our team approves it."}
          </p>
        </div>
      ) : (
        <>
          <h3 className="font-display text-xl font-bold text-foreground">
            {isSpanish ? "Deje una reseña" : "Leave a review"}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSpanish
              ? "¿Trabajamos juntos? Nos encantaría conocer su experiencia."
              : "Worked with us? We'd love to hear about your experience."}
          </p>
          <form onSubmit={onSubmit} className="mt-6 space-y-5" noValidate>
            {honeypotField}
            <div className="space-y-2">
              <Label htmlFor="review-name">{isSpanish ? "Su nombre" : "Your name"}</Label>
              <Input
                id="review-name"
                className="rounded-xl"
                maxLength={200}
                value={form.customerName}
                onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>{isSpanish ? "Calificación" : "Rating"}</Label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, rating: r }))}
                    aria-label={`${r} star${r > 1 ? "s" : ""}`}
                    className="press rounded-md p-1"
                  >
                    <Star
                      className={cn(
                        "h-6 w-6 transition-colors",
                        r <= form.rating ? "fill-amber-400 text-amber-400" : "text-border",
                      )}
                    />
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="review-text">{isSpanish ? "Su reseña" : "Your review"}</Label>
              <Textarea
                id="review-text"
                className="min-h-28 rounded-xl"
                maxLength={3000}
                value={form.text}
                onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
              />
            </div>
            <Button type="submit" disabled={submit.isPending} className="press w-full rounded-full">
              {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSpanish ? "Enviar reseña" : "Submit review"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

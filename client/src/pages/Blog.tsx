import { Link } from "wouter";
import { ArrowRight, CalendarDays, Clock3 } from "lucide-react";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { ASSETS } from "@/lib/assets";

const POST_IMAGES = [
  ASSETS.kitchenWhite,
  ASSETS.airbnbLiving,
  ASSETS.livingRoomWhite,
  ASSETS.organizedPantry,
  ASSETS.kitchenMinimal,
  ASSETS.officeModern,
];

export default function Blog() {
  const { t, locale, path } = useLocale();
  useSeo({ title: t.meta.blog.title, description: t.meta.blog.description, jsonLd: [localBusinessJsonLd()] });
  useReveal([locale]);

  const fmt = (iso: string) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(locale === "es" ? "es-MX" : "en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-12 md:pt-44 md:pb-16">
        <div
          className="pointer-events-none absolute -top-32 right-1/3 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <h1 className="reveal font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.blog.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "80ms" }}>
            {t.blog.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-24 md:pb-32">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {t.blog.posts.map((post, i) => (
            <Link
              key={post.slug}
              href={path("blog", post.slug)}
              className="reveal hover-lift group overflow-hidden rounded-3xl border border-border bg-card shadow-soft"
              style={{ transitionDelay: `${(i % 3) * 70}ms` }}
            >
              <div className="img-zoom">
                <img src={POST_IMAGES[i % POST_IMAGES.length]} alt={post.title} className="aspect-[16/10] w-full object-cover" loading="lazy" />
              </div>
              <div className="p-6">
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {fmt(post.date)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock3 className="h-3.5 w-3.5" />
                    {post.readTime} {t.blog.readTime}
                  </span>
                </div>
                <h2 className="mt-3 font-display text-lg font-bold leading-snug text-foreground">{post.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{post.excerpt}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                  {t.common.readMore}
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

import { Link } from "wouter";
import { ArrowLeft, ArrowRight, CalendarDays, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { trpc } from "@/lib/trpc";
import { Skeleton } from "@/components/ui/skeleton";
import { ASSETS } from "@/lib/assets";
import NotFound from "./NotFound";

export default function BlogPost({ slug }: { slug: string }) {
  const { t, locale, path } = useLocale();
  const { data: post, isLoading } = trpc.content.blogPost.useQuery({ slug }, { staleTime: 5 * 60 * 1000 });

  const title = post ? (locale === "es" ? post.titleEs : post.titleEn) : undefined;
  const excerpt = post ? (locale === "es" ? post.excerptEs : post.excerptEn) : undefined;
  const body = post ? (locale === "es" ? post.bodyEs : post.bodyEn) : "";

  useSeo({
    title: title ? `${title} | Grapefruit Cleaning Co.` : t.meta.blog.title,
    description: excerpt ?? t.meta.blog.description,
    jsonLd: post
      ? [
          localBusinessJsonLd(),
          {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: title,
            description: excerpt,
            datePublished: post.publishedAt,
            author: { "@type": "Organization", name: "Grapefruit Cleaning Co." },
          },
        ]
      : [],
  });
  useReveal([locale, slug, isLoading]);

  if (isLoading) {
    return (
      <article className="pt-32 pb-24 md:pt-40 md:pb-32">
        <div className="container max-w-3xl space-y-6">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-5 w-64" />
          <Skeleton className="aspect-[16/9] w-full rounded-3xl" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      </article>
    );
  }

  if (!post) return <NotFound />;

  const fmt = (iso: string | null) =>
    iso
      ? new Date(`${iso}T12:00:00`).toLocaleDateString(locale === "es" ? "es-MX" : "en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "";

  const paragraphs = body.split(/\n\n+/).filter((p) => p.trim().length > 0);

  return (
    <article className="pt-32 pb-24 md:pt-40 md:pb-32">
      <div className="container max-w-3xl">
        <Link
          href={path("blog")}
          className="reveal inline-flex items-center gap-1.5 text-sm font-semibold text-primary transition-colors hover:text-primary/80"
        >
          <ArrowLeft className="h-4 w-4" />
          {t.blog.backToBlog}
        </Link>
        <h1 className="reveal mt-6 font-display text-3xl font-extrabold leading-tight tracking-tight text-foreground md:text-4xl" style={{ transitionDelay: "60ms" }}>
          {title}
        </h1>
        <div className="reveal mt-4 flex items-center gap-5 text-sm text-muted-foreground" style={{ transitionDelay: "120ms" }}>
          <span className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4" />
            {fmt(post.publishedAt)}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock3 className="h-4 w-4" />
            {post.readTime} {t.blog.readTime}
          </span>
        </div>
        <div className="img-zoom reveal-scale mt-8 overflow-hidden rounded-3xl shadow-soft-lg" style={{ transitionDelay: "150ms" }}>
          <img src={post.coverImage || ASSETS.kitchenWhite} alt={title} className="aspect-[16/9] w-full object-cover" loading="eager" />
        </div>
        <div className="mt-10 space-y-6">
          {paragraphs.map((para, i) => (
            <p key={i} className="reveal text-base leading-[1.85] text-foreground/85" style={{ transitionDelay: `${Math.min(i * 40, 200)}ms` }}>
              {para}
            </p>
          ))}
        </div>

        <div className="reveal mt-14 rounded-3xl border border-border bg-card p-8 text-center shadow-soft md:p-10">
          <h2 className="font-display text-2xl font-extrabold text-foreground">{t.home.ctaTitle}</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">{t.home.ctaText}</p>
          <Button asChild size="lg" className="press mt-6 rounded-full px-8 shadow-soft-lg">
            <Link href={path("quote")}>
              {t.common.getInstantQuote}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </article>
  );
}


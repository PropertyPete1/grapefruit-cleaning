import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles } from "lucide-react";
import { ASSETS } from "@/lib/assets";

/**
 * Premium bilingual 404 page. Detects locale from the URL prefix so it works
 * both inside and outside the LocaleProvider tree.
 */
export default function NotFound() {
  const [location] = useLocation();
  const isEs = location.startsWith("/es");

  useEffect(() => {
    document.title = isEs
      ? "Página no encontrada | Grapefruit Cleaning Co."
      : "Page Not Found | Grapefruit Cleaning Co.";
    const meta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]') ?? (() => {
      const el = document.createElement("meta");
      el.setAttribute("name", "robots");
      document.head.appendChild(el);
      return el;
    })();
    meta.setAttribute("content", "noindex");
    return () => {
      meta.remove();
    };
  }, [isEs]);

  const copy = isEs
    ? {
        code: "404",
        title: "Esta página está impecable… porque no existe.",
        body: "Es posible que el enlace haya cambiado o que la página se haya movido. Volvamos a un espacio reluciente.",
        home: "Volver al inicio",
        quote: "Obtener una cotización",
        homePath: "/es",
        quotePath: "/es/cotizacion",
      }
    : {
        code: "404",
        title: "This page is spotless… because it doesn't exist.",
        body: "The link may have changed or the page may have moved. Let's get you back to a sparkling space.",
        home: "Back to home",
        quote: "Get an instant quote",
        homePath: "/en",
        quotePath: "/en/quote",
      };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background flex items-center justify-center px-6">
      {/* Soft brand glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -right-32 h-96 w-96 rounded-full bg-primary/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl"
      />

      <div className="relative mx-auto max-w-xl text-center">
        <img
          src={ASSETS.logo}
          alt="Grapefruit Cleaning Co."
          className="mx-auto mb-10 h-16 w-auto"
        />
        <p className="text-7xl font-extrabold tracking-tight text-primary/90 md:text-8xl">{copy.code}</p>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-foreground md:text-3xl">{copy.title}</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground md:text-lg">{copy.body}</p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href={copy.homePath}>
            <Button size="lg" className="rounded-full px-8 shadow-md transition-transform hover:-translate-y-0.5">
              {copy.home}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
          <Link href={copy.quotePath}>
            <Button
              size="lg"
              variant="outline"
              className="rounded-full px-8 transition-transform hover:-translate-y-0.5"
            >
              <Sparkles className="mr-2 h-4 w-4" />
              {copy.quote}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

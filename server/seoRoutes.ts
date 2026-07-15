import type { Express, Request, Response } from "express";

const EN_PATHS = [
  "/en",
  "/en/about",
  "/en/services",
  "/en/services/residential-cleaning",
  "/en/services/commercial-cleaning",
  "/en/services/airbnb-cleaning",
  "/en/services/move-in-out-cleaning",
  "/en/services/deep-cleaning",
  "/en/services/office-cleaning",
  "/en/pricing",
  "/en/gallery",
  "/en/testimonials",
  "/en/faq",
  "/en/contact",
  "/en/quote",
  "/en/book",
  "/en/blog",
  "/en/privacy-policy",
  "/en/terms-of-service",
];

const ES_PATHS = [
  "/es",
  "/es/nosotros",
  "/es/servicios",
  "/es/servicios/limpieza-residencial",
  "/es/servicios/limpieza-comercial",
  "/es/servicios/limpieza-airbnb",
  "/es/servicios/limpieza-mudanza",
  "/es/servicios/limpieza-profunda",
  "/es/servicios/limpieza-oficinas",
  "/es/precios",
  "/es/galeria",
  "/es/testimonios",
  "/es/preguntas-frecuentes",
  "/es/contacto",
  "/es/cotizacion",
  "/es/reservar",
  "/es/blog",
  "/es/politica-de-privacidad",
  "/es/terminos-de-servicio",
];

export function registerSeoRoutes(app: Express): void {
  app.get("/robots.txt", (req: Request, res: Response) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${origin}/sitemap.xml\n`);
  });

  app.get("/sitemap.xml", (req: Request, res: Response) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    const today = new Date().toISOString().slice(0, 10);
    const urls = [...EN_PATHS, ...ES_PATHS]
      .map(p => {
        // hreflang alternates: pair EN/ES paths by index
        const enIdx = EN_PATHS.indexOf(p);
        const esIdx = ES_PATHS.indexOf(p);
        const enAlt = enIdx >= 0 ? EN_PATHS[enIdx] : esIdx >= 0 ? EN_PATHS[esIdx] : null;
        const esAlt = esIdx >= 0 ? ES_PATHS[esIdx] : enIdx >= 0 ? ES_PATHS[enIdx] : null;
        return `  <url>
    <loc>${origin}${p}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>${
      enAlt ? `\n    <xhtml:link rel="alternate" hreflang="en" href="${origin}${enAlt}"/>` : ""
    }${esAlt ? `\n    <xhtml:link rel="alternate" hreflang="es" href="${origin}${esAlt}"/>` : ""}
  </url>`;
      })
      .join("\n");
    res
      .type("application/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>`
      );
  });
}

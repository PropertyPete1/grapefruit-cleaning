# Grapefruit Cleaning Co. — Build Notes (internal)

## Uploaded asset URLs (use exactly as-is in code, also in client/src/lib/assets.ts)
- Logo transparent: /manus-storage/grapefruit-logo-transparent_3f6f58eb.png
- Logo original jpg (OG image): /manus-storage/grapefruit-logo_9a11bb63.jpg
- Favicon square: /manus-storage/favicon-256_0edfb26b.png
- hero-living-room: /manus-storage/hero-living-room_a74140cc.jpg
- kitchen-white: /manus-storage/kitchen-white_7c693816.jpg
- kitchen-minimal: /manus-storage/kitchen-minimal_800eccdf.jpg
- living-room-view: /manus-storage/living-room-view_dbe0b6ab.jpg
- living-room-white: /manus-storage/living-room-white_a86954f1.jpg
- bathroom-spa: /manus-storage/bathroom-spa_f6f662fd.jpg
- bathroom-marble: /manus-storage/bathroom-marble_d468950f.jpg
- bedroom-minimal: /manus-storage/bedroom-minimal_7c706bff.jpg
- bedroom-cozy: /manus-storage/bedroom-cozy_48b470e3.jpg
- office-modern: /manus-storage/office-modern_27a29195.jpg
- office-open: /manus-storage/office-open_3d3ffaf7.jpg
- airbnb-living: /manus-storage/airbnb-living_7ebafc3e.jpg
- airbnb-kitchen: /manus-storage/airbnb-kitchen_2383e473.jpg
- cleaner-action: /manus-storage/cleaner-action_9f881ad7.jpg
- organized-pantry: /manus-storage/organized-pantry_8f4d8980.jpg
- kitchen-fridge: /manus-storage/kitchen-fridge_9cb3edee.jpg
- favicon.ico placed at client/public/favicon.ico
- Original logo local: /home/ubuntu/upload/PHOTO-2026-07-09-15-06-37.jpeg (coral script "Grapefruit" + green "CLEANING CO." + grapefruit slice icon + coral ribbon)

## Architecture decisions
- i18n: client/src/i18n/{types.ts,LocaleContext.tsx,translations/{en,es}.ts}. Localized slugs in ROUTE_SLUGS. URL pattern /en/... and /es/... . detectPreferredLocale() = localStorage 'gfc-locale' then navigator.language. translatePath() maps between locales for switcher + hreflang.
- Routing (App.tsx): "/" -> RootRedirect to /{locale}; /admin/*? -> AdminRoutes (to build at client/src/pages/admin/AdminRoutes.tsx); /en/*? and /es/*? -> LocalizedRoutes with SiteLayout wrapper. /home redirects to /en.
- Pages needed under client/src/pages/: Home, About, Services, ServiceDetail (takes serviceId prop: residential|commercial|airbnb|moveinout|deep|office), Pricing, Gallery, Testimonials, Faq, Contact, Quote, Booking, Blog, BlogPost (slug prop), Privacy, Terms, NotFound, admin/AdminRoutes.
- Design tokens in index.css: --grapefruit coral primary oklch(0.672 0.19 27.5), --leaf green, --cream bg, radius 1rem, fonts Plus Jakarta Sans (display) + Inter (body). Utilities: .glass, .shadow-soft, .shadow-soft-lg, .press, .hover-lift, .img-zoom, .reveal/.reveal-scale + .reveal-visible (via useReveal hook).
- Shared pricing engine: shared/pricing.ts (calculateQuote, BASE_PRICES, EXTRA_PRICES, FREQUENCY_DISCOUNTS 20/15/10%, DEPOSIT_RATE 0.2, TIME_SLOTS, generateBookingReference GFC-XXXXXX).
- SEO: client/src/hooks/useSeo.ts (title/desc/OG/canonical/hreflang/JSON-LD, localBusinessJsonLd()). Meta copy lives in translations meta.* per page.
- Components: SiteHeader (glass sticky, services dropdown, lang switcher, mobile menu), SiteFooter, SiteLayout, AnimatedPrice (count animation).
- Company placeholder contact: (555) 472-3384, hello@grapefruitcleaning.com, Mon-Sat 8-6.
- Stripe: integrated via webdev_add_feature. Webhook must be at /api/stripe/webhook with express.raw before express.json; test events (evt_test_) must return res.json({verified:true}). Create checkout session server-side w/ metadata (client_reference_id, user_id, customer_email), allow_promotion_codes, origin-based URLs. Claim sandbox link given to user.
- Emails: use built-in owner notification for owner; for customer confirmation emails "sent" in chosen language — store in DB and send via notification API to owner; customer email content rendered bilingually server-side.
- Booking flow steps: service -> datetime -> extras -> contact -> review -> deposit (Stripe) -> confirmation w/ booking reference.
- Admin at /admin using DashboardLayout, modules: Dashboard, Appointments, Customers, Invoices, Payments, Employees, Calendar, Statistics, Reviews, Gallery, Services, Pricing, Coupons, Settings. adminProcedure gating by role.
- NO fabricated reviews visible as real UGC — testimonials in translations are demo content; keep admin reviews module for real data. (Policy: never seed fake reviews into DB.)

## Remaining build order
1. Public pages (Home first) + useReveal on each.
2. DB schema: bookings, customers(guest bookings allowed), contact_messages, services config, coupons, employees, invoices, payments, reviews, gallery_items, settings.
3. tRPC routers: quote (public calc validate), booking (create, pay deposit via stripe checkout, confirm webhook), contact, admin CRUD.
4. Quote wizard + Booking flow + Stripe.
5. Admin dashboard.
6. SEO: robots.txt, sitemap.xml (server route), vitest tests, screenshots, checkpoint.

## Progress state (Phase 5→6)
- DONE: DB schema migrated; server/db.ts all helpers + stats; server/emails.ts; server/stripe.ts; server/stripeWebhook.ts (registered before express.json in _core/index.ts); routers registered in appRouter: booking (calculate, availability, validateCoupon, create→Stripe checkout, confirm, byReference, finalizeBooking), contact.submit, content (reviews/gallery/submitReview), admin (all modules).
- DONE pages: Home, About, Services, ServiceDetail, Pricing, Gallery, Testimonials, Faq, Contact, Blog, BlogPost, Privacy, Terms, NotFound, Quote (5-step wizard, live AnimatedPrice sidebar, passes params via querystring to booking).
- REMAINING: Booking.tsx (6-step flow; prefill from querystring type/bedrooms/bathrooms/sqft/extras/frequency; steps service→datetime→extras→contact→review→pay deposit via trpc.booking.create → window.open(checkoutUrl); return URL has ?session_id={CHECKOUT_SESSION_ID}&ref=REF → call trpc.booking.confirm → confirmation screen). Then admin/AdminRoutes.tsx (DashboardLayout), SEO files, vitest, screenshots, single checkpoint.
- trpc: booking.availability({date}) → [{time,available}]; TIME_SLOTS 8 slots 08:00–16:00; deposit 20%.
- Booking i18n keys exist at t.booking.* (steps.*, contact fields, review labels, payDeposit, confirmedTitle, reference, whatNext next1..3, validation.*). Check en.ts before use.

## QA Status (Phase 8 final sweep)
- 16 vitest tests passing (pricing 7, emails 5, booking router 3, auth 1).
- robots.txt + sitemap.xml served via server/seoRoutes.ts (registered in _core/index.ts); hreflang alternates, slugs match ROUTE_SLUGS.
- useSeo on all routed pages; NotFound rewritten as premium bilingual 404 (noindex); ComponentShowcase not routed.
- JSON-LD verified: LocalBusiness/CleaningService (Home, Contact), Service+Offer (ServiceDetail), FAQPage (FAQ), BlogPosting (BlogPost).
- Alt text (bilingual) + loading="lazy" verified across pages.
- Visual QA: EN home/about/pricing/gallery/testimonials/faq/contact/blog/service/quote/book + ES home/cotizacion/precios + mobile 375px home/book — all render correctly.
- Testimonials on public pages are illustrative copy; must tell user to replace with real reviews (never seed as DB review rows).
- Customer emails logged server-side (no email provider key); owner gets built-in notification. Mention Resend/SMTP swap for production.

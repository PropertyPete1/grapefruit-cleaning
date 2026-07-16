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

## ROUND 2 UPDATES (user request, in progress)
User asked: (1) fixed tier pricing, (2) staff dashboard to see bookings, (3) real customer email confirmation after deposit — user HAS a real email, wants me to say when ready for it (will use webdev_request_secrets for RESEND_API_KEY + owner/business email; ask user then).
Site is PUBLISHED at grapeclean-skvabkkr.manus.space.

### Fixed pricing (EXACT, never change) — implemented in shared/pricing.ts PRICING_TIERS + getTier():
- residential: <1000=$99.99, 1000-1500=$129.99, 1500-2000=$159.99, 2000-2500=$199.99, 2500-3500=$249.99 startingAt, 3500+=customQuote
- deep: <1000=$179.99, 1000-1500=$229.99, 1500-2500=$299.99, 2500+=$399.99 startingAt
- moveinout: <1000=$169.99, 1000-1500=$199.99, 1500-2000=$249.99, 2000-2500=$299.99, 2500+=$349.99 startingAt
- airbnb uses residential table; commercial/office = custom baseline BASE_PRICES 179.99 startingAt.
- calculateQuote now returns {startingAt, customQuote} flags; rooms/sqftCharge=0 (bedrooms/bathrooms no longer priced); extras & freq discounts (20/15/10) unchanged; DEPOSIT_RATE 0.2; prices use cents (round2).

### Files still to update for pricing switch:
- client/src/pages/Pricing.tsx: remove PER_BEDROOM/PER_BATHROOM imports (lines 13-14, 133-137); replace plan cards w/ tier tables per service (residential/deep/moveinout tiers + airbnb/office cards).
- client/src/pages/admin/AdminServices.tsx line 1 + rows 39-47: remove PER_* imports, show tier tables.
- server/pricing.test.ts: rewrite for tier engine.
- client/src/pages/Quote.tsx: keep bedroom/bathroom steps for info but price by sqft tier; show "Custom Quote" state when quote.customQuote (residential 3500+) → CTA to contact page instead of booking; show "starting at" label when quote.startingAt.
- client/src/pages/Booking.tsx: same handling; block online booking for customQuote sizes (redirect to contact).
- i18n: add keys pricing.tiers* / quote.customQuote message / startingAt labels in en.ts + es.ts (t.pricing.startingAt exists).

### Staff dashboard plan:
- users.role enum currently ["user","admin"]; ALTER to ["user","staff","admin"] via webdev_execute_sql + schema.ts update.
- staffProcedure in server/_core/trpc.ts or routers.ts (role staff OR admin).
- server/routers/staff.ts: myAppointments (upcoming bookings), allBookings ro, calendar data.
- client/src/pages/staff/StaffRoutes.tsx at /staff route (App.tsx): Today's jobs, Upcoming, Calendar, booking detail (customer contact, address, extras, notes). Read-only + status update (completed).
- Admin Employees module: add "link user as staff" (set role by email) via admin.setUserRole.

### Email delivery plan:
- Use Resend HTTP API (no SDK needed, fetch POST https://api.resend.com/emails, Authorization: Bearer RESEND_API_KEY).
- server/emails.ts sendBookingEmails: after webhook payment confirm → send customer email (bilingual, existing builders) + owner email; fallback to console.log if no key.
- Secrets to request when ready: RESEND_API_KEY, EMAIL_FROM (e.g. bookings@domain or onboarding@resend.dev for testing), OWNER_EMAIL.
- Stripe webhook (server/stripeWebhook.ts) already calls sendBookingEmails on checkout.session.completed — verify.

### ROUND 2 progress (as of phase 12 start):
- DONE pricing: shared/pricing.ts tiers, Pricing.tsx, Quote.tsx (customQuote/startingAt), AdminServices, tests updated (all pass).
- DONE staff dashboard: users.role enum now user/staff/admin (migrated); employees.userId column added; server/routers/staff.ts (staffProcedure: overview/bookings/updateJobStatus/schedule); db helpers getEmployeeByUserId, listBookingsForStaff, listBookingsForMonth, listAllUsers, setUserRole; admin.listUsers + admin.linkEmployeeUser endpoints; client/src/pages/staff/StaffRoutes.tsx (My Day/Jobs/Calendar, role-gated) registered at /staff in App.tsx; AdminEmployees has "Staff dashboard access" link dialog. Screenshots verified.
- REMAINING: (a) real email delivery — request secrets RESEND_API_KEY, EMAIL_FROM, OWNER_EMAIL via webdev_request_secrets (user said "let me know when ready for email"); update server/emails.ts to send via Resend fetch API w/ console fallback; write vitest for email sending logic; (b) verify stripeWebhook calls sendBookingEmails; (c) run all tests, checkpoint (auto-publishes), deliver.
- User note: user was told sandbox claim link earlier; auto-publish ENABLED (checkpoint = live).
- Stale vite error about AdminSettings/AdminCoupons imports in logs is old (files exist, tsc 0 errors, /admin 200).

## ROUND 2 FINAL STATE (Jul 16, 2026)
- Emails now via Gmail SMTP (nodemailer) in server/emails.ts. Secrets set + live-verified: GMAIL_USER=grapefruit@grapefruitclean.com + GMAIL_APP_PASSWORD (app password). server/gmail.verify.test.ts PASSED against smtp.gmail.com.
- Deposit confirmation email: triggered by Stripe webhook checkout.session.completed → finalizeBooking → sendBookingEmails (customer bilingual + owner copy to GMAIL_USER/OWNER_EMAIL).
- Reminders: server/reminders.ts (dueReminderKind: week reminder 2-7 days out only if booked ≥7 days ahead; day reminder ≤1 day out; idempotent via bookings.weekReminderSentAt/dayReminderSentAt — migration applied). Handler POST /api/scheduled/sendReminders in server/scheduledRoutes.ts registered in _core/index.ts.
- Heartbeat cron created: daily-booking-reminders, task_uid=jnGJSVTd5zwvu9vksDDRLm, cron "0 0 14 * * *" (14:00 UTC = 9am CDT daily).
- Checkpoint a3f9c16b saved (auto-publish = live). Production URL: grapeclean-skvabkkr.manus.space (per earlier note). grapefruit-cleaning.manus.space 404s — use grapeclean-skvabkkr.
- Tests: 38 passing + 1 live gmail verify. TS clean.
- Remaining: verify production URL serves latest + reminder endpoint reachable, final delivery.

## ROUND 3 — /staff bug (user report: "/staff looks the same as where people book")
Debug diagnosis (medium confidence): StaffRoutes uses useAuth({redirectOnUnauthenticated:true}) → startLogin() → OAuth returns to '/' → RootRedirect sends to /en → user sees public site; original /staff path never restored. ALSO user may be authenticated but role='user' → access-denied card (but they described public site, so returnTo loss is likely).
Fix plan:
1. In useAuth or StaffRoutes/AdminRoutes: before startLogin(), save window.location.pathname+search to localStorage key 'gfc-post-login-redirect'.
2. In App.tsx RootRedirect (runs at '/'): if 'gfc-post-login-redirect' exists and user just authenticated, navigate there once and clear it.
3. Make owner account definitely admin (upsert sets admin for OWNER_OPEN_ID). Verify user's row role in prod DB.
4. Consider a /staff access-gate improvement: show sign-in button rather than instant redirect.
Production URL: grapeclean-skvabkkr.manus.space. Prod /staff serves SPA 200 + bundle contains staff code (verified). Dev /staff renders fine (verified screenshots).

## ROUND 4 — address-based sqft verification (research done)
Chosen source: **RentCast API** (https://developers.rentcast.io)
- Endpoint: GET https://api.rentcast.io/v1/properties?address=Street,%20City,%20State,%20Zip
- Auth: header `X-Api-Key: <key>` (user must sign up free at app.rentcast.io/app/api)
- Free tier: 50 calls/mo; paid $74/mo=1000 calls ($0.20/extra on free plan). 150M+ US property records (tax assessor data).
- Response: array of property records; key field `squareFootage` (number, living area), also bedrooms, bathrooms, propertyType, yearBuilt, lotSize.
- Data availability varies by county; must handle no-result gracefully (fall back to customer-entered sqft, flag as unverified).
- No built-in Manus API Hub property source (checked: no Zillow/property/real estate APIs).
- Manus Maps component exists: client/src/components/Map.tsx (Google Maps proxy) — can use Places Autocomplete for address input WITHOUT extra key (check webdev-maps-integration skill).
Plan: address autocomplete (Google Places via built-in maps proxy) in Quote + Booking → server tRPC endpoint property.lookup (RentCast, cached in db table property_lookups to save quota) → compare entered vs verified sqft → auto-select tier from verified sqft; bilingual UI copy; store verifiedSqft + sqftMismatch on booking; show flag in admin appointments. Secret needed: RENTCAST_API_KEY via webdev_request_secrets.

## ROUND 4b — user wants a truly FREE source ("sqft is public info")
Findings:
- AssessorSearch: NOT free — $50/mo min, only address-matching is 0 credits.
- Zillow: no public API; Bridge Public Records API requires approval/enterprise. Scraping = ToS violation.
- County appraisal district (Texas CADs: HCAD/TCAD/DCAD): free web search portals but no clean public JSON APIs; some counties expose ArcGIS REST parcel services with living-area fields — county-specific, need to know user's service area county.
- Best pragmatic approach: county ArcGIS/open-data if service area known + deterrence mode fallback; RentCast free 50/mo as optional upgrade.
- User asked which city/county they serve — awaiting answer (msg sent as info, not blocking).
- IMPORTANT: user's business appears TX-based (owner email lifestyledesignrealty.com, CDT timezone). If county unknown, build provider-agnostic server lookup: tries (1) county ArcGIS endpoint if configured, (2) RentCast if key present, else returns unverified → deterrence mode.

## ROUND 4c — VERIFIED FREE SOURCE: Bexar County GIS (user confirmed "typically bexar county")
Endpoint: GET https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query
- Params: where=Situs LIKE '<NUM>%<STREET UPPER>%', outFields=PropID,Situs,GBA,TOT_GBA,YrBlt,Stories,PropUse, returnGeometry=false, f=json
- VERIFIED WORKING: "5500 GRAND LAKE DR" → GBA=1878 (matches RentCast's squareFootage=1878 for same address!). GBA/TOT_GBA are STRINGS, may be "NULL".
- Situs format: "5500  GRAND LAKE DR " (double space after number, trailing space, uppercase, no city/zip). Query strategy: extract house number + street name (drop suffix ambiguity), where=Situs LIKE '5500 %GRAND LAKE%'.
- No API key, no auth, free public county service. Data updated annually (Sept/Oct) — fine for sqft (rarely changes).
- PropUse=1 seems residential single family.
- Fallback chain in server/property.ts: (1) Bexar GIS by Situs match, (2) RentCast if RENTCAST_API_KEY set, (3) unverified → deterrence mode. Cache lookups in property_lookups table.

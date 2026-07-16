# Grapefruit Cleaning Co. — Build Notes (internal)

## ROUND 7 (in progress, Jul 16 2026) — About copy + configurable booking hours
STATUS: COMPLETE (91 tests pass, TS clean, screenshots verified EN/ES about + /en/book + /admin/settings booking hours UI). Remaining: todo.md [x] + checkpoint.
DONE:
- About Us copy replaced content-only (EN: heroTitle/heroSubtitle/storyTitle/storyText1/storyText2 + teamText welcome line; ES mirrored) in client/src/i18n/translations/{en,es}.ts.
- shared/schedule.ts NEW: DaySchedule{open,start,end}, WeeklySchedule keyed 0=Sun..6=Sat, DEFAULT_SCHEDULE (Mon–Fri 8–18, Sat 8–16, Sun closed), SCHEDULE_SETTING_KEY="booking_schedule", parseSchedule (JSON w/ per-day validation, falls back to defaults), slotsForDay (hourly, skips 12:00 lunch), dayOfWeek (tz-safe), slotsForDate.
- server/routers/booking.ts: availability now schedule-driven (returns [] on closed day); NEW public booking.schedule query; create mutation validates input.time against slotsForDate → bilingual BAD_REQUEST when outside hours.
REMAINING:
1. Booking.tsx: trpc.booking.schedule.useQuery → Calendar disabled prop add closed-day matcher [(d)=>!sched[d.getDay()].open, {before:...}]; empty-slot state when availability []; check t.booking keys for a "closed" string (may add booking.closedDay to en/es).
2. AdminSettings.tsx: NEW "Booking hours" section — per-day open switch + start/end selects (hours 5..22), save JSON via admin.saveSetting(booking_schedule); note Sunday closed unless enabled; invalidate nothing extra (booking.schedule is public query — invalidate utils.booking.schedule).
3. server/schedule.test.ts: tests for defaults/Sunday/parse fallback/override/lunch skip. Run pnpm test (was 82 pass).
4. todo.md Round 7 [x]; checkpoint (auto-publish); deliver.
CONSTRAINT: content-only elsewhere; do NOT touch other components. Footer hours i18n string left alone (admin business_hours setting already drives Contact/footer).

## ROUND 6 — Production-ready & plug-and-play (in progress, Jul 16 2026)
DB VERIFIED EMPTY (explicit counts): bookings=0 customers=0 reviews=0 coupons=0 gallery=0 payments=0 invoices=0 employees=0 contact=0 settings=0 users=1 (owner/admin only). Test booking GFC-8LGLJ9 + its customer were purged earlier.

DONE (phase 2 — employee invite onboarding):
- employees table: added inviteToken varchar(64), inviteSentAt, inviteAcceptedAt (migration 0005 applied; all 3 columns verified via SHOW COLUMNS)
- db.ts: getEmployeeByInviteToken(token)
- emails.ts: buildStaffInviteEmail(firstName, inviteUrl)
- admin router: createEmployee returns {id} (verified line 86); sendStaffInvite({employeeId, origin}) → crypto token, emails when employee.email set, returns {inviteUrl, emailed}; revokeStaffInvite({employeeId})
- staff router: acceptInvite({token}) protectedProcedure — links employee.userId, clears token, sets inviteAcceptedAt, grants staff role (admins not demoted); idempotent same-account; CONFLICT other-account
- client: StaffJoin.tsx at /staff/join/:token rendered inside StaffRoutes BEFORE role gate (useRoute); auto-accepts after sign-in (post-login redirect preserves /staff/*), navigates to /staff
- AdminEmployees.tsx: "Send invite right away" toggle on add, invite-ready dialog w/ copy link, Resend/Revoke buttons, status (Connected/Invite pending/Not connected)
- Tests: server/staffInvite.test.ts — 6 pass. TS clean. /admin/employees screenshot OK.

REMAINING (phases 3-5):
PHASE 3 DONE: shared/const.ts PUBLIC_SETTING_KEYS (10 keys incl stats_clients/cleanings/years/rating) + SiteInfo type; content.siteInfo public query (whitelist, trimmed); client/src/hooks/useSiteInfo.ts (EMPTY defaults, 5min staleTime); AdminSettings.tsx rewritten w/ 3 sections (Contact/Social/Homepage stats) + invalidates content.siteInfo, note says blank=hidden.

PHASE 4 progress:
- DONE SiteFooter.tsx: live info, rows hidden when empty, tel:/mailto: links, Instagram/Facebook icon links when set.
- DONE Contact.tsx: info cards from site settings, filtered when empty; localBusinessJsonLd(site).
- DONE useSeo.ts localBusinessJsonLd(site?): no more hardcoded telephone/email/aggregateRating; emits only when configured; areaServed; rating only when stats_rating+stats_clients set.
PHASE 4 DONE:
1. Home.tsx: stats band from useSiteInfo (hidden when none, responsive grid by count); hero rating line from stats_rating+stats_clients (hidden otherwise); localBusinessJsonLd(site); TestimonialsCarousel → trpc.content.reviews (approved only), hides when none, per-review star count.
2. Testimonials.tsx rewritten: live reviews grid, empty state ("be the first"), bilingual ReviewForm → content.submitReview (pending approval), CTA kept.
3. useSeo.ts localBusinessJsonLd(site?) — no hardcoded phone/email/rating; emits only when configured.
4. emails.ts: BookingEmailData.bizPhone optional; contact lines adapt ("just reply to this email" when unset); booking.ts finalizeBooking + reminders.ts sendDueReminders fetch business_phone setting.
5. en.ts/es.ts privacy/terms placeholders → "details on our Contact page" wording; heroRating key → "Five-star service, guaranteed" (unused in Home now but kept for dict type); About story + FAQ "hundreds of homes" softened.
6. SiteFooter: live info rows w/ tel:/mailto:, social icons when set. Contact.tsx: cards from settings, filtered.
7. grep verified: zero 472-3384 / grapefruitcleaning.com refs outside tests.
NOTE: emails.test.ts may reference old email copy — check/update. testimonials.items in en/es dicts now unused by pages (kept for Dictionary type compat) — could strip later.
PHASE 5 TODO: pnpm test full suite (fix email test expectations if broken), screenshots (/, /contact, /testimonials, /admin/settings, /admin/employees), verify no TS errors, single checkpoint (auto-publish), deliver with plug-and-play guide (add employee → invite; settings; approve reviews; Stripe claim; Gmail app password).

## ROUND 5 FINAL: Multi-county verification WORKING (Jul 16, 2026)
All 68 vitest tests pass. server/property.ts now a multi-county provider chain:
- Bexar (FULL sqft): maps.bexar.org ArcGIS Parcels — unchanged.
- Comal/Guadalupe/Medina/Kendall (ADDRESS-VERIFY only, CADs don't publish living area): AGOL CAD services, fields situs_num/situs_street_prefx/situs_street/situs_street_sufix/situs_city/situs_zip.
  - Comal: services7.arcgis.com/Yz6eib2o8WvEgWq8/.../ComalCADWebService/FeatureServer/0
  - Guadalupe: services9.arcgis.com/1l4hbpt78hjlsIcl/.../GuadalupeCADWebService/FeatureServer/0
  - Medina: services6.arcgis.com/j94FvPaik4etwHFk/.../MedinaCADWebService/FeatureServer/0 (situs_num may have trailing spaces)
  - Kendall: services9.arcgis.com/AugxDVA2CqlsdRYC/.../KendallCADWebService/FeatureServer/0
- parseStreetAddress extracts leading directional into prefix ("424 S Castell Ave" → CASTELL + prefix S); streetVariants expands AVENUE↔AVE; pickBestCadMatch scores whole-word street + prefix + ZIP agreement; situs_num matched with trailing-space variants.
- detectCounties(city, zip) → candidate counties (ZIP wins over city); lookupPropertySqft falls through candidates; result contract adds addressVerified/county/matchedAddress, reason "address_verified".
- UI (Quote + Booking): green "address verified in X County records; sqft confirmed at appointment" notice for addressVerified; full sqft verify remains Bexar-only. booking.create persists sqftSource for both cases.
- Live-verified addresses: 424 S Castell Ave New Braunfels 78130 (Comal), 211 W Court St Seguin 78155 (Guadalupe), 603 Avenue M Hondo 78861 (Medina), 201 E San Antonio Ave Boerne 78006 (Kendall), 5500 Grand Lake Dr SA 78244 (Bexar sqft).

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

## ROUND 5 — multi-county sqft (Comal, Guadalupe, Medina, Kendall) — research in progress
### Statewide TxGIO StratMap parcels (PROBED)
- https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query
- All-TX coverage; fields: situs_num/situs_stre/situs_city/situs_zip/county/fips/year_built/imp_value BUT **NO living-area sqft** (only parcel land area). Useful as county-detection fallback only.
### Comal County
- cceo.co.comal.tx.us/arcgispor → "Connection denied by Geolocation" from sandbox (geo-blocked). opendata api search returned empty; try https://data-comalcounty.opendata.arcgis.com dataset pages via browser or hub API v3.
### Candidates to probe next
- CAD esearch portals (Harris Govern software): esearch.guadalupead.org, Comal esearch.comalad.org?, Medina esearch/medinacad.org (True Automation?), Kendall kendallad.org. These UIs call JSON endpoints (e.g. /Search/SearchResults or /api/...) that include living area sqft in results.
- Also TNRIS county-specific parcel downloads (static, too heavy).
### esearch CAD portals (PROBED — NOT viable)
- esearch.comalad.org / guadalupead / medinacad / kendallad all resolve 200, but search flow is reCAPTCHA-enterprise gated + session/expiry redirects (Search/Result → Search/Expired). No open JSON API. DO NOT scrape.
### Next: county ArcGIS servers with CAD improvement data
- Probe: gis.comaltx.gov? mapserv?; Guadalupe open data (ArcGIS Hub) at data-guadalupecounty or gcgis; New Braunfels city GIS (nbgis) covers much of Comal; also check SARA (San Antonio River Authority) regional parcels and AGOL-hosted FeatureServers via arcgis.com search API (services with LIVING_AREA/GBA fields).
### FOUND — BIS Consulting CAD web services on AGOL (all four counties!)
- Comal:     https://services7.arcgis.com/Yz6eib2o8WvEgWq8/arcgis/rest/services/ComalCADWebService/FeatureServer/0 (Parcels)
- Medina:    https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/MedinaCADWebService/FeatureServer/0
- Kendall:   https://services9.arcgis.com/AugxDVA2CqlsdRYC/arcgis/rest/services/KendallCADWebService/FeatureServer/0
- Guadalupe: https://services9.arcgis.com/1l4hbpt78hjlsIcl/arcgis/rest/services/GuadalupeCADWebService/FeatureServer/0
- Parcels layer fields (same schema, PACS-style): situs_num, situs_street_prefx, situs_street, situs_street_sufix, situs_city, situs_zip, imprv_val, owner_tax_yr ... NO obvious living-area field in flagged list — need FULL field list + sample query to check for living_area/la_sqft/etc. If absent, sqft may not be published → deterrence-mode fallback for those counties OR estimate not possible.
- NEXT: dump full field lists + query a known address (e.g. New Braunfels "265 Landa St") to inspect all attributes.
- CONFIRMED: full Comal field list has **NO living-area/sqft field** (only legal_acreage, land_val, imprv_val, market). Same PACS schema for Medina/Kendall/Guadalupe → none carry building sqft. Address matching works great though (situs_num + situs_street + situs_zip clean fields).
- Options: (a) TCEQ/TxGIO footprints? building footprint area ≠ living area; (b) Microsoft building footprints — same issue; (c) use CAD service to VERIFY ADDRESS EXISTS + county, but sqft unverifiable → deterrence mode with "verified address, sqft confirmed at appointment"; (d) RentCast fallback (50 free/mo) for these 4 counties only, conserving quota (Bexar stays free/unlimited).
- DECISION (pending impl): hybrid — Bexar GIS (free sqft) + 4-county CAD address verification + optional RentCast key for out-of-Bexar sqft when configured. Honest UI: for non-Bexar counties without RentCast, show "address verified — square footage subject to confirmation".

### ROUND 5 FINAL RESEARCH CONCLUSIONS (all probed Jul 16 2026)
- Guadalupe parcels layer 0 confirmed same PACS schema (imprv_val, situs_num, situs_street, situs_city, situs_zip) — NO living-area field on any of the 4 CAD FeatureServers.
- esearch portals: reCAPTCHA-gated, no JSON API. New Braunfels open data: no parcel+living-area dataset found. Statewide StratMap: no living-area either.
- FINAL DESIGN for server/property.ts refactor:
  1. detectCounty(city, zip) → "bexar" | "comal" | "guadalupe" | "medina" | "kendall" | "outside" | "unknown" (ZIP strongest, then city; need ZIP+city sets per county).
  2. Providers: bexar → maps.bexar.org GBA lookup (verified sqft, source "bexar_gis").
     comal/guadalupe/medina/kendall → CAD FeatureServer address match: where=situs_num='<NUM>' AND UPPER(situs_street) LIKE '%<STREET>%'; outFields prop_id,situs_*,imprv_val,legal_acreage,file_as_name. Result = addressVerified:true but sqft NOT available → new result kind "address_verified" (source e.g. "comal_cad"); UI copy: address confirmed in county records, sqft confirmed at appointment; booking stores sqftSource + no auto-correction (no verified sqft) unless RentCast key present (future).
  3. Endpoint URLs (query with f=json, returnGeometry=false, resultRecordCount=5):
     - Comal:     https://services7.arcgis.com/Yz6eib2o8WvEgWq8/arcgis/rest/services/ComalCADWebService/FeatureServer/0/query
     - Guadalupe: https://services9.arcgis.com/1l4hbpt78hjlsIcl/arcgis/rest/services/GuadalupeCADWebService/FeatureServer/0/query
     - Medina:    https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/MedinaCADWebService/FeatureServer/0/query
     - Kendall:   https://services9.arcgis.com/AugxDVA2CqlsdRYC/arcgis/rest/services/KendallCADWebService/FeatureServer/0/query
     - Sample verified query (Comal): situs_num = '265' AND situs_street LIKE '%LANDA%' → returns prop_id 71385, situs "265 LANDA ST NEW BRAUNFELS 78163". situs_street has NO suffix (suffix in situs_street_sufix). situs_num is a STRING.
  4. County ZIPs (to compile): Comal (New Braunfels 78130/78131/78132/78133/78135, Canyon Lake 78133, Spring Branch 78070, Bulverde 78163, Fischer 78623, Sattler, Startzville, Garden Ridge 78266*); Guadalupe (Seguin 78155/78156, Schertz 78154, Cibolo 78108, Marion 78124, Santa Clara, New Berlin, McQueeney 78123, Geronimo, Kingsbury 78638, Staples); Medina (Hondo 78861, Castroville 78009, Devine 78016, Natalia 78059*, LaCoste 78039*, D'Hanis 78850, Yancey 78886, Mico 78056*, Rio Medina 78066); Kendall (Boerne 78006/78015*, Comfort 78013, Kendalia 78027, Waring 78074, Sisterdale, Bergheim 78004).
     *CAUTION: some ZIPs straddle counties (78163 Bulverde is in BOTH Bexar+Comal lists; 78015/78056/78039/78059 currently in BEXAR_ZIPS!). Resolution: ZIP→candidate counties list; try providers in order (bexar first if candidate), fall through to next county's provider when not found.
  5. Keep 24h cache; result reason values extend with "address_verified".
  6. UI: Booking/Quote copy — green check "verified in county records: X sqft" (Bexar) vs blue check "address verified in <County> County records; square footage confirmed at appointment" (others). Admin badge same distinction.
### Current property.ts structure (single-county):
- detectBexarCoverage(city,zip) → in/outside/unknown; BEXAR_ZIPS + BEXAR_CITIES sets; parseStreetAddress(); lookupBexarProperty(); lookupPropertySqft(address,city,zip) w/ 24h in-memory cache. source: "bexar_gis". Refactor to providers[] keyed by county w/ detectCounty(city,zip) → county name.

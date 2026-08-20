# Grapefruit Cleaning Co. - Project TODO

## Brand & Design System
- [x] Process official logo (header, footer, favicon, OG images)
- [x] Design tokens in index.css (coral primary, green secondary, off-white bg, Inter/Plus Jakarta Sans)
- [x] Generate premium hero/gallery imagery
- [x] Glassmorphism header, soft shadows, rounded corners, scroll animations

## i18n / Bilingual (EN default, ES neutral Latin American)
- [x] i18n context with /en and /es URL subpath routing
- [x] Browser language detection on first visit + localStorage persistence
- [x] Language switcher in header/footer
- [x] Professional translations for ALL pages, forms, emails, metadata

## Pages (each in EN + ES)
- [x] Home (hero, trust signals, services cards, why choose us, quote teaser, testimonials carousel, CTA)
- [x] About
- [x] Services hub
- [x] Residential Cleaning
- [x] Commercial Cleaning
- [x] Airbnb Cleaning
- [x] Move In/Out
- [x] Deep Cleaning
- [x] Office Cleaning
- [x] Pricing
- [x] Gallery
- [x] Testimonials
- [x] FAQ
- [x] Contact (form w/ validation + emails)
- [x] Get a Quote (instant quote calculator wizard)
- [x] Blog (index + posts)
- [x] Privacy Policy
- [x] Terms of Service
- [x] Custom 404

## Instant Quote Calculator
- [x] Step wizard: cleaning type, bedrooms, bathrooms, sqft, pets, deep cleaning, move-out, oven, fridge, windows, laundry, garage, organization, frequency
- [x] Real-time animated price estimate with smooth transitions
- [x] Hand-off to booking flow

## Booking Flow (Airbnb-style)
- [x] Service selection step
- [x] Date/time calendar picker with available slots
- [x] Extras selection
- [x] Contact info step with validation
- [x] Review booking summary
- [x] Stripe deposit payment
- [x] Confirmation screen with booking reference
- [x] Bilingual confirmation emails (customer in chosen language + owner notification)

## Database Schema
- [x] bookings, customers, services, invoices, payments, employees, reviews, gallery items, coupons, blog posts, settings, contact messages

## Admin Dashboard
- [x] Dashboard overview (revenue, appointments, customers KPIs)
- [x] Appointments management
- [x] Customers CRM
- [x] Invoices
- [x] Payments
- [x] Employees
- [x] Calendar view
- [x] Statistics/Analytics
- [x] Reviews management
- [x] Gallery management
- [x] Services management
- [x] Pricing management
- [x] Coupons
- [x] Settings
- [x] Role-based access (admin only)

## SEO
- [x] Per-page titles + meta descriptions (EN/ES)
- [x] LocalBusiness / Service / FAQPage schema markup (JSON-LD)
- [x] Open Graph tags + OG image with logo
- [x] hreflang alternates, canonical URLs
- [x] sitemap.xml + robots.txt
- [x] Image alt text, lazy loading, Core Web Vitals

## Integrations
- [x] Stripe deposit payments (webdev_add_feature stripe)
- [x] Email sending (confirmation to customer + owner)

## QA
- [x] Vitest tests for pricing engine, booking, emails (13 tests passing)
- [x] Mobile responsiveness check
- [x] Both language checks on all pages

## Update Round 2 (fixed pricing, staff dashboard, real emails)
- [x] Replace pricing engine with fixed sq-ft tier pricing (Residential/Deep/Move-In-Out) in shared/pricing.ts
- [x] Update quote calculator to use tier pricing + custom quote path for 3500+ sqft residential
- [x] Update booking flow pricing + deposit to match tiers
- [x] Update Pricing page to display the exact tier tables (EN + ES)
- [x] Update service detail pages / homepage price mentions to match tiers (BASE_PRICES = tier-1 prices)
- [x] Update admin services/pricing module to show fixed tiers
- [x] Update vitest tests for new pricing engine
- [x] Staff role: extend user roles (admin/staff/user), staff dashboard with bookings list, calendar, schedule view
- [x] Staff management in admin (assign staff role / link employee to user account)
- [x] Gmail SMTP delivery via app password (replace Resend approach) — production mailbox is now grapefruitcleaningc@gmail.com over Gmail SMTP (a Microsoft mailbox was tried and abandoned; Microsoft has SMTP basic auth disabled on it)
- [x] Deposit-paid confirmation email sent via Gmail (bilingual, already triggered by Stripe webhook)
- [x] Reminder email 7 days before cleaning (only when booked ≥1 week out), bilingual
- [x] Reminder email 1 day before cleaning, bilingual
- [x] Scheduled reminder handler /api/scheduled/sendReminders with sent-tracking to avoid duplicates
- [x] Tests for reminder scheduling logic and Gmail transport fallback (38 tests + live SMTP verify)
- [x] Create daily Heartbeat cron for reminders (task_uid: jnGJSVTd5zwvu9vksDDRLm, daily 14:00 UTC / 9am CDT)
- [x] Real customer email delivery on deposit payment (via Gmail SMTP instead of Resend, bilingual)
- [x] Email owner + customer after Stripe webhook confirms deposit (Gmail SMTP + owner notification)
- [x] Test everything, checkpoint, deliver (38 tests pass, live SMTP verified, test email delivered, prod endpoint reachable, cron registered)

## Round 3 — bug reports
- [x] BUG: /staff on production shows the public site instead of the staff dashboard — root cause: OAuth callback lands at "/" and the locale redirect sent users to /en, losing the /staff destination. Fixed: intended path saved before login and restored after callback. (User is admin role, verified in DB.)

## Round 4 — address-based square footage verification
- [x] Research property data source for sqft lookup by US address (assessor/property APIs, feasibility, cost)
- [x] Test truly FREE sqft sources (county assessor open data, Regrid, other free APIs) per user request — user rejects paid/signup options
- [x] Find and test Bexar County (San Antonio) public GIS/appraisal endpoint returning living-area sqft by address — VERIFIED working, free, no key (maps.bexar.org ArcGIS, GBA field)
- [x] Server lookup resolves address automatically (Bexar GIS first); graceful unverified fallback outside coverage
- [x] Address field wired into quote calculator (optional, auto-fills + locks verified sqft) and booking flow (debounced live verification)
- [x] Server-side property lookup endpoint (booking.verifyProperty) returning verified sqft for an address
- [x] Compare customer-entered sqft vs verified sqft; auto-correct price tier server-side + bilingual notices in UI
- [x] Store verifiedSqft/sqftSource/sqftMismatch on booking record; badges in admin appointments view
- [x] Tests for verification logic (address parsing + live GIS lookup; 46 tests passing)
- [x] Send full address (street + city + ZIP) to verifyProperty; server ZIP-based Bexar coverage check (detectBexarCoverage: 100+ Bexar ZIPs + municipality list, ZIP wins over city)
- [x] Guaranteed unverified fallback for non-Bexar addresses — outside_coverage short-circuits before any GIS query, preventing false street-name matches
- [x] Tests for outside-coverage and ambiguous-address cases (Austin/Houston/Dallas ZIPs, ZIP-vs-city conflict, ambiguous "Main St"; 55 tests passing)
- [x] Quote wizard collects street + city + ZIP and passes all three to verifyProperty; handoff to Booking prefills city/zip

## Round 5 — Multi-county sqft verification (Comal, Guadalupe, Medina, Kendall)

- [x] Research/probe public GIS or appraisal-district endpoints for Comal County — CAD AGOL service verifies address; living-area sqft NOT published publicly
- [x] Research/probe public GIS or appraisal-district endpoints for Guadalupe County — same (address-verify)
- [x] Research/probe public GIS or appraisal-district endpoints for Medina County — same (address-verify; trailing-space situs_num handled)
- [x] Research/probe public GIS or appraisal-district endpoints for Kendall County — same (address-verify)
- [x] Refactor property.ts into a multi-county provider architecture with automatic county detection (ZIP/city → county)
- [x] Extend coverage maps: ZIP and municipality lists for all five counties
- [x] Update coverage tests + live lookup tests for each new county (68 tests passing, live CAD hits verified)
- [x] Update customer-facing copy: county-specific "address verified" notice in Quote + Booking (EN/ES)
- [x] Run full test suite, checkpoint, deliver

## Round 6 — Production-ready & plug-and-play

- [x] Audit site for all placeholder/demo/fake data (stats, testimonials, contact info, hardcoded copy)
- [x] Employee onboarding: admin form to add employee (name, email, phone, role) generating a secure invite link
- [x] Invite link flow: /staff/join/:token — employee signs in, token links their account to the employee record and grants staff role automatically
- [x] Invite management: pending/accepted status, copy link, resend/revoke invite
- [x] Invite email via Gmail SMTP sent to the new employee
- [x] Business settings module in admin: phone, email, service area/address, business hours, social links, homepage stats (clients/cleanings/years/rating)
- [x] Public site reads business settings via public endpoint (header, footer, contact page, JSON-LD, emails)
- [x] Remove fake homepage stats (500+ clients, 12,000+ cleanings, 5.0 rating) — settings-driven, section hidden when unset
- [x] Remove illustrative testimonials from public pages — show only real approved DB reviews; hide sections when none; public review-submission form added
- [x] Replace placeholder contact info everywhere ((555) 472-3384, hello@grapefruitcleaning.com) with settings values; emails say "reply to this email" when phone unset
- [x] Verify no seeded/test data in database tables — purged the one Stripe-test booking + its customer; all other tables empty
- [x] Tests for invite flow + settings endpoints; run full suite (77 tests passing); checkpoint & deliver

## Round 7 — About Us copy + configurable booking hours

- [x] Replace About Us page text with the new provided copy (EN) — content-only, no layout/design changes
- [x] Matching Spanish translation of the new About Us copy (site is bilingual)
- [x] Booking hours become settings-driven: default Mon–Fri 8:00–18:00, Sat 8:00–16:00, Sun closed
- [x] Sunday bookings blocked unless administrator manually enables them in settings
- [x] Admin Settings panel: per-day open/close times + closed toggle for booking schedule
- [x] Booking calendar + slot picker read schedule from settings (no other UI changes)
- [x] Server-side validation rejects bookings outside configured hours
- [x] Tests for schedule logic; run full suite; checkpoint & deliver (91 tests passing)

## Round 8 — GitHub export

- [x] Push the full project to a new GitHub repo named "grapefruit-cleaning" (private) under the user's account — https://github.com/PropertyPete1/grapefruit-cleaning (201 files, full checkpoint history)
- [x] Verify the push and deliver the repo link with hosting guidance (recommend built-in hosting + custom domain over Vercel)

## Round 9 — Admin-editable pricing, blog CMS, spam protection (user's "ROUND 8")

### Settings-driven pricing
- [x] pricing_config setting (JSON): tiers (residential/deep/moveinout), extras, frequency discounts, deposit rate
- [x] shared/pricing.ts: DEFAULT_PRICING fallback + zod parsePricingConfig() + calculateQuote(config param)
- [x] Server loads stored config for ALL price calculations (single source of truth, no client spoofing)
- [x] Public query booking.pricingConfig; Quote/Booking/Pricing/ServiceDetail read live prices (5-min staleTime)
- [x] Admin → Services becomes editable pricing panel (tier prices, extras, discounts, deposit rate, reset to defaults)
- [x] Tests: parse/fallback/override/deposit math

### DB-driven blog
- [x] blog_posts table (slug, bilingual title/excerpt/body markdown, coverImage, published, publishedAt)
- [x] Migrate hardcoded posts from en.ts/es.ts into DB seed rows; remove from translations (keep Dictionary type compatible)
- [x] Public queries content.blogPosts + content.blogPost(slug); Blog.tsx/BlogPost.tsx read from DB
- [x] sitemap.xml includes published post URLs in both locales
- [x] Admin → Blog module: list, bilingual create/edit dialog with markdown, publish toggle, delete

### Spam protection
- [x] Honeypot + min-fill-time on contact form and review form (silent server-side reject)
- [x] In-memory per-IP rate limiting on contact.submit, content.submitReview, booking.create (5/min)

### Housekeeping
- [x] README.md (stack, scripts, env vars, plug-and-play guide)
- [x] Delete client/public/__manus__/debug-collector.js and unused testimonials.items from en.ts/es.ts
- [x] Screenshots of /pricing, /en/quote, /admin/services, /admin/blog, /blog; full suite; single checkpoint

## Round 10 — Stale-chunk error fix
- [x] Fix "Uncaught SyntaxError: Unexpected token '<'" on /en: reload once on vite:preloadError (stale hashed chunks after deploy)
- [x] Serve 404 for missing /assets files instead of HTML SPA fallback
- [x] Harden clientIp() for contexts without req (test env)

## Round 11 — Blog cover image upload
- [x] Server: admin blog image upload endpoint (S3 via storagePut)
- [x] AdminBlog editor: upload button + preview alongside URL field
- [x] Test + checkpoint

## Round 12 — Stale-chunk error hardening
- [x] Diagnose why the reload hook didn't cover the 21:50 error (entry script vs dynamic import)
- [x] Strengthen recovery to cover the entry-script failure path
- [x] Verify, checkpoint, sync GitHub

## Round 13 — Verify third stale-chunk report against live watchdog build
- [x] Verify live production serves watchdog build and entry JS loads clean
- [x] Browser-verify /en?from_webdev=1 boots without console errors
- [x] Root cause: restore client/public/__manus__/debug-collector.js (deleted in Round 9; vite injects it in dev → HTML-as-JS SyntaxError in preview panel)
- [x] Fix admin dashboard monthly revenue query (ONLY_FULL_GROUP_BY error — alias month expression in GROUP BY/ORDER BY)

## Final Round — Sync merged audit code, migrate, verify, gallery upload, watermark
- [x] Pull merged main from GitHub (audit PR #1) without losing local state
- [x] Run migrations 0007 (expired status) + 0008 (slotConflict) via pnpm db:push before serving
- [x] Verify: pnpm check clean, vitest ~128 pass/1 skip, prod build clean, debug-collector.js present, preview clean
- [x] Smoke: pricing edit propagates + whole-dollar base prices; slot expiry ~60min; contact form; blog cover upload
- [x] Gallery image upload (same pattern as blog cover, URL fallback, bilingual, tests)
- [x] Watermark: no repo/config toggle exists — hosting-layer badge; removal via Management UI Settings → General (plan-dependent) — reported to user
- [x] Single checkpoint, publish, GitHub sync confirmed

## Round 15 — Mobile admin/staff nav drawer
- [x] Replace /admin mobile pill strip with hamburger + slide-out drawer (15 items, icons, active highlight, bilingual)
- [x] Review /staff mobile nav; apply drawer pattern if it has the same issue
- [x] Desktop sidebars unchanged; verify on mobile viewport; tests green

## Round 16 — Footer staff login link
- [x] Add a discreet "Staff login" link to the site footer (bilingual), linking to /staff

## Round 17 — Self-serve role management (Admin / Staff / No access)
- [x] Backend: admin.linkEmployeeUser extended with accessLevel (admin/staff) or unlink; safety guards: cannot demote yourself, cannot demote the last remaining admin
- [x] UI: Staff access dialog on Admin → Employees gains an access-level selector (Admin / Staff / No access)
- [x] Employee card shows access level (Admin vs Staff) when connected
- [x] Dialog copy updated to explain both roles
- [x] Promote Karyme to Admin — role now 'admin' in users table, card shows "Admin — grapefruit"
- [x] Tests: vitest coverage for promote/demote/last-admin guard/self-demotion guard (9 new tests, 144 total passing)
- [x] TS check + full suite green; single checkpoint; GitHub push

## Round 18 — Email failure visibility
- [x] Rebuild the cached SMTP transport on an EAUTH/535 failure so a credential change takes effect without waiting for a redeploy
- [x] Log which mailbox and host the transport actually connected as, each time it is built
- [x] Admin → Invoices resend toast shows the real SMTP error text instead of "email not configured"
- [x] Prove the Gmail transport from PRODUCTION: container booted 16:51:12Z, real resend of INV-MSS5FMO8-B473 logged the transport build and `[Email] Delivered to steven@lifestyledesignrealty.com`
- [x] PROJECT_NOTES.md corrected: current mailbox is grapefruitcleaningc@gmail.com via Gmail SMTP (Aug 19 2026), the old grapefruitclean.com Gmail is NOT dead, Microsoft SMTP abandoned
- [x] Standing rule recorded in PROJECT_NOTES.md: any "email is fixed" claim needs the production boot timestamp AND a real send through the production path — sandbox verification alone does not count
- [x] Hotmail-era values audited out of every environment and out of source, docs, and test fixtures
- [x] Deploy round: sync PR #13 (itemized balance invoices — named add-ons and custom lines), apply migration 0020 (invoices.lineItems, additive nullable text), force a genuine production restart, and prove the running commit is dea199a from production rather than the sandbox
- [x] Add GET /api/version returning the running build's commit SHA, boot timestamp, uptime, and branch, with the SHA stamped in at build time (scripts/write-build-info.mjs → shared/buildInfo.ts, since the deploy build context excludes .git)
- [x] Make /api/version uncacheable and cover it with tests (shape, SHA/short-SHA agreement, no-store, boot-time stability, uptime floor)
- [x] Add the email_log table (migration 0021): recipient, subject, email type, outcome (delivered/log_only/error/skipped), real SMTP error text, sending mailbox, invoice/booking ids, timestamp
- [x] Record every send attempt from deliverEmail, including failures and log-only fallbacks, via a dedicated emailLog module that degrades safely and never breaks a send
- [x] Tag each email flow with its type (balance_due, booking_confirmation, reminders, tips, deposit links, owner alerts, contact, iCal turnovers) and attach invoice/booking ids on balance sends
- [x] Add Admin → Email log page showing the last 50 attempts with outcome badges, the mail server's own error text, and a failure summary banner
- [x] Restrict the email log to admins (staff and ordinary users rejected) and cap the page size
- [x] Fix /api/version reporting commit "unknown" in production: the deploy image re-runs `pnpm build` without .git, so the stamper now falls back to the committed SHA instead of overwriting it, with a regression test that simulates a git-less build
- [x] Rename the /api/version SHA field to parentCommit (a commit cannot embed its own hash, so the stamped SHA is the parent of the deployed checkpoint), with a test guarding the name
- [x] Alert the owner when a transactional email logs a transport error or falls back to log-only, reusing the existing owner-alert path
- [x] Guard against recursion: an alert about email failure must never itself trigger an alert
- [x] Rate-limit failure alerts to at most 1 per hour; record suppressed repeats in email_log rather than sending them
- [x] Cover the guard, the rate limit, and suppression accounting with tests
- [x] Give the manual Create-invoice dialog the same itemization as the approval flow (add-on checklist at live catalog prices + named custom line items)
- [x] Store manual invoice line items as the same lineItems snapshot, itemized identically in the email and Stripe session
- [x] Reuse the approval flow's components and validation rather than forking the logic
- [x] Confirm from email_log whether the earlier resend to Steven was recorded as delivered (answer: table went live ~4h after that resend, so it holds no row for it)
- [x] Make manual invoices billable: mint a pay token and send the branded itemized payment-link email on create
- [x] Reuse the balance Stripe checkout path so a manual invoice's session carries its itemized lines
- [x] Resend works for manual invoices from the admin table, same as balance invoices
- [x] Manual invoices get the same automatic 3-day and 7-day reminders, stopping on paid
- [x] Guard booking-dependent assumptions: no deposit-credit line and no tip ask for manual invoices
- [x] Tests: manual invoice with items paid end to end, reminder fires on unpaid, reminder stops on paid, no tip ask after manual payment, resend uses the stored snapshot
- [x] Manual invoices become fully billable, reusing the balance machinery (Option B)
- [x] Itemization in the create dialog: shared InvoiceItemsEditor with the approval flow (add-ons at live prices + named custom lines)
- [x] On create: mint pay token, Stripe session, branded itemized email with payment link
- [x] Resend works for manual invoices, re-billing the stored snapshot
- [x] Manual invoices get the same 3/7-day reminder schedule, halting on paid/void
- [x] Guard: no deposit credit line and no booking fields in the manual email
- [x] Guard: no tip ask after a manual payment (no completed job behind it)
- [x] Full lifecycle tests in server/manualInvoice.test.ts (13 cases)
- [x] Homepage hero "From $89" was hardcoded; now derives from the live pricing_config
- [x] Added lowestBookablePrice() helper (tiered services only, custom-quote tiers excluded)
- [x] Swept EN/ES translations, SEO/JSON-LD, manifests, meta tags: no other hardcoded starting price found
- [x] Tests: server/lowestBookablePrice.test.ts (7 cases) pin the helper to the live config

## Round 20 — tip bug, payment receipts, re-booking nudges
- [x] TIP BUG: trace Daniel Murray's INV-MT0LDYJ6-7D0D settlement and show which gate blocked the tip email
- [x] Fix the tip trigger for future payments (do NOT send Daniel a late tip email)
- [x] Regression test using that payment's exact shape
- [x] PAYMENT RECEIPT: branded bilingual "Payment received" email with itemized breakdown for every paid invoice (balance + manual)
- [x] Decide receipt/tip composition so the customer gets one coherent message, not two overlapping ones
- [x] RE-BOOKING NUDGES: first nudge ~3-4 weeks after last completed cleaning, monthly at most thereafter
- [x] Nudge guard: never more than one marketing email per customer in any 21-day window
- [x] Nudge guard: never send to customers with open unpaid invoices
- [x] Nudge guard: skip customers with an upcoming booking
- [x] One-click unsubscribe, honoured permanently, required for marketing email
- [x] All nudge sends logged to email_log with type "marketing"
- [x] Wire nudges into the existing daily cron
- [x] Deploy with genuine restart, /api/version proof, customer journey summary
- [x] Tip bug: trace why Daniel Murray's settled balance sent no tip email (gate: booking still `confirmed`)
- [x] Fix: settling a balance completes a still-open booking, then the tip ask proceeds
- [x] Regression test using that payment's exact shape (admin-kind booking, confirmed, paid balance)
- [x] Payment receipt email: branded, bilingual, itemized, for balance AND manual invoices
- [x] Receipt on every settle path: webhook, return page, admin mark-paid
- [x] Re-booking nudges: cadence rules (24d first, 30d repeat, 21d hard floor, max 6)
- [x] Nudge exclusions: unsubscribed, upcoming booking, open invoice, no email, never completed
- [x] One-click unsubscribe route + branded bilingual confirmation page, honoured forever
- [x] Nudges logged to email_log as type "marketing"; sweep runs last on the daily cron
- [x] Migration 0023: marketing consent + nudge tracking columns on customers
- [x] Daniel GFC-WH33YS: already completed with correct service date (2026-08-19); no tip email fired, row left untouched
- [x] Daniel's projected first re-booking nudge: 2026-09-12
- [x] Data-inconsistency checks: paid invoices on non-completed bookings, invoices with dead pay links, customers with no email
- [x] Weekly owner digest (Mondays): email counts by type with delivered/failed, sub-threshold failures, upcoming nudges next 7 days with names, inconsistencies, totals
- [x] Daily inconsistency check folded into the existing owner-alert path (silent when clean)
- [x] Digest can be sent on demand: Admin -> Email log -> "Send report now" (platform cron refuses to register NEW jobs, so an automated one-shot was not possible; button is the reliable path)
- [x] Turnover scheduling email sends ALWAYS on auto-book, regardless of perCleanEmails
- [x] Dedupe: one scheduling email per reservation, not per placement retry
- [x] Dedupe must still notify on a genuine date CHANGE, with the new date
- [x] Cancellation notice to host when a dropped reservation cancels its cleaning
- [x] Cancellation alert to owner through the existing owner-alert path
- [x] Both cancellation emails logged to email_log
- [x] Keep cancellation safety rules untouched: confirmed-only, future-only, never override a human

## Round: brain read API deploy (PR #14)
- [x] Fast-forward stale checkout (66f0d82) to origin/main f17c742 -- 18 commits behind, NOT 2 as handoff said
- [x] Verify tree byte-identical to github/main before any checkpoint
- [x] tsc clean, 1169 passed / 1 skipped, brain route tests 20/20, build clean
- [x] Deploy PR #14 to production
- [x] Verify live /api/brain/ping returns 503 before the token is set
- [x] BRAIN_READ_TOKEN saved by owner in Settings -> Secrets (value never seen by me)
- [x] Explicit redeploy after the env change (env-only checkpoint reports "no changes" and keeps the old process)
- [ ] BLOCKED: live still 503 after genuine restart -> secret not reaching the runtime; also POST to a brain route returns the SPA (200), not 404
- [x] Confirm rest of CRM unaffected: site 200, booking flow, admin
- [x] Write methods on /api/brain/* return 405 with Allow: GET, HEAD (was falling through to the SPA catch-all as 200)
- [x] 405 test coverage: namespace regex scope, every write verb, GET/HEAD pass-through, refusal without consulting the token
- [x] Add GET /api/version/env-visibility: value-safe probe (defined / coarse length bucket / whitespace flag) to tell "secret not injected" from "injected but mismatched"

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
- [x] Gmail SMTP delivery via grapefruit@grapefruitclean.com app password (replace Resend approach)
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

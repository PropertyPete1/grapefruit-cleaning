# Grapefruit Cleaning Co. — Website & Business Platform

Bilingual (English/Spanish) marketing site, instant-quote engine, online booking with
Stripe deposits, and a full admin + staff operations dashboard for a residential and
commercial cleaning company serving the San Antonio, TX metro area.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS 4, shadcn/ui, wouter |
| API | tRPC 11 over Express 4 (typed end-to-end, superjson) |
| Database | MySQL/TiDB via Drizzle ORM |
| Auth | Manus OAuth (role-based: `admin` / `user`, plus employee-linked staff access) |
| Payments | Stripe Checkout (booking deposits, webhook at `/api/stripe/webhook`) |
| Email | Gmail SMTP via nodemailer (confirmations, reminders, staff invites) |
| Scheduled jobs | Daily reminder emails (7-day / 1-day before appointments) |
| Tests | Vitest (`pnpm test`) |

## Scripts

```bash
pnpm dev        # start the dev server (client + API on one port)
pnpm test       # run the vitest suite
pnpm build      # production build
pnpm drizzle-kit generate   # generate SQL migrations after editing drizzle/schema.ts
```

## Environment variables

All secrets are injected as environment variables — never committed. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | MySQL/TiDB connection string |
| `STRIPE_SECRET_KEY` / `VITE_STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe payments |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Outbound email (confirmations, reminders, invites) |
| `JWT_SECRET` | Session cookie signing |
| `VITE_APP_ID`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL` | Manus OAuth |

## Plug-and-play operations guide

Everything an owner needs day-to-day lives in the **Admin dashboard** (`/admin`) — no
code edits required:

- **Business settings** (`/admin/settings`): phone, email, hours, service area, social
  links, and homepage stats. Anything left blank is hidden on the public site. These
  values flow into the footer, contact page, transactional emails, and SEO JSON-LD.
- **Booking hours** (`/admin/settings`): per-day open/closed toggles and start/end
  times. Closed days are greyed out in the booking calendar and enforced server-side.
- **Pricing** (`/admin/services`): every price tier, extra, frequency discount, and the
  deposit rate is editable. The server always recalculates from the stored config, so
  client-side tampering cannot change what customers are charged. "Reset to defaults"
  restores the original pricing.
- **Employees** (`/admin/employees`): add a new hire (name, email, phone) and send them
  an invite link by email. When they open it and sign in, their account is automatically
  connected to the staff dashboard (`/staff`). Invites can be copied, resent, or revoked.
- **Blog** (`/admin/blog`): create, edit, publish/unpublish, and delete bilingual posts
  (markdown body). Published posts appear at `/blog` in both languages and are included
  in the sitemap automatically.
- **Reviews** (`/admin/reviews`): customer-submitted reviews appear here for approval.
  Only approved reviews show on the public testimonials page and homepage carousel.
- **Bookings & calendar** (`/admin/bookings`): manage appointments, assign cleaners,
  and track deposits.

### Anti-spam

Public forms (contact, reviews, booking) are protected by a honeypot field, a
minimum-fill-time check, and per-IP rate limiting (5/min) — no CAPTCHA needed.

### Square-footage verification

Booking addresses are checked against county appraisal-district records (Bexar, Comal,
Guadalupe, Medina, Kendall). Bexar returns verified square footage that protects
pricing from understated home sizes; neighboring counties confirm the address exists in
county records.

## Testing payments

Use Stripe test card `4242 4242 4242 4242` (any future expiry, any CVC). Live payments
require claiming the Stripe sandbox and entering live keys in Settings → Payment.

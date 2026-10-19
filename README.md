# One Touch Cleaning LLC — Online Booking Website

A complete, self-hosted booking website for **One Touch Cleaning LLC** (luxury cleaning, South Florida — Broward, Miami, Palm Beach).

Customers can pick a service, choose a date & time, acknowledge the **$50 non-refundable deposit** policy, pay the deposit securely via **Stripe**, and get an email confirmation. The owner gets an instant email notification, manages everything in a password-protected **admin dashboard** (calendar view, cancel/approve, block time off, edit hours/pricing/deposit).

## Stack

- **Backend:** Node.js + Express (requires Node **≥ 22.5**)
- **Database:** SQLite via Node's built-in `node:sqlite` — no native build tools needed
- **Payments:** Stripe Checkout (real $50 deposit charges)
- **Email:** Gmail SMTP via nodemailer
- **Frontend:** Plain HTML/CSS/JS single-page app, mobile-friendly, pink/gold/black luxury theme

## Quick start (local)

```bash
cd one-touch-booking-site
npm install
cp .env.example .env        # then fill in your values (see below)
npm start                   # http://localhost:3000
```

Run the logic tests:

```bash
npm test
```

## Environment variables

| Variable | Required | What it does |
|---|---|---|
| `PORT` | no | Port to listen on (default `3000`) |
| `BASE_URL` | for live Stripe | Public URL, e.g. `https://book.onetouchcleaning.com` — used for Stripe redirect URLs |
| `STRIPE_SECRET_KEY` | **yes, for payments** | From [Stripe Dashboard → API keys](https://dashboard.stripe.com/apikeys) (`sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | recommended | Webhook signing secret (`whsec_...`) — enables instant confirmation. Without it, `/api/bookings/confirm` still confirms on return from Stripe |
| `GMAIL_USER` | **yes, for email** | e.g. `onetouchcleaning.bf@gmail.com` |
| `GMAIL_APP_PASSWORD` | **yes, for email** | Gmail **App Password** (Google Account → Security → 2-Step Verification → App passwords). Not your Gmail password |
| `OWNER_EMAIL` | no | Where owner notifications go (defaults to `GMAIL_USER`) |
| `ADMIN_PASSWORD` | **yes** | Password for `/admin.html` — pick something strong |
| `CRON_SECRET` | recommended | Protects `GET /api/cron/reminders?secret=...` (daily reminder emails) |
| `DB_PATH` | no | SQLite file location (default `./data/bookings.db`) |

Without `STRIPE_SECRET_KEY`, checkout shows a friendly message telling customers to call/text. Without Gmail credentials, emails are logged to the console (dry-run) instead of sent.

## Business rules (all enforced)

- **Hours (America/New_York):** Mon–Tue 9:00 AM–6:00 PM, Wed–Fri 9:00 AM–4:30 PM, Sat–Sun closed. Editable in admin → Business settings
- **2-hour minimum** on every booking; longer durations allowed when availability permits
- Only start times that fit the **full duration inside business hours** are shown (30-min granularity)
- **No double bookings:** every insert runs in a `BEGIN IMMEDIATE` transaction — the overlap check and insert are atomic, so two simultaneous requests can't take the same slot
- Bookings, unpaid holds, and manual blocks all reduce availability in real time
- **$50 non-refundable deposit** required at checkout; booking is confirmed only after successful payment; checkbox acknowledgement required before paying
- Remaining balance shown on confirmation and in emails

## Admin dashboard

Open `/admin.html` and log in with `ADMIN_PASSWORD`. You can:

- **Bookings** — calendar-range list, confirm/complete/cancel (customer gets an email)
- **Change requests** — approve/deny customer cancel & reschedule requests (reschedules re-check availability atomically)
- **Blocked time** — block whole days or time ranges (holidays, personal appointments)
- **Business settings** — edit hours JSON, deposit amount, owner email/phone, business name
- **Services & pricing** — edit prices, minimums, activate/deactivate services

## Appointment reminders

Hit this endpoint once daily (morning ET) to email customers with appointments tomorrow:

```
GET /api/cron/reminders?secret=YOUR_CRON_SECRET
```

Free options: [cron-job.org](https://cron-job.org), or Vercel Cron (see below).

## Deploying

### Option A — VPS / Render / Railway / Fly.io (recommended)

This is a stateful Node app with a SQLite file. Deploy anywhere that runs Node ≥ 22.5 with persistent disk:

1. Push this folder to a Git repo
2. Create a web service: build `npm install`, start `npm start`
3. Set all env vars from `.env.example`
4. Set `DB_PATH` to a persistent volume path (e.g. Render disk at `/var/data/bookings.db`)
5. Point your domain at the service, set `BASE_URL` to it
6. In Stripe Dashboard → Developers → Webhooks, add `https://your-domain/webhook/stripe` listening to `checkout.session.completed`, copy the signing secret to `STRIPE_WEBHOOK_SECRET`

### Option B — Vercel / Netlify

Serverless platforms have **ephemeral filesystems** — SQLite won't persist between requests. To deploy there you must swap the storage layer for a hosted database (e.g. [Turso](https://turso.tech), Neon Postgres) — the SQL is standard and the `db.js` module is the only file that touches the database. The frontend (`public/`) can be served statically from the same host.

### Stripe webhook (either option)

Without the webhook, confirmations still work: after paying, Stripe redirects to `/success.html`, which calls `/api/bookings/confirm?session_id=...` and finalizes the booking + emails. The webhook just makes it instant and robust.

## Project structure

```
├── server.js            # Express app: public API, Stripe, webhooks, admin API, cron
├── db.js                # SQLite schema, seed data, atomic booking insert
├── lib/
│   ├── hours.js         # business-hours & availability math (pure, tested)
│   └── email.js         # Gmail SMTP notifications (owner, customer, reminders)
├── public/
│   ├── index.html       # homepage + 4-step booking wizard
│   ├── app.js           # wizard logic
│   ├── admin.html       # owner dashboard
│   ├── admin.js         # dashboard logic
│   ├── success.html     # post-payment confirmation page
│   ├── cancel.html      # cancelled-payment page
│   └── styles.css       # pink/gold/black theme
├── test/
│   └── logic.test.js    # 19 checks: hours, slots, overlap, blocks (npm test)
├── .env.example
└── package.json
```

## API reference (essentials)

- `GET /api/services`, `GET /api/settings/public`
- `GET /api/availability?date=YYYY-MM-DD&duration=120` → `{ closed, open, close, slots }`
- `POST /api/bookings` → creates unpaid hold (validates everything, 409 if taken)
- `POST /api/bookings/:id/checkout` → `{ url }` Stripe Checkout redirect
- `GET /api/bookings/confirm?session_id=...` → verifies payment, confirms, emails (idempotent)
- `POST /api/bookings/lookup` + `POST /api/bookings/:id/change-request` — customer self-service
- `/api/admin/*` — cookie-auth dashboard API
- `POST /webhook/stripe` — Stripe webhook
- `GET /api/cron/reminders?secret=...` — daily reminder job

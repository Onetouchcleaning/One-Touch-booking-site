'use strict';

/**
 * One Touch Cleaning LLC — booking server.
 * Node + Express + SQLite (better-sqlite3) + Stripe Checkout + Gmail SMTP.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const dbModule = require('./db');
const hours = require('./lib/hours');
const email = require('./lib/email');

const {
  openDb, seed, getBusyRanges, createBookingAtomic,
  getSetting, setSetting, getHoursConfig, getDepositCents,
} = dbModule;

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const CRON_SECRET = process.env.CRON_SECRET || null;

// ---- DB ----
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = openDb();
seed(db);

// ---- Stripe (lazy; only when configured) ----
let stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function ownerEmail() {
  return getSetting(db, 'owner_email', 'onetouchcleaning.bf@gmail.com');
}

// ---- App ----
const app = express();
app.use(cookieParser());
app.use(express.json());

// Stripe webhook needs the raw body — register before express.json for that path.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const s = getStripe();
  if (!s || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('webhook not configured');
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('bad signature');
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try { await confirmBookingBySession(session.id); } catch (e) { console.error('webhook confirm failed:', e.message); }
  }
  res.json({ received: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function serviceById(id) {
  return db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(id);
}

function bookingWithService(id) {
  return db.prepare(`
    SELECT b.*, s.name AS service_name FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id WHERE b.id = ?
  `).get(id);
}

function estimateTotal(service, durationMinutes) {
  if (service.price_type === 'hourly') {
    return Math.round(service.price_min_cents * (durationMinutes / 60));
  }
  if (service.price_type === 'flat_range') return service.price_min_cents;
  return 0; // quote
}

function validateBookingInput(body) {
  const errors = [];
  const service = serviceById(body.service_id);
  if (!service) errors.push('Please choose a service.');
  if (!body.customer_name || body.customer_name.trim().length < 2) errors.push('Please enter your name.');
  if (!body.customer_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.customer_email)) errors.push('Please enter a valid email.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) errors.push('Please choose a valid date.');
  else if (!hours.isFutureOrToday(body.date)) errors.push('Please choose today or a future date.');
  if (!/^\d{2}:\d{2}$/.test(body.start_time || '')) errors.push('Please choose a valid start time.');
  const minDur = service ? Math.max(120, Math.round(service.min_hours * 60)) : 120;
  const duration = parseInt(body.duration_minutes, 10);
  if (!Number.isFinite(duration) || duration < minDur) errors.push(`Minimum booking is ${minDur / 60} hours.`);
  if (body.deposit_ack !== true) errors.push('You must acknowledge the non-refundable deposit policy.');
  return { errors, service, duration };
}

// ---------- public API ----------
app.get('/api/services', (req, res) => {
  const rows = db.prepare('SELECT id, name, description, price_type, price_min_cents, price_max_cents, min_hours FROM services WHERE active = 1 ORDER BY sort_order').all();
  res.json(rows);
});

app.get('/api/settings/public', (req, res) => {
  res.json({
    business_name: getSetting(db, 'business_name', 'One Touch Cleaning LLC'),
    phone: getSetting(db, 'owner_phone', '(561) 294-9666'),
    email: ownerEmail(),
    instagram: 'https://www.instagram.com/onetouchcleaningllc',
    deposit_cents: getDepositCents(db),
    min_duration_minutes: hours.MIN_DURATION_MINUTES,
    timezone: 'America/New_York',
  });
});

app.get('/api/availability', (req, res) => {
  const { date, duration } = req.query;
  const durationMinutes = parseInt(duration, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(durationMinutes)) {
    return res.status(400).json({ error: 'date and duration are required' });
  }
  if (!hours.isFutureOrToday(date)) return res.json({ closed: true, slots: [], reason: 'past' });
  const cfg = getHoursConfig(db);
  const dayHours = hours.hoursFor(date, cfg);
  if (!dayHours) return res.json({ closed: true, slots: [], reason: 'closed' });
  const busy = getBusyRanges(db, date);
  const slots = hours.availableStartTimes(date, durationMinutes, cfg, busy);
  res.json({ closed: false, open: dayHours.open, close: dayHours.close, slots });
});

app.post('/api/bookings', (req, res) => {
  const { errors, service, duration } = validateBookingInput(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const cfg = getHoursConfig(db);
  const busy = getBusyRanges(db, req.body.date);
  const okSlots = hours.availableStartTimes(req.body.date, duration, cfg, busy);
  if (!okSlots.includes(req.body.start_time)) {
    return res.status(409).json({ errors: ['That time is no longer available. Please pick another slot.'] });
  }

  const end = hours.toHHMM(hours.toMinutes(req.body.start_time) + duration);
  const total = estimateTotal(service, duration);
  const deposit = getDepositCents(db);

  try {
    const { id, booking_code } = createBookingAtomic(db, {
      service_id: service.id,
      customer_name: req.body.customer_name.trim(),
      customer_email: req.body.customer_email.trim().toLowerCase(),
      customer_phone: (req.body.customer_phone || '').trim(),
      address: (req.body.address || '').trim(),
      notes: (req.body.notes || '').trim(),
      date: req.body.date,
      start_time: req.body.start_time,
      end_time: end,
      duration_minutes: duration,
      total_estimate_cents: total,
      deposit_cents: deposit,
      balance_cents: Math.max(0, total - deposit),
      deposit_ack: 1,
    });
    res.status(201).json({ id, booking_code, deposit_cents: deposit });
  } catch (e) {
    if (e.code === 'SLOT_TAKEN') return res.status(409).json({ errors: [e.message] });
    throw e;
  }
});

app.post('/api/bookings/:id/checkout', async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(500).json({ error: 'Online payments are not configured yet. Please call/text (561) 294-9666 to reserve.' });
  const b = bookingWithService(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (b.status === 'confirmed') return res.json({ alreadyPaid: true });
  try {
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: b.deposit_cents,
          product_data: { name: `One Touch Cleaning — $${(b.deposit_cents / 100).toFixed(0)} non-refundable booking deposit (${b.booking_code})` },
        },
        quantity: 1,
      }],
      customer_email: b.customer_email,
      metadata: { booking_id: String(b.id), booking_code: b.booking_code },
      success_url: `${baseUrl(req)}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl(req)}/cancel.html?booking=${b.booking_code}`,
    });
    db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').run(session.id, b.id);
    res.json({ url: session.url });
  } catch (e) {
    console.error('stripe checkout error:', e.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again or call/text (561) 294-9666.' });
  }
});

/** Confirm a booking from a Stripe Checkout Session id. Idempotent. */
async function confirmBookingBySession(sessionId) {
  const s = getStripe();
  if (!s) throw new Error('stripe not configured');
  const session = await s.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') throw new Error('payment not completed');
  const bookingId = parseInt(session.metadata.booking_id, 10);
  const b = bookingWithService(bookingId);
  if (!b) throw new Error('booking not found');
  if (b.status === 'confirmed') return b; // idempotent
  db.prepare("UPDATE bookings SET status = 'confirmed', deposit_paid_at = datetime('now') WHERE id = ?").run(b.id);
  const fresh = bookingWithService(b.id);
  const oe = ownerEmail();
  try {
    await email.sendOwnerNotification(oe, fresh);
    await email.sendCustomerConfirmation(fresh);
  } catch (e) {
    console.error('confirmation email failed:', e.message);
  }
  return fresh;
}

app.get('/api/bookings/confirm', async (req, res) => {
  try {
    const b = await confirmBookingBySession(req.query.session_id);
    res.json({ ok: true, booking_code: b.booking_code, status: b.status });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Customer self-service lookup + change requests
app.post('/api/bookings/lookup', (req, res) => {
  const { code, email: em } = req.body;
  const b = db.prepare(`
    SELECT b.*, s.name AS service_name FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id
    WHERE b.booking_code = ? AND lower(b.customer_email) = lower(?)
  `).get((code || '').trim().toUpperCase(), (em || '').trim());
  if (!b) return res.status(404).json({ error: 'Booking not found. Check your code and email.' });
  const { stripe_session_id, ...safe } = b;
  res.json(safe);
});

app.post('/api/bookings/:id/change-request', async (req, res) => {
  const b = bookingWithService(req.params.id);
  if (!b || b.status === 'cancelled') return res.status(404).json({ error: 'Booking not found.' });
  const { type, requested_date, requested_start, requested_end, message } = req.body;
  if (!['cancel', 'reschedule'].includes(type)) return res.status(400).json({ error: 'Invalid request type.' });
  if (type === 'reschedule') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested_date || '') || !/^\d{2}:\d{2}$/.test(requested_start || '')) {
      return res.status(400).json({ error: 'Please choose a valid new date and start time.' });
    }
  }
  const info = db.prepare(`
    INSERT INTO change_requests (booking_id, type, requested_date, requested_start, requested_end, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(b.id, type, requested_date || null, requested_start || null, requested_end || null, (message || '').trim());
  try {
    await email.sendChangeNotice(ownerEmail(), b, type,
      `${type === 'cancel' ? 'Cancellation' : 'Reschedule'} requested by customer.\n` +
      (requested_date ? `Requested: ${requested_date} ${requested_start || ''}–${requested_end || ''}\n` : '') +
      `Message: ${message || '—'}`);
  } catch (e) { console.error('change notice email failed:', e.message); }
  res.status(201).json({ id: info.lastInsertRowid });
});

// ---------- admin ----------
const adminTokens = new Set();
function requireAdmin(req, res, next) {
  if (req.cookies.otc_admin && adminTokens.has(req.cookies.otc_admin)) return next();
  res.status(401).json({ error: 'admin login required' });
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'wrong password' });
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  res.cookie('otc_admin', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  if (req.cookies.otc_admin) adminTokens.delete(req.cookies.otc_admin);
  res.clearCookie('otc_admin');
  res.json({ ok: true });
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT b.*, s.name AS service_name FROM bookings b LEFT JOIN services s ON s.id = b.service_id`;
  const params = [];
  const conds = [];
  if (from) { conds.push('b.date >= ?'); params.push(from); }
  if (to) { conds.push('b.date <= ?'); params.push(to); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY b.date, b.start_time';
  res.json(db.prepare(sql).all(...params));
});

app.patch('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const b = bookingWithService(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  const { status } = req.body;
  if (!['confirmed', 'cancelled', 'completed', 'pending_payment'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, b.id);
  const fresh = bookingWithService(b.id);
  try {
    if (status === 'cancelled') {
      await email.sendCustomerStatusNotice(fresh, 'Booking cancelled',
        `Your appointment on ${hours.formatDateLong(fresh.date)} at ${hours.formatTime12(fresh.start_time)} has been cancelled.`);
    }
  } catch (e) { console.error('status email failed:', e.message); }
  res.json({ ok: true });
});

app.get('/api/admin/blocks', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM blocked_periods ORDER BY date, start_time').all());
});

app.post('/api/admin/blocks', requireAdmin, (req, res) => {
  const { date, start_time, end_time, reason } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'valid date required' });
  if ((start_time && !end_time) || (!start_time && end_time)) return res.status(400).json({ error: 'start and end must both be set or both empty (whole day)' });
  if (start_time && (start_time >= end_time)) return res.status(400).json({ error: 'end must be after start' });
  const info = db.prepare('INSERT INTO blocked_periods (date, start_time, end_time, reason) VALUES (?, ?, ?, ?)')
    .run(date, start_time || null, end_time || null, (reason || '').trim());
  res.status(201).json({ id: info.lastInsertRowid });
});

app.delete('/api/admin/blocks/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM blocked_periods WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = ['business_hours', 'deposit_cents', 'owner_email', 'owner_phone', 'business_name'];
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      let v = req.body[k];
      if (k === 'business_hours') {
        try { JSON.parse(v); } catch { return res.status(400).json({ error: 'business_hours must be valid JSON' }); }
      }
      setSetting(db, k, String(v));
    }
  }
  res.json({ ok: true });
});

app.get('/api/admin/services', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM services ORDER BY sort_order').all());
});

app.put('/api/admin/services/:id', requireAdmin, (req, res) => {
  const allowed = ['name', 'description', 'price_type', 'price_min_cents', 'price_max_cents', 'min_hours', 'active', 'sort_order'];
  const sets = [], params = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { sets.push(`${k} = ?`); params.push(req.body[k]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

app.get('/api/admin/change-requests', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT cr.*, b.booking_code, b.customer_name, b.date, b.start_time, b.end_time
    FROM change_requests cr JOIN bookings b ON b.id = cr.booking_id
    ORDER BY cr.created_at DESC
  `).all());
});

app.post('/api/admin/change-requests/:id/decision', requireAdmin, async (req, res) => {
  const cr = db.prepare('SELECT * FROM change_requests WHERE id = ?').get(req.params.id);
  if (!cr || cr.status !== 'pending') return res.status(404).json({ error: 'request not found or already handled' });
  const b = bookingWithService(cr.booking_id);
  const approve = req.body.approve === true;

  if (!approve) {
    db.prepare("UPDATE change_requests SET status = 'denied' WHERE id = ?").run(cr.id);
    return res.json({ ok: true, decision: 'denied' });
  }

  if (cr.type === 'cancel') {
    dbModule.transaction(db, () => {
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
      db.prepare("UPDATE change_requests SET status = 'approved' WHERE id = ?").run(cr.id);
    });
    try {
      await email.sendCustomerStatusNotice(bookingWithService(b.id), 'Booking cancelled',
        'Your cancellation request was approved. We hope to clean for you another time!');
    } catch (e) { console.error('email failed:', e.message); }
    return res.json({ ok: true, decision: 'approved' });
  }

  // reschedule — re-check overlap excluding this booking, atomically
  try {
    dbModule.transaction(db, () => {
      // exclude this booking's own current slot from the clash check
      const others = db.prepare(`
        SELECT start_time AS start, end_time AS end FROM bookings
        WHERE date = ? AND id != ? AND status IN ('pending_payment','confirmed')
      `).all(cr.requested_date, b.id).concat(
        db.prepare('SELECT start_time AS start, end_time AS end FROM blocked_periods WHERE date = ?').all(cr.requested_date)
      );
      void busy;
      const clash = others.some(r => hours.rangesOverlap(cr.requested_start, cr.requested_end, r.start, r.end));
      if (clash) {
        const err = new Error('Requested slot is no longer free.');
        err.code = 'SLOT_TAKEN';
        throw err;
      }
      db.prepare('UPDATE bookings SET date = ?, start_time = ?, end_time = ? WHERE id = ?')
        .run(cr.requested_date, cr.requested_start, cr.requested_end, b.id);
      db.prepare("UPDATE change_requests SET status = 'approved' WHERE id = ?").run(cr.id);
    });
    const fresh = bookingWithService(b.id);
    try {
      await email.sendCustomerStatusNotice(fresh, 'Booking rescheduled',
        `Your appointment was moved to ${hours.formatDateLong(fresh.date)} at ${hours.formatTime12(fresh.start_time)}.`);
    } catch (e) { console.error('email failed:', e.message); }
    res.json({ ok: true, decision: 'approved' });
  } catch (e) {
    if (e.code === 'SLOT_TAKEN') return res.status(409).json({ error: e.message });
    throw e;
  }
});

// Reminder cron: GET /api/cron/reminders?secret=...  (call daily ~8am ET)
app.get('/api/cron/reminders', async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const t = hours.nowInTZ();
  const [y, m, d] = t.date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1);
  const tmr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const due = db.prepare(`
    SELECT b.*, s.name AS service_name FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id
    WHERE b.date = ? AND b.status = 'confirmed' AND b.reminder_sent_at IS NULL
  `).all(tmr);
  let sent = 0;
  for (const b of due) {
    try {
      await email.sendReminder(b);
      db.prepare("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?").run(b.id);
      sent++;
    } catch (e) { console.error('reminder failed for', b.booking_code, e.message); }
  }
  res.json({ ok: true, sent, date: tmr });
});

// ---- error handler ----
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`One Touch Cleaning booking site running on http://localhost:${PORT}`);
    console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? 'configured' : 'NOT configured (set STRIPE_SECRET_KEY)'}`);
    console.log(`Email: ${email.isConfigured() ? 'configured' : 'NOT configured (set GMAIL_USER + GMAIL_APP_PASSWORD)'}`);
  });
}

module.exports = app;

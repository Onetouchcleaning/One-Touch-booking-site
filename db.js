'use strict';

/**
 * SQLite storage via Node's built-in node:sqlite (no native build needed).
 * All booking writes that must not double-book run inside a BEGIN IMMEDIATE
 * transaction so concurrent requests serialize and the overlap check +
 * insert are atomic.
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_HOURS } = require('./lib/hours');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bookings.db');

function randomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'OTC-' + s;
}

/** Run fn() inside a BEGIN IMMEDIATE transaction. Rolls back on throw. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

function openDb(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_type TEXT NOT NULL DEFAULT 'hourly',
      price_min_cents INTEGER NOT NULL DEFAULT 0,
      price_max_cents INTEGER NOT NULL DEFAULT 0,
      min_hours REAL NOT NULL DEFAULT 2,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_code TEXT NOT NULL UNIQUE,
      service_id INTEGER REFERENCES services(id),
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      total_estimate_cents INTEGER NOT NULL DEFAULT 0,
      deposit_cents INTEGER NOT NULL DEFAULT 5000,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      deposit_ack INTEGER NOT NULL DEFAULT 0,
      stripe_session_id TEXT,
      deposit_paid_at TEXT,
      reminder_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_date
      ON bookings(date, status, start_time, end_time);
    CREATE TABLE IF NOT EXISTS blocked_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_blocked_date ON blocked_periods(date);
    CREATE TABLE IF NOT EXISTS change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      requested_date TEXT,
      requested_start TEXT,
      requested_end TEXT,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

/** Busy ranges (confirmed + unpaid holds) for a date. Blocks included. */
function getBusyRanges(db, dateStr) {
  const bookings = db.prepare(`
    SELECT start_time AS start, end_time AS end FROM bookings
    WHERE date = ? AND status IN ('pending_payment', 'confirmed')
  `).all(dateStr);
  const blocks = db.prepare(`
    SELECT start_time AS start, end_time AS end FROM blocked_periods WHERE date = ?
  `).all(dateStr);
  return bookings.concat(blocks);
}

/**
 * Atomically check overlap and insert a booking.
 * Throws Error with code 'SLOT_TAKEN' when the slot is no longer free.
 */
function createBookingAtomic(db, data) {
  return transaction(db, () => {
    const busy = getBusyRanges(db, data.date);
    const { rangesOverlap } = require('./lib/hours');
    const clash = busy.some(r => rangesOverlap(data.start_time, data.end_time, r.start, r.end));
    if (clash) {
      const err = new Error('That time was just taken. Please pick another slot.');
      err.code = 'SLOT_TAKEN';
      throw err;
    }
    const code = randomCode();
    const info = db.prepare(`
      INSERT INTO bookings
        (booking_code, service_id, customer_name, customer_email, customer_phone,
         address, notes, date, start_time, end_time, duration_minutes,
         total_estimate_cents, deposit_cents, balance_cents, deposit_ack, status)
      VALUES (@booking_code, @service_id, @customer_name, @customer_email, @customer_phone,
         @address, @notes, @date, @start_time, @end_time, @duration_minutes,
         @total_estimate_cents, @deposit_cents, @balance_cents, @deposit_ack, 'pending_payment')
    `).run({ ...data, booking_code: code });
    return { id: Number(info.lastInsertRowid), booking_code: code };
  });
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function getHoursConfig(db) {
  const raw = getSetting(db, 'business_hours', null);
  if (!raw) return DEFAULT_HOURS;
  try { return JSON.parse(raw); } catch { return DEFAULT_HOURS; }
}

function getDepositCents(db) {
  return parseInt(getSetting(db, 'deposit_cents', '5000'), 10) || 5000;
}

const SEED_SERVICES = [
  { name: 'Standard Cleaning', description: 'Keep your home fresh and spotless. Weekly, bi-weekly or one-time.', price_type: 'hourly', price_min_cents: 8500, price_max_cents: 8500, min_hours: 2, sort_order: 1 },
  { name: 'Deep Cleaning', description: 'A deeper, more detailed clean. Organizing included.', price_type: 'hourly', price_min_cents: 11000, price_max_cents: 11000, min_hours: 2, sort_order: 2 },
  { name: 'Move-Out Cleaning (1 BR)', description: 'Leave it spotless for what\u2019s next.', price_type: 'flat_range', price_min_cents: 15000, price_max_cents: 20000, min_hours: 2, sort_order: 3 },
  { name: 'Move-Out Cleaning (2 BR)', description: 'Leave it spotless for what\u2019s next.', price_type: 'flat_range', price_min_cents: 20000, price_max_cents: 30000, min_hours: 2, sort_order: 4 },
  { name: 'Move-Out Cleaning (3 BR)', description: 'Leave it spotless for what\u2019s next.', price_type: 'flat_range', price_min_cents: 30000, price_max_cents: 45000, min_hours: 2, sort_order: 5 },
  { name: 'Move-Out Cleaning (4 BR)', description: 'Leave it spotless for what\u2019s next.', price_type: 'flat_range', price_min_cents: 45000, price_max_cents: 55000, min_hours: 2, sort_order: 6 },
  { name: 'Move-Out Cleaning (5+ BR)', description: 'Leave it spotless for what\u2019s next.', price_type: 'flat_range', price_min_cents: 60000, price_max_cents: 60000, min_hours: 2, sort_order: 7 },
  { name: 'Apartment / Airbnb / Commercial', description: 'Reliable cleaning for properties of all sizes. Weekly, bi-weekly or one-time.', price_type: 'quote', price_min_cents: 0, price_max_cents: 0, min_hours: 2, sort_order: 8 },
  { name: 'Post-Construction Cleaning', description: 'Remove dust, debris and get it move-in ready.', price_type: 'quote', price_min_cents: 0, price_max_cents: 0, min_hours: 2, sort_order: 9 },
  { name: 'Laundry Service', description: 'Pick-up & drop-off. Wash, dry, fold. 24-hour turnaround. $2\u2013$4 per pound.', price_type: 'quote', price_min_cents: 0, price_max_cents: 0, min_hours: 2, sort_order: 10 },
];

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM services').get().c;
  if (Number(count) === 0) {
    const stmt = db.prepare(`
      INSERT INTO services (name, description, price_type, price_min_cents, price_max_cents, min_hours, sort_order)
      VALUES (@name, @description, @price_type, @price_min_cents, @price_max_cents, @min_hours, @sort_order)
    `);
    transaction(db, () => { for (const s of SEED_SERVICES) stmt.run(s); });
  }
  if (getSetting(db, 'business_hours') == null) {
    setSetting(db, 'business_hours', JSON.stringify(DEFAULT_HOURS));
  }
  const defaults = {
    deposit_cents: '5000',
    owner_email: process.env.OWNER_EMAIL || 'onetouchcleaning.bf@gmail.com',
    owner_phone: '(561) 294-9666',
    business_name: 'One Touch Cleaning LLC',
    timezone: 'America/New_York',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (getSetting(db, k) == null) setSetting(db, k, v);
  }
}

module.exports = {
  openDb, seed, getBusyRanges, createBookingAtomic, transaction,
  getSetting, setSetting, getHoursConfig, getDepositCents,
  SEED_SERVICES,
};

if (require.main === module && process.argv.includes('--seed')) {
  require('dotenv').config();
  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = openDb();
  seed(db);
  console.log('Seeded', DB_PATH);
  db.close();
}

'use strict';

/**
 * Quick verification of booking logic:
 *  - business hours (Mon–Tue 9–6, Wed–Fri 9–4:30, Sat/Sun closed)
 *  - 2-hour minimum enforced
 *  - start times fit fully within business hours
 *  - DB-level overlap prevention (incl. blocked periods)
 *  - same-day past times excluded
 *
 * Run: node test/logic.test.js   (or: npm test)
 */

const assert = require('assert');
const hours = require('../lib/hours');
const dbModule = require('../db');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

// Pick fixed known weekdays (2026-10-19 is a Monday).
const MON = '2026-10-19', TUE = '2026-10-20', WED = '2026-10-21',
      FRI = '2026-10-23', SAT = '2026-10-24', SUN = '2026-10-25';

console.log('hours config');
check('Mon/Tue open 9–6', () => {
  assert.deepStrictEqual(hours.hoursFor(MON), { open: '09:00', close: '18:00' });
  assert.deepStrictEqual(hours.hoursFor(TUE), { open: '09:00', close: '18:00' });
});
check('Wed–Fri open 9–4:30', () => {
  assert.deepStrictEqual(hours.hoursFor(WED), { open: '09:00', close: '16:30' });
  assert.deepStrictEqual(hours.hoursFor(FRI), { open: '09:00', close: '16:30' });
});
check('Sat/Sun closed', () => {
  assert.strictEqual(hours.hoursFor(SAT), null);
  assert.strictEqual(hours.hoursFor(SUN), null);
});

console.log('availability');
const fakeNow = new Date('2026-10-01T08:00:00-04:00'); // morning, before test dates
check('2h minimum enforced (90 min -> no slots)', () => {
  assert.deepStrictEqual(hours.availableStartTimes(MON, 90, hours.DEFAULT_HOURS, [], fakeNow), []);
});
check('Mon 2h: first 9:00, last 16:00', () => {
  const s = hours.availableStartTimes(MON, 120, hours.DEFAULT_HOURS, [], fakeNow);
  assert.strictEqual(s[0], '09:00');
  assert.strictEqual(s[s.length - 1], '16:00'); // 16:00+2h = 18:00 close
  assert.ok(!s.includes('16:30'), '16:30 would end after close');
});
check('Fri 2h: last start 14:30 (ends 16:30)', () => {
  const s = hours.availableStartTimes(FRI, 120, hours.DEFAULT_HOURS, [], fakeNow);
  assert.strictEqual(s[s.length - 1], '14:30');
});
check('Fri 3h: last start 13:30', () => {
  const s = hours.availableStartTimes(FRI, 180, hours.DEFAULT_HOURS, [], fakeNow);
  assert.strictEqual(s[s.length - 1], '13:30');
});
check('closed day -> no slots', () => {
  assert.deepStrictEqual(hours.availableStartTimes(SUN, 120, hours.DEFAULT_HOURS, [], fakeNow), []);
});
check('busy booking removes overlapping starts', () => {
  const busy = [{ start: '10:00', end: '12:00' }];
  const s = hours.availableStartTimes(MON, 120, hours.DEFAULT_HOURS, busy, fakeNow);
  assert.ok(!s.includes('09:00'), '9–11 overlaps 10–12');
  assert.ok(!s.includes('10:00') && !s.includes('11:00') && !s.includes('11:30'));
  assert.ok(s.includes('12:00'), '12:00 start is free');
});
check('whole-day block removes all slots', () => {
  const s = hours.availableStartTimes(MON, 120, hours.DEFAULT_HOURS, [{ start: null, end: null }], fakeNow);
  assert.deepStrictEqual(s, []);
});
check('same-day past times excluded', () => {
  const noon = new Date('2026-10-19T12:00:00-04:00');
  const s = hours.availableStartTimes(MON, 120, hours.DEFAULT_HOURS, [], noon);
  assert.ok(s.every(t => t > '12:00'), 'all starts after now');
  assert.strictEqual(s[0], '12:30');
});

console.log('database overlap prevention');
{
  const db = dbModule.openDb(':memory:');
  dbModule.seed(db);
  const mk = (date, start, end, status = 'confirmed') => ({
    service_id: 1, customer_name: 'Test', customer_email: 't@t.com',
    customer_phone: '', address: '', notes: '', date,
    start_time: start, end_time: end, duration_minutes: 120,
    total_estimate_cents: 17000, deposit_cents: 5000, balance_cents: 12000, deposit_ack: 1,
  });

  check('first booking inserts fine', () => {
    const r = dbModule.createBookingAtomic(db, mk(MON, '10:00', '12:00'));
    assert.ok(r.booking_code.startsWith('OTC-'));
  });
  check('overlapping booking rejected with SLOT_TAKEN', () => {
    assert.throws(() => dbModule.createBookingAtomic(db, mk(MON, '11:00', '13:00')), /just taken/);
  });
  check('adjacent booking allowed (12:00 start)', () => {
    dbModule.createBookingAtomic(db, mk(MON, '12:00', '14:00'));
  });
  check('cancelled booking does not block', () => {
    db.prepare("UPDATE bookings SET status='cancelled' WHERE start_time='10:00'").run();
    dbModule.createBookingAtomic(db, mk(MON, '10:00', '12:00'));
  });
  check('blocked period blocks booking', () => {
    db.prepare("INSERT INTO blocked_periods (date, start_time, end_time, reason) VALUES (?, '14:00', '18:00', 'off')").run(TUE);
    assert.throws(() => dbModule.createBookingAtomic(db, mk(TUE, '14:00', '16:00')), /just taken/);
    dbModule.createBookingAtomic(db, mk(TUE, '09:00', '11:00')); // outside block: fine
  });
  check('whole-day block blocks everything', () => {
    db.prepare('INSERT INTO blocked_periods (date, reason) VALUES (?, ?)').run(WED, 'holiday');
    assert.throws(() => dbModule.createBookingAtomic(db, mk(WED, '09:00', '11:00')), /just taken/);
  });
  check('availability reflects DB bookings', () => {
    const busy = dbModule.getBusyRanges(db, MON);
    const s = hours.availableStartTimes(MON, 120, hours.DEFAULT_HOURS, busy, fakeNow);
    assert.ok(!s.includes('10:00') && !s.includes('12:00'));
    assert.ok(s.includes('14:00'));
  });
  check('seeded 10 services', () => {
    const c = db.prepare('SELECT COUNT(*) c FROM services').get().c;
    assert.strictEqual(Number(c), 10);
  });
  db.close();
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);

'use strict';

/**
 * Business-hours & availability logic for One Touch Cleaning LLC.
 * All times are wall-clock times in America/New_York ("HH:MM", zero-padded
 * so lexicographic string comparison is chronological).
 */

const TIME_ZONE = 'America/New_York';

/** Default hours: Mon-Tue 9a-6p, Wed-Fri 9a-4:30p, Sat/Sun closed. Keys are JS getDay() values. */
const DEFAULT_HOURS = {
  0: null, // Sunday — closed
  1: { open: '09:00', close: '18:00' },
  2: { open: '09:00', close: '18:00' },
  3: { open: '09:00', close: '16:30' },
  4: { open: '09:00', close: '16:30' },
  5: { open: '09:00', close: '16:30' },
  6: null, // Saturday — closed
};

const MIN_DURATION_MINUTES = 120;
const SLOT_STEP_MINUTES = 30;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/** Current date/time parts in America/New_York. */
function nowInTZ(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`, // YYYY-MM-DD
    time: parts.hour === '24' ? '00:' + parts.minute : `${parts.hour}:${parts.minute}`,
    day: dayMap[parts.weekday],
  };
}

/** Day of week (0=Sun..6=Sat) for a YYYY-MM-DD date, computed in ET. */
function dayOfWeek(dateStr) {
  // Noon ET avoids DST-boundary issues.
  const d = new Date(`${dateStr}T12:00:00-05:00`);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
}

/** Hours object for a date given the hours config (or DEFAULT_HOURS). */
function hoursFor(dateStr, hoursConfig = DEFAULT_HOURS) {
  return hoursConfig[dayOfWeek(dateStr)] || null;
}

/**
 * Do two [start,end) ranges overlap? Times are "HH:MM" strings.
 * Full-day blocks are represented with start=null/end=null and always overlap.
 */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (aStart == null || bStart == null) return true;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Compute available start times for a date + duration.
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} durationMinutes >= 120
 * @param {object} hoursConfig
 * @param {Array<{start:string|null,end:string|null}>} busy — existing bookings + blocks
 * @param {Date} nowRef — reference "now" (for same-day filtering); defaults to real now
 * @returns {string[]} available "HH:MM" start times
 */
function availableStartTimes(dateStr, durationMinutes, hoursConfig, busy, nowRef = new Date()) {
  if (durationMinutes < MIN_DURATION_MINUTES) return [];
  const hours = hoursFor(dateStr, hoursConfig);
  if (!hours) return []; // closed

  const openMin = toMinutes(hours.open);
  const closeMin = toMinutes(hours.close);
  const lastStart = closeMin - durationMinutes;
  if (lastStart < openMin) return [];

  const now = nowInTZ(nowRef);
  const isToday = dateStr === now.date;
  const nowMin = toMinutes(now.time);

  const out = [];
  for (let s = openMin; s <= lastStart; s += SLOT_STEP_MINUTES) {
    if (isToday && s <= nowMin) continue; // must start in the future
    const start = toHHMM(s);
    const end = toHHMM(s + durationMinutes);
    const clash = busy.some(b => rangesOverlap(start, end, b.start, b.end));
    if (!clash) out.push(start);
  }
  return out;
}

/** Is a YYYY-MM-DD string today or in the future (ET)? */
function isFutureOrToday(dateStr, nowRef = new Date()) {
  return dateStr >= nowInTZ(nowRef).date;
}

function formatTime12(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

module.exports = {
  TIME_ZONE,
  DEFAULT_HOURS,
  MIN_DURATION_MINUTES,
  SLOT_STEP_MINUTES,
  toMinutes,
  toHHMM,
  nowInTZ,
  dayOfWeek,
  hoursFor,
  rangesOverlap,
  availableStartTimes,
  isFutureOrToday,
  formatTime12,
  formatDateLong,
};

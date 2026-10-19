'use strict';
/* Booking wizard for One Touch Cleaning */

const state = {
  services: [],
  settings: null,
  serviceId: null,
  duration: 120,
  date: '',
  start: '',
  bookingId: null,
  bookingCode: null,
};

const $ = id => document.getElementById(id);
const money = c => '$' + (c / 100).toFixed(2);

function priceLabel(s) {
  if (s.price_type === 'hourly') return `Starting at ${money(s.price_min_cents)} / hr`;
  if (s.price_type === 'flat_range') {
    return s.price_max_cents > s.price_min_cents
      ? `${money(s.price_min_cents)} – ${money(s.price_max_cents)}`
      : `Starting at ${money(s.price_min_cents)}`;
  }
  return 'Custom quote';
}

async function init() {
  const [svcRes, setRes] = await Promise.all([fetch('/api/services'), fetch('/api/settings/public')]);
  state.services = await svcRes.json();
  state.settings = await setRes.json();
  renderServiceCards();
  renderServiceOptions();
  renderDurations();
  bindWizard();
  bindLookup();
  const d = $('fDate');
  const today = new Date();
  d.min = today.toISOString().slice(0, 10);
  const max = new Date(today); max.setDate(max.getDate() + 90);
  d.max = max.toISOString().slice(0, 10);
}

function renderServiceCards() {
  $('serviceCards').innerHTML = state.services.map(s => `
    <div class="card">
      <h3>${esc(s.name)}</h3>
      <p>${esc(s.description)}</p>
      <div class="price">${priceLabel(s)}</div>
      <div class="muted">${s.min_hours}-hour minimum</div>
      <button class="btn btn-gold" data-book="${s.id}">Book this</button>
    </div>`).join('');
  document.querySelectorAll('[data-book]').forEach(b => b.addEventListener('click', () => {
    $('fService').value = b.dataset.book;
    onServiceChange();
    document.getElementById('book').scrollIntoView({ behavior: 'smooth' });
  }));
}

function renderServiceOptions() {
  $('fService').innerHTML = state.services.map(s =>
    `<option value="${s.id}">${esc(s.name)} — ${priceLabel(s)}</option>`).join('');
  onServiceChange();
}

function onServiceChange() {
  state.serviceId = parseInt($('fService').value, 10);
  renderDurations();
  refreshAvailability();
}

function renderDurations() {
  const svc = state.services.find(s => s.id === state.serviceId);
  const minH = svc ? Math.max(2, svc.min_hours) : 2;
  const opts = [];
  for (let h = minH; h <= 8; h++) opts.push(h * 60);
  $('fDuration').innerHTML = opts.map(m =>
    `<option value="${m}">${(m / 60).toFixed(m % 60 ? 1 : 0)} hour${m === 60 ? '' : 's'}</option>`).join('');
  state.duration = parseInt($('fDuration').value, 10);
}

function bindWizard() {
  $('fService').addEventListener('change', onServiceChange);
  $('fDuration').addEventListener('change', () => { state.duration = parseInt($('fDuration').value, 10); refreshAvailability(); });
  $('fDate').addEventListener('change', () => { state.date = $('fDate').value; refreshAvailability(); });
  $('fAck').addEventListener('change', () => { $('payBtn').disabled = !$('fAck').checked; });

  document.querySelectorAll('[data-next]').forEach(b => b.addEventListener('click', () => goStep(parseInt(b.dataset.next, 10))));
  document.querySelectorAll('[data-prev]').forEach(b => b.addEventListener('click', () => goStep(parseInt(b.dataset.prev, 10))));
  $('payBtn').addEventListener('click', submitBooking);
}

function goStep(n) {
  if (n === 3 && !validateDetails()) return;
  if (n === 4) renderDepositSummary();
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane != n));
  document.querySelectorAll('.steps li').forEach(li => li.classList.toggle('active', li.dataset.step == n));
  document.querySelector('.wizard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function refreshAvailability() {
  const grid = $('slotGrid');
  state.start = '';
  $('toStep3').disabled = true;
  if (!state.date) { grid.innerHTML = '<p class="muted">Pick a date to see available times.</p>'; return; }
  grid.innerHTML = '<p class="muted">Checking availability…</p>';
  const r = await fetch(`/api/availability?date=${state.date}&duration=${state.duration}`);
  const data = await r.json();
  if (data.closed) {
    $('hoursNote').textContent = data.reason === 'closed' ? 'Closed on this day. Please pick another date.' : '';
    grid.innerHTML = '<p class="muted">No availability on this date.</p>';
    return;
  }
  $('hoursNote').textContent = `Open ${fmt12(data.open)} – ${fmt12(data.close)} (Eastern). Showing start times that fit a ${state.duration / 60}-hour visit.`;
  if (!data.slots.length) { grid.innerHTML = '<p class="muted">Fully booked — please try another date.</p>'; return; }
  grid.innerHTML = data.slots.map(t => `<button class="slot" data-t="${t}">${fmt12(t)}</button>`).join('');
  grid.querySelectorAll('.slot').forEach(b => b.addEventListener('click', () => {
    grid.querySelectorAll('.slot').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    state.start = b.dataset.t;
    $('toStep3').disabled = false;
  }));
}

function validateDetails() {
  if (!state.start) { alert('Please pick a time slot first.'); return false; }
  if ($('fName').value.trim().length < 2) { alert('Please enter your name.'); return false; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test($('fEmail').value.trim())) { alert('Please enter a valid email.'); return false; }
  const svc = state.services.find(s => s.id === state.serviceId);
  $('bookingSummary').innerHTML = `
    <b>${esc(svc.name)}</b> · ${fmtDate(state.date)}<br>
    <b>${fmt12(state.start)}</b> – ${fmt12(addMin(state.start, state.duration))} Eastern · ${state.duration / 60} hour(s)<br>
    Estimated total: <b>${estimateLabel(svc)}</b>`;
  return true;
}

function estimateLabel(svc) {
  if (svc.price_type === 'hourly') return money(Math.round(svc.price_min_cents / 100 * (state.duration / 60))) + ' (approx.)';
  if (svc.price_type === 'flat_range') return priceLabel(svc);
  return 'Custom quote at visit';
}

function renderDepositSummary() {
  const dep = state.settings.deposit_cents;
  $('depositSummary').innerHTML =
    `Deposit due now: <b>${money(dep)} (non-refundable)</b><br>Remaining balance due at service.`;
}

async function submitBooking() {
  const err = $('bookError');
  err.classList.add('hidden');
  $('payBtn').disabled = true;
  $('payBtn').textContent = 'Reserving…';
  try {
    const r = await fetch('/api/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: state.serviceId,
        customer_name: $('fName').value.trim(),
        customer_email: $('fEmail').value.trim(),
        customer_phone: $('fPhone').value.trim(),
        address: $('fAddress').value.trim(),
        notes: $('fNotes').value.trim(),
        date: state.date,
        start_time: state.start,
        duration_minutes: state.duration,
        deposit_ack: $('fAck').checked,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error((data.errors || [data.error || 'Booking failed']).join(' '));
    const c = await fetch(`/api/bookings/${data.id}/checkout`, { method: 'POST' });
    const cdata = await c.json();
    if (!c.ok || !cdata.url) throw new Error(cdata.error || 'Could not start payment.');
    window.location.href = cdata.url; // Stripe Checkout
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
    $('payBtn').disabled = false;
    $('payBtn').textContent = `Pay ${money(state.settings.deposit_cents)} Deposit & Book`;
  }
}

// ---- lookup / change requests ----
function bindLookup() {
  $('lookupBtn').addEventListener('click', async () => {
    const box = $('lookupResult');
    box.innerHTML = '<p class="muted">Looking up…</p>';
    const r = await fetch('/api/bookings/lookup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('lCode').value, email: $('lEmail').value }),
    });
    const b = await r.json();
    if (!r.ok) { box.innerHTML = `<p class="error">${esc(b.error)}</p>`; return; }
    box.innerHTML = `
      <div class="cardrow">
        <b>${esc(b.service_name || '')}</b> — ${fmtDate(b.date)} at ${fmt12(b.start_time)}<br>
        <span class="muted">Status: ${esc(b.status)} · Code: ${esc(b.booking_code)}</span>
        <div style="margin-top:.8rem;display:flex;gap:.6rem;flex-wrap:wrap">
          <button class="btn btn-ghost" id="reqCancel">Request cancellation</button>
          <button class="btn btn-ghost" id="reqResched">Request reschedule</button>
        </div>
        <div id="reqForm" style="margin-top:.8rem"></div>
      </div>`;
    $('reqCancel').onclick = () => showReqForm(b, 'cancel');
    $('reqResched').onclick = () => showReqForm(b, 'reschedule');
  });
}

function showReqForm(b, type) {
  const f = $('reqForm');
  f.innerHTML = type === 'cancel'
    ? `<textarea id="reqMsg" rows="2" placeholder="Reason (optional)" style="width:100%"></textarea>
       <button class="btn btn-gold" id="reqSend">Send cancellation request</button>`
    : `<label class="field">New date<input type="date" id="reqDate"></label>
       <label class="field">New start time<input type="time" id="reqTime"></label>
       <textarea id="reqMsg" rows="2" placeholder="Message (optional)" style="width:100%"></textarea>
       <button class="btn btn-gold" id="reqSend">Send reschedule request</button>`;
  $('reqSend').onclick = async () => {
    const body = { type, message: $('reqMsg').value };
    if (type === 'reschedule') {
      body.requested_date = $('reqDate').value;
      body.requested_start = $('reqTime').value;
      const mins = b.duration_minutes;
      body.requested_end = addMin(body.requested_start, mins);
    }
    const r = await fetch(`/api/bookings/${b.id}/change-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    f.innerHTML = r.ok ? '<p><b>Request sent!</b> We\u2019ll email you once it\u2019s reviewed.</p>'
                      : `<p class="error">${esc(d.error || 'Failed')}</p>`;
  };
}

// ---- utils ----
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt12(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
function addMin(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
function fmtDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

document.addEventListener('DOMContentLoaded', init);

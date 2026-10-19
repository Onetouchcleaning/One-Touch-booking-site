'use strict';
/* Owner dashboard */

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => '$' + (c / 100).toFixed(2);
const fmt12 = t => { if (!t) return '—'; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { showLogin(); throw new Error('login required'); }
  return r;
}

function showLogin() {
  $('loginView').classList.remove('hidden');
  $('dashView').classList.add('hidden');
}
function showDash() {
  $('loginView').classList.add('hidden');
  $('dashView').classList.remove('hidden');
  loadBookings(); loadRequests(); loadBlocks(); loadSettings(); loadServices();
}

async function trySession() {
  try { const r = await api('/api/admin/bookings?from=2000-01-01&to=2000-01-02'); if (r.ok) showDash(); else showLogin(); }
  catch { showLogin(); }
}

document.addEventListener('DOMContentLoaded', () => {
  $('loginBtn').onclick = async () => {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('adminPass').value }) });
    if (r.ok) { $('adminPass').value = ''; showDash(); }
    else { $('loginErr').textContent = 'Wrong password.'; $('loginErr').classList.remove('hidden'); }
  };
  $('adminPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });
  $('logoutBtn').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); showLogin(); };
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[id^="tab-"]').forEach(t => t.classList.add('hidden'));
    $('tab-' + b.dataset.tab).classList.remove('hidden');
  });
  $('fltGo').onclick = loadBookings;
  $('blkAdd').onclick = addBlock;
  $('setSave').onclick = saveSettings;
  const t = new Date(); $('fltFrom').value = t.toISOString().slice(0, 10);
  const t2 = new Date(); t2.setDate(t2.getDate() + 60); $('fltTo').value = t2.toISOString().slice(0, 10);
  trySession();
});

// ---- bookings ----
async function loadBookings() {
  const r = await api(`/api/admin/bookings?from=${$('fltFrom').value}&to=${$('fltTo').value}`);
  const rows = await r.json();
  $('bookingRows').innerHTML = rows.map(b => `
    <tr>
      <td>${esc(b.date)}</td>
      <td>${fmt12(b.start_time)}–${fmt12(b.end_time)}</td>
      <td><b>${esc(b.customer_name)}</b><br><span class="muted">${esc(b.customer_email)}<br>${esc(b.customer_phone || '')}</span></td>
      <td>${esc(b.service_name || '')}<br><span class="muted">${esc(b.booking_code)}</span></td>
      <td>${money(b.total_estimate_cents)}</td>
      <td>${money(b.deposit_cents)}</td>
      <td><span class="badge b-${b.status}">${esc(b.status)}</span></td>
      <td>
        <select data-act="${b.id}">
          <option value="">—</option>
          <option value="confirmed">Confirm</option>
          <option value="completed">Complete</option>
          <option value="cancelled">Cancel</option>
        </select>
      </td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">No bookings in range.</td></tr>';
  document.querySelectorAll('[data-act]').forEach(sel => sel.onchange = async () => {
    if (!sel.value) return;
    if (sel.value === 'cancelled' && !confirm('Cancel this booking?')) { sel.value = ''; return; }
    await api(`/api/admin/bookings/${sel.dataset.act}`, { method: 'PATCH', body: JSON.stringify({ status: sel.value }) });
    loadBookings();
  });
}

// ---- change requests ----
async function loadRequests() {
  const r = await api('/api/admin/change-requests');
  const rows = await r.json();
  const pending = rows.filter(x => x.status === 'pending');
  $('reqCount').textContent = pending.length ? `(${pending.length})` : '';
  $('reqRows').innerHTML = rows.map(x => `
    <div class="cardrow">
      <b>${esc(x.type)}</b> — ${esc(x.customer_name)} · ${esc(x.booking_code)}
      <span class="badge b-${x.status === 'pending' ? 'pending_payment' : x.status === 'approved' ? 'confirmed' : 'cancelled'}">${esc(x.status)}</span><br>
      <span class="muted">Current: ${esc(x.date)} ${fmt12(x.start_time)}</span><br>
      ${x.requested_date ? `Requested: <b>${esc(x.requested_date)} ${fmt12(x.requested_start)}–${fmt12(x.requested_end)}</b><br>` : ''}
      <span class="muted">${esc(x.message || '')}</span>
      ${x.status === 'pending' ? `<div style="margin-top:.6rem;display:flex;gap:.6rem">
        <button class="btn btn-gold" data-ok="${x.id}">Approve</button>
        <button class="btn btn-ghost" data-no="${x.id}">Deny</button></div>` : ''}
    </div>`).join('') || '<p class="muted">No requests.</p>';
  document.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => decide(b.dataset.ok, true));
  document.querySelectorAll('[data-no]').forEach(b => b.onclick = () => decide(b.dataset.no, false));
}
async function decide(id, approve) {
  const r = await api(`/api/admin/change-requests/${id}/decision`, { method: 'POST', body: JSON.stringify({ approve }) });
  const d = await r.json();
  if (!r.ok) alert(d.error || 'Failed');
  loadRequests(); loadBookings();
}

// ---- blocks ----
async function loadBlocks() {
  const r = await api('/api/admin/blocks');
  const rows = await r.json();
  $('blkRows').innerHTML = rows.map(b => `
    <div class="cardrow"><b>${esc(b.date)}</b> ${b.start_time ? fmt12(b.start_time) + '–' + fmt12(b.end_time) : '(all day)'}
    <span class="muted">${esc(b.reason || '')}</span>
    <button class="btn btn-ghost" data-del="${b.id}" style="float:right">Remove</button></div>`).join('')
    || '<p class="muted">No blocked time.</p>';
  document.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => {
    await api('/api/admin/blocks/' + x.dataset.del, { method: 'DELETE' }); loadBlocks();
  });
}
async function addBlock() {
  const r = await api('/api/admin/blocks', { method: 'POST', body: JSON.stringify({
    date: $('blkDate').value, start_time: $('blkStart').value || null,
    end_time: $('blkEnd').value || null, reason: $('blkReason').value,
  }) });
  const d = await r.json();
  if (!r.ok) alert(d.error || 'Failed'); else { $('blkStart').value = ''; $('blkEnd').value = ''; $('blkReason').value = ''; loadBlocks(); }
}

// ---- settings ----
async function loadSettings() {
  const r = await api('/api/admin/settings');
  const s = await r.json();
  $('setName').value = s.business_name || '';
  $('setEmail').value = s.owner_email || '';
  $('setPhone').value = s.owner_phone || '';
  $('setDeposit').value = s.deposit_cents || '5000';
  $('setHours').value = JSON.stringify(JSON.parse(s.business_hours || '{}'), null, 2);
}
async function saveSettings() {
  const r = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
    business_name: $('setName').value, owner_email: $('setEmail').value,
    owner_phone: $('setPhone').value, deposit_cents: $('setDeposit').value,
    business_hours: $('setHours').value,
  }) });
  const d = await r.json();
  $('setMsg').textContent = r.ok ? 'Saved.' : (d.error || 'Failed');
}

// ---- services ----
async function loadServices() {
  const r = await api('/api/admin/services');
  const rows = await r.json();
  $('svcRows').innerHTML = rows.map(s => `
    <div class="cardrow">
      <b>${esc(s.name)}</b> <span class="muted">${s.active ? 'active' : 'hidden'}</span><br>
      <div class="toolbar">
        <label>Min $ <input type="number" id="pmin${s.id}" value="${s.price_min_cents}" style="width:110px"></label>
        <label>Max $ <input type="number" id="pmax${s.id}" value="${s.price_max_cents}" style="width:110px"></label>
        <label>Min hrs <input type="number" id="hrs${s.id}" value="${s.min_hours}" step="0.5" style="width:70px"></label>
        <label><input type="checkbox" id="act${s.id}" ${s.active ? 'checked' : ''}> active</label>
        <button class="btn btn-gold" data-save="${s.id}">Save</button>
      </div>
      <p class="muted" style="margin:.2rem 0 0">Prices in cents (8500 = $85). Hourly services charge min price × hours.</p>
    </div>`).join('');
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const id = b.dataset.save;
    await api(`/api/admin/services/${id}`, { method: 'PUT', body: JSON.stringify({
      price_min_cents: parseInt($('pmin' + id).value, 10),
      price_max_cents: parseInt($('pmax' + id).value, 10),
      min_hours: parseFloat($('hrs' + id).value),
      active: $('act' + id).checked ? 1 : 0,
    }) });
    loadServices();
  });
}

(() => {
  const $ = (id) => document.getElementById(id);
  const API = 'web';

  const state = {
    slots: [],
    provider: null, // null = everyone
    day: null, // yyyy-mm-dd, local
    picked: null,
    idemKey: null,
    mine: { email: '', cursor: null },
  };

  // ---- helpers -----------------------------------------------------------
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtShort = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  async function api(method, path, { body, headers } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, json, retryAfter: res.headers.get('Retry-After') };
  }

  function show(view) {
    for (const v of ['book', 'done', 'mine']) $(`view-${v}`).hidden = v !== view;
    window.scrollTo({ top: 0 });
  }

  // ---- browsing ----------------------------------------------------------
  async function loadSlots() {
    const r = await api('GET', '/slots');
    if (!r.ok) {
      $('slots').innerHTML = '<p class="empty">We couldn\'t load appointment times. Please refresh in a moment.</p>';
      return;
    }
    const now = Date.now();
    state.slots = r.json.slots.filter((s) => new Date(s.start).getTime() > now);
    renderProviders();
    renderDays();
    renderSlots();
  }

  const visible = () => state.slots.filter((s) => !state.provider || s.provider === state.provider);

  function renderProviders() {
    const names = [...new Set(state.slots.map((s) => s.provider))];
    const wrap = $('providers');
    wrap.innerHTML = '';
    for (const name of [null, ...names]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(state.provider === name));
      b.textContent = name || 'Anyone';
      b.onclick = () => { state.provider = name; state.day = null; renderProviders(); renderDays(); renderSlots(); };
      wrap.append(b);
    }
  }

  function renderDays() {
    const byDay = new Map();
    for (const s of visible()) {
      const k = dayKey(new Date(s.start));
      byDay.set(k, (byDay.get(k) || 0) + (s.available ? 1 : 0));
    }
    const keys = [...byDay.keys()].sort();
    if (!state.day || !byDay.has(state.day)) state.day = keys.find((k) => byDay.get(k) > 0) || keys[0] || null;
    const wrap = $('days');
    wrap.innerHTML = '';
    for (const k of keys) {
      const d = new Date(`${k}T12:00:00`);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(k === state.day));
      b.disabled = byDay.get(k) === 0;
      b.innerHTML = `<small>${d.toLocaleDateString([], { weekday: 'short' })}</small><b>${d.getDate()}</b><small>${d.toLocaleDateString([], { month: 'short' })}</small>`;
      b.onclick = () => { state.day = k; renderDays(); renderSlots(); };
      wrap.append(b);
    }
  }

  function renderSlots() {
    const wrap = $('slots');
    wrap.innerHTML = '';
    const today = visible().filter((s) => dayKey(new Date(s.start)) === state.day);
    if (!today.length) {
      wrap.innerHTML = '<p class="empty">No times are open right now. Check back soon, or try another doctor.</p>';
      return;
    }
    const groups = new Map();
    for (const s of today) (groups.get(s.provider) || groups.set(s.provider, []).get(s.provider)).push(s);
    for (const [provider, list] of groups) {
      const open = list.filter((s) => s.available).length;
      const g = document.createElement('div');
      g.className = 'group';
      g.innerHTML = `<h3></h3><p>${open ? `${open} time${open === 1 ? '' : 's'} open` : 'Fully booked'} · ${fmtDay(list[0].start)}</p><div class="times"></div>`;
      g.querySelector('h3').textContent = provider;
      for (const s of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'time';
        b.textContent = fmtTime(s.start);
        b.disabled = !s.available;
        b.title = s.available ? '' : 'Already booked';
        b.setAttribute('aria-pressed', String(state.picked?.id === s.id));
        b.onclick = () => pick(s);
        g.querySelector('.times').append(b);
      }
      wrap.append(g);
    }
  }

  // ---- booking -----------------------------------------------------------
  function pick(slot) {
    state.picked = slot;
    state.idemKey = uuid();
    $('summary').innerHTML = '';
    $('summary').append(document.createTextNode(`${fmtTime(slot.start)}, ${fmtShort(slot.start)}`));
    const sub = document.createElement('span');
    sub.textContent = `with ${slot.provider}`;
    $('summary').append(sub);
    clearErrors();
    $('form').hidden = false;
    $('hint').hidden = true;
    renderSlots();
    if (window.matchMedia('(max-width: 820px)').matches) $('form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('name').focus({ preventScroll: true });
  }

  function clearErrors() {
    for (const id of ['name-err', 'email-err', 'form-err']) $(id).textContent = '';
    for (const id of ['name', 'email']) $(id).removeAttribute('aria-invalid');
  }

  function fieldError(field, msg) {
    $(`${field}-err`).textContent = msg;
    $(field).setAttribute('aria-invalid', 'true');
  }

  $('cancel-pick').onclick = () => {
    state.picked = null;
    $('form').hidden = true;
    $('hint').hidden = false;
    renderSlots();
  };

  // Same content keeps the same key, so a double click or a retry after a
  // dropped connection can never create two bookings. Editing the form starts
  // a new request.
  for (const id of ['name', 'email']) $(id).addEventListener('input', () => { state.idemKey = uuid(); });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    const name = $('name').value.trim();
    const email = $('email').value.trim();
    let bad = false;
    if (!name) { fieldError('name', 'Please enter your name.'); bad = true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { fieldError('email', 'Please enter a valid email, like you@example.com.'); bad = true; }
    if (bad) return;

    const btn = $('submit');
    btn.disabled = true;
    btn.textContent = 'Booking…';
    let r;
    try {
      r = await api('POST', '/bookings', {
        body: { slot_id: state.picked.id, name, email },
        headers: { 'Idempotency-Key': state.idemKey },
      });
    } catch {
      $('form-err').textContent = 'We couldn\'t reach the clinic. Check your connection and press Confirm again; you won\'t be booked twice.';
      btn.disabled = false;
      btn.textContent = 'Confirm booking';
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Confirm booking';

    if (r.status === 201) {
      remember(r.json.id, r.json.email);
      showTicket(r.json, state.picked);
      return;
    }
    if (r.status === 409 || r.status === 400 && /started/.test(r.json?.error || '')) {
      $('form-err').textContent = r.status === 409 ? 'Someone just took that time. Please pick another.' : 'That time has already passed. Please pick another.';
      state.picked = null;
      await loadSlots();
      return;
    }
    if (r.status === 429) {
      const s = Number(r.retryAfter) || 60;
      $('form-err').textContent = `Too many attempts for this email. Please try again in ${s} second${s === 1 ? '' : 's'}.`;
      return;
    }
    $('form-err').textContent = r.json?.error ? capitalise(r.json.error) + '.' : 'Something went wrong. Please try again.';
  });

  const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ---- confirmation ------------------------------------------------------
  function remember(id, email) {
    try {
      localStorage.setItem('last-booking', id);
      localStorage.setItem('last-email', email);
    } catch { /* private mode */ }
  }

  async function showTicket(booking, slot) {
    let s = slot;
    if (!s) {
      if (!state.slots.length) await loadSlots();
      s = state.slots.find((x) => x.id === booking.slot_id);
    }
    const cancelled = booking.status === 'cancelled';
    const t = $('ticket');
    t.innerHTML = `
      <p class="eyebrow">${cancelled ? 'Cancelled' : 'You\'re booked'}</p>
      <h2></h2>
      <dl>
        <dt>Doctor</dt><dd id="t-doc"></dd>
        <dt>Name</dt><dd id="t-name"></dd>
        <dt>Email</dt><dd id="t-email"></dd>
        <dt>Status</dt><dd><span class="badge ${cancelled ? 'cancelled' : ''}">${cancelled ? 'Cancelled' : 'Confirmed'}</span></dd>
        <dt>Reference</dt><dd class="ref" id="t-ref"></dd>
      </dl>
      <hr>
      <div class="ticket-actions">
        <span class="meta" style="color:var(--muted);font-size:14px">${cancelled ? 'This time is free for others again.' : 'Need to change plans?'}</span>
        ${cancelled ? '' : '<button class="link danger" id="cancel-booking" type="button">Cancel this booking</button>'}
      </div>`;
    t.querySelector('h2').textContent = s ? `${fmtTime(s.start)}, ${fmtDay(s.start)}` : 'Your appointment';
    $('t-doc').textContent = s ? s.provider : 'Booked slot ' + booking.slot_id;
    $('t-name').textContent = booking.name;
    $('t-email').textContent = booking.email;
    $('t-ref').textContent = booking.id;
    const cb = $('cancel-booking');
    if (cb) cb.onclick = async () => {
      if (!confirm('Cancel this appointment?')) return;
      const r = await api('DELETE', `/bookings/${encodeURIComponent(booking.id)}`);
      if (r.ok || r.status === 409) {
        const fresh = await api('GET', `/bookings/${encodeURIComponent(booking.id)}`);
        showTicket(fresh.json || r.json, s);
      }
    };
    history.replaceState(null, '', `#booking=${booking.id}`);
    show('done');
  }

  $('book-another').onclick = async () => {
    history.replaceState(null, '', location.pathname);
    state.picked = null;
    $('form').hidden = true;
    $('hint').hidden = false;
    $('form').reset();
    show('book');
    await loadSlots();
  };

  // ---- my bookings -------------------------------------------------------
  function openMine() {
    show('mine');
    let saved = '';
    try { saved = localStorage.getItem('last-email') || ''; } catch { /* ignore */ }
    if (saved && !$('mine-email').value) { $('mine-email').value = saved; findMine(); }
  }
  $('open-mine').onclick = openMine;
  $('open-mine-2').onclick = openMine;
  $('back').onclick = () => { show('book'); };

  $('mine-form').addEventListener('submit', (e) => { e.preventDefault(); findMine(); });

  async function findMine(more = false) {
    const email = more ? state.mine.email : $('mine-email').value.trim();
    $('mine-err').textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('mine-err').textContent = 'Please enter a valid email.'; return; }
    if (!more) { state.mine = { email, cursor: null }; $('mine-list').innerHTML = ''; }
    const q = `?email=${encodeURIComponent(email)}&limit=5${more && state.mine.cursor ? `&cursor=${encodeURIComponent(state.mine.cursor)}` : ''}`;
    const r = await api('GET', `/bookings${q}`);
    if (!r.ok) { $('mine-err').textContent = 'We couldn\'t load your bookings. Please try again.'; return; }
    if (!state.slots.length) await loadSlots();
    state.mine.cursor = r.json.next_cursor;
    $('more').hidden = !r.json.next_cursor;
    if (!more && !r.json.bookings.length) {
      $('mine-list').innerHTML = '<li><span class="meta">No bookings found for that email.</span></li>';
      return;
    }
    for (const b of r.json.bookings) {
      const s = state.slots.find((x) => x.id === b.slot_id);
      const li = document.createElement('li');
      li.innerHTML = '<div><div class="when"></div><div class="meta"></div></div><button class="link" type="button">View</button>';
      li.querySelector('.when').textContent = s ? `${fmtTime(s.start)}, ${fmtShort(s.start)}` : 'Appointment';
      li.querySelector('.meta').textContent = `${s ? s.provider + ' · ' : ''}${b.status === 'cancelled' ? 'Cancelled' : 'Confirmed'}`;
      li.querySelector('button').onclick = () => showTicket(b, s);
      $('mine-list').append(li);
    }
  }
  $('more').onclick = () => findMine(true);

  // ---- start -------------------------------------------------------------
  (async () => {
    await loadSlots();
    const m = location.hash.match(/^#booking=(.+)$/);
    if (m) {
      const r = await api('GET', `/bookings/${encodeURIComponent(m[1])}`);
      if (r.ok) showTicket(r.json);
    }
  })();
})();

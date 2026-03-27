// =============================================
//  Sea Cadets Portal — Application Logic
// =============================================

(function () {
  'use strict';

  // ---- Supabase client ----
  let sb = null;

  function initSupabase() {
    if (
      typeof SUPABASE_URL === 'undefined' ||
      SUPABASE_URL === 'YOUR_SUPABASE_URL' ||
      typeof SUPABASE_ANON === 'undefined' ||
      SUPABASE_ANON === 'YOUR_SUPABASE_ANON_KEY'
    ) {
      document.getElementById('setup-banner').classList.remove('hidden');
      return false;
    }
    const { createClient } = supabase;
    sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
      realtime: { params: { eventsPerSecond: 10 } }
    });
    return true;
  }

  // ---- State ----
  let currentView = 'parent';
  let formFields = [];            // form builder state
  let editingEventId = null;      // null = creating new
  let deleteTargetId = null;
  let currentSubmissionsEvent = null;
  let realtimeChannel = null;
  let xoEventsCache = [];
  let parentEventsCache = [];

  // =============================================
  //  VIEW SWITCHING
  // =============================================

  function showParentView() {
    currentView = 'parent';
    document.getElementById('view-parent').classList.remove('hidden');
    document.getElementById('view-xo').classList.add('hidden');
    document.getElementById('btn-parent-view').classList.add('bg-white/20');
    document.getElementById('btn-xo-view').classList.remove('bg-white/20');
    loadParentEvents();
  }

  function showXOView() {
    currentView = 'xo';
    document.getElementById('view-parent').classList.add('hidden');
    document.getElementById('view-xo').classList.remove('hidden');
    document.getElementById('btn-xo-view').classList.add('bg-white/20');
    document.getElementById('btn-parent-view').classList.remove('bg-white/20');
    checkAuth();
  }

  function checkAuth() {
    if (sessionStorage.getItem('xo_authenticated') === 'true') {
      showDashboard();
    } else {
      showLoginForm();
    }
  }

  function showLoginForm() {
    document.getElementById('xo-login').classList.remove('hidden');
    document.getElementById('xo-dashboard').classList.add('hidden');
    document.getElementById('btn-logout').classList.add('hidden');
  }

  function showDashboard() {
    document.getElementById('xo-login').classList.add('hidden');
    document.getElementById('xo-dashboard').classList.remove('hidden');
    document.getElementById('btn-logout').classList.remove('hidden');
    loadXOEvents();
    loadStats();
  }

  // =============================================
  //  AUTHENTICATION
  // =============================================

  function login(e) {
    e.preventDefault();
    const password = document.getElementById('login-password').value;
    const errEl    = document.getElementById('login-error');
    errEl.classList.add('hidden');

    if (typeof XO_PASSWORD !== 'undefined' && password === XO_PASSWORD) {
      sessionStorage.setItem('xo_authenticated', 'true');
      showDashboard();
    } else {
      errEl.textContent = 'Incorrect password. Please try again.';
      errEl.classList.remove('hidden');
    }
  }

  function logout() {
    sessionStorage.removeItem('xo_authenticated');
    document.getElementById('login-password').value = '';
    showLoginForm();
    showParentView();
  }

  // =============================================
  //  PARENT: LOAD EVENTS
  // =============================================

  async function loadParentEvents() {
    const listEl    = document.getElementById('events-list');
    const loadEl    = document.getElementById('events-loading');
    const emptyEl   = document.getElementById('events-empty');

    if (!sb) {
      loadEl.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      emptyEl.textContent = 'Portal not yet configured. Ask your XO to set up Supabase.';
      return;
    }

    loadEl.classList.remove('hidden');
    listEl.innerHTML = '';
    emptyEl.classList.add('hidden');

    const { data, error } = await sb
      .from('events')
      .select('*')
      .eq('is_open', true)
      .order('event_date', { ascending: true });

    loadEl.classList.add('hidden');

    if (error) {
      emptyEl.textContent = 'Could not load events. Please try again later.';
      emptyEl.classList.remove('hidden');
      return;
    }

    // Filter out events where the event date (or end date) has passed
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    parentEventsCache = (data || []).filter(ev => {
      // Use the end date if it exists, otherwise the start date
      const effectiveDate = ev.event_date_end ? new Date(ev.event_date_end) : new Date(ev.event_date);
      effectiveDate.setHours(23, 59, 59, 999); // include the full day
      return effectiveDate >= today;
    });

    if (parentEventsCache.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }

    // Fetch submission counts for events with max_attendees
    const cappedIds = parentEventsCache.filter(e => e.max_attendees).map(e => e.id);
    if (cappedIds.length > 0) {
      const { data: subs } = await sb.from('submissions').select('event_id').in('event_id', cappedIds);
      const counts = {};
      (subs || []).forEach(s => { counts[s.event_id] = (counts[s.event_id] || 0) + 1; });
      parentEventsCache.forEach(ev => { if (ev.max_attendees) ev._signupCount = counts[ev.id] || 0; });
    }

    parentEventsCache.forEach(ev => {
      listEl.appendChild(buildEventCard(ev));
    });

    // Subscribe to real-time inserts
    subscribeToEvents();
  }

  function subscribeToEvents() {
    if (realtimeChannel) {
      sb.removeChannel(realtimeChannel);
    }
    realtimeChannel = sb
      .channel('public-events')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'events',
        filter: 'is_open=eq.true'
      }, payload => {
        const ev = payload.new;
        const now = new Date();
        if (new Date(ev.event_date) >= now) {
          prependEventCard(ev);
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'events'
      }, () => {
        // Reload on update
        loadParentEvents();
      })
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'events'
      }, payload => {
        const card = document.querySelector(`[data-event-id="${payload.old.id}"]`);
        if (card) card.remove();
        checkParentEmpty();
      })
      .subscribe();
  }

  function checkParentEmpty() {
    const listEl  = document.getElementById('events-list');
    const emptyEl = document.getElementById('events-empty');
    if (listEl.children.length === 0) {
      emptyEl.classList.remove('hidden');
    }
  }

  function prependEventCard(ev) {
    const listEl  = document.getElementById('events-list');
    const emptyEl = document.getElementById('events-empty');
    emptyEl.classList.add('hidden');
    const card = buildEventCard(ev);
    card.classList.add('new-event-pulse');
    // Insert in date order
    const cards = Array.from(listEl.querySelectorAll('.event-card'));
    const insertBefore = cards.find(c => {
      const d = c.dataset.eventDate;
      return d && d > ev.event_date;
    });
    if (insertBefore) {
      listEl.insertBefore(card, insertBefore);
    } else {
      listEl.appendChild(card);
    }
  }

  function isApplicationsClosed(ev) {
    if (!ev.closing_date) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const closing = new Date(ev.closing_date + 'T23:59:59');
    return today > closing;
  }

  function buildEventCard(ev) {
    const div = document.createElement('div');
    div.className = 'event-card fade-in';
    div.dataset.eventId = ev.id;
    div.dataset.eventDate = ev.event_date;
    const closed = isApplicationsClosed(ev);
    const isFull = ev.max_attendees && (ev._signupCount || 0) >= ev.max_attendees;
    if (!closed && !isFull) {
      div.onclick = () => openEventModal(ev.id);
    }

    const dayStr  = formatDay(ev.event_date);

    // Build closing date line
    let closingHtml = '';
    if (ev.closing_date) {
      if (closed) {
        closingHtml = `<p class="text-red-400 text-xs mt-2 font-semibold">⚠ Applications closed</p>`;
      } else {
        closingHtml = `<p class="text-gray-400 text-xs mt-2">Applications close: ${formatDate(ev.closing_date + 'T00:00:00')}</p>`;
      }
    }

    div.innerHTML = `
      <div class="event-card-header">
        <div class="event-card-badge">${dayStr}${ev.event_date_end ? ' — ' + formatDay(ev.event_date_end) : ''}</div>
        ${formatTimeRange(ev.from_time, ev.to_time) ? `<p class="text-white/60 text-xs mt-1 flex items-center gap-1"><svg class="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>${formatTimeRange(ev.from_time, ev.to_time)}</p>` : ''}
        <h3 class="text-xl font-bold leading-snug tracking-wide" style="font-family:'Source Sans 3',sans-serif; font-size:1.35rem;">${escHtml(ev.title)}</h3>
        ${ev.location ? `<p class="text-white/70 text-sm mt-1 flex items-center gap-1">
          <svg class="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
          ${escHtml(ev.location)}</p>` : ''}
        ${(ev.open_to_juniors !== false || ev.open_to_seniors !== false) ? `<div class="flex gap-1.5 mt-2 flex-wrap">${ev.open_to_juniors !== false ? '<span style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);padding:2px 8px;border-radius:4px;font-size:0.7rem;font-weight:600;letter-spacing:0.03em;color:#fff;">Juniors</span>' : ''}${ev.open_to_seniors !== false ? '<span style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);padding:2px 8px;border-radius:4px;font-size:0.7rem;font-weight:600;letter-spacing:0.03em;color:#fff;">Seniors</span>' : ''}</div>` : ''}
      </div>
      <div class="event-card-body">
        ${ev.description ? `<p class="text-gray-700 text-sm line-clamp-2">${escHtml(ev.description)}</p>` : ''}
        ${ev.max_attendees ? `<p class="text-xs mt-1 ${isFull ? 'text-red-500 font-semibold' : 'text-gray-500'}">
          ${isFull ? '⚠ Fully booked' : `${ev._signupCount || 0} / ${ev.max_attendees} places taken`}
        </p>` : ''}
        ${closed
          ? `<p class="mt-3 text-sm font-semibold text-gray-400">Applications closed</p>`
          : isFull
            ? `<p class="mt-3 text-sm font-semibold text-gray-400">Fully booked</p>`
            : `<button class="btn-signup">Sign Up <span class="arrow">→</span></button>`
        }
        ${closingHtml}
      </div>
    `;
    return div;
  }

  // =============================================
  //  PARENT: EVENT MODAL + SIGN-UP FORM
  // =============================================

  async function openEventModal(eventId) {
    if (!sb) return;
    const { data: ev } = await sb.from('events').select('*').eq('id', eventId).single();
    if (!ev) return;

    document.getElementById('modal-event-title').textContent = ev.title;

    const dateSpan = document.getElementById('modal-event-date');
    const _timeStr = formatTimeRange(ev.from_time, ev.to_time);
    dateSpan.innerHTML = `<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 4h10M5 11h14M5 19h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg> ${formatDateRangeLong(ev.event_date, ev.event_date_end)}${_timeStr ? ' · ' + _timeStr : ''}`;

    const locSpan = document.getElementById('modal-event-location');
    if (ev.location) {
      locSpan.innerHTML = `<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg> ${escHtml(ev.location)}`;
      locSpan.style.display = '';
    } else {
      locSpan.style.display = 'none';
    }

    document.getElementById('modal-event-desc').textContent = ev.description || '';

    // Build dynamic form
    const fieldsContainer = document.getElementById('modal-form-fields');
    fieldsContainer.innerHTML = '';
    document.getElementById('modal-form-success').classList.add('hidden');
    document.getElementById('modal-form-container').classList.remove('hidden');
    document.getElementById('modal-form-error').classList.add('hidden');

    // Check if applications are closed
    if (isApplicationsClosed(ev)) {
      document.getElementById('modal-form-container').classList.add('hidden');
      fieldsContainer.innerHTML = '';
      const closedMsg = document.createElement('div');
      closedMsg.className = 'text-center py-6';
      closedMsg.innerHTML = `
        <p class="text-gray-500 font-semibold">Applications for this event are now closed.</p>
        <p class="text-gray-400 text-sm mt-1">The closing date was ${formatDate(ev.closing_date + 'T00:00:00')}.</p>
      `;
      fieldsContainer.parentElement.insertBefore(closedMsg, fieldsContainer);
      openModal('modal-event');
      return;
    }

    const schema = ev.form_fields || [];
    if (schema.length === 0) {
      fieldsContainer.innerHTML = '<p class="text-sm text-gray-500 italic">No form fields — just click Submit to sign up.</p>';
    } else {
      schema.forEach(field => {
        fieldsContainer.appendChild(renderFormField(field));
      });
    }

    // Store event id for submission
    document.getElementById('modal-signup-form').dataset.eventId = eventId;

    openModal('modal-event');
  }

  function renderFormField(field) {
    const wrapper = document.createElement('div');
    const labelHtml = `<label class="block text-sm font-medium text-gray-700 mb-1">
      ${escHtml(field.label)}${field.required ? ' <span class="text-red-500">*</span>' : ''}
    </label>`;

    let inputHtml = '';
    const baseClass = 'w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy';

    switch (field.type) {
      case 'textarea':
        inputHtml = `<textarea name="${field.id}" ${field.required ? 'required' : ''} rows="3"
          placeholder="${escHtml(field.placeholder || '')}"
          class="${baseClass} resize-none"></textarea>`;
        break;
      case 'checkbox':
        inputHtml = `<select name="${field.id}" ${field.required ? 'required' : ''} class="${baseClass}">
          <option value="">— Select —</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>`;
        break;
      case 'dropdown':
        const opts = (field.options || '').split('\n').filter(o => o.trim());
        inputHtml = `<select name="${field.id}" ${field.required ? 'required' : ''} class="${baseClass}">
          <option value="">— Select —</option>
          ${opts.map(o => `<option value="${escHtml(o.trim())}">${escHtml(o.trim())}</option>`).join('')}
        </select>`;
        break;
      default:
        inputHtml = `<input type="${field.type}" name="${field.id}" ${field.required ? 'required' : ''}
          placeholder="${escHtml(field.placeholder || '')}"
          class="${baseClass}" />`;
    }
    wrapper.innerHTML = labelHtml + inputHtml;
    return wrapper;
  }

  async function submitSignup(e) {
    e.preventDefault();
    if (!sb) return;

    const form    = e.target;
    const eventId = form.dataset.eventId;
    const errEl   = document.getElementById('modal-form-error');
    errEl.classList.add('hidden');

    // Collect form data
    const formData = new FormData(form);
    const data = {};
    for (const [key, val] of formData.entries()) {
      data[key] = val;
    }
    // Handle checkboxes (unchecked don't appear in FormData)
    form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      data[cb.name] = cb.checked ? 'Yes' : 'No';
    });

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    // Check max attendees limit before submitting
    if (!isManualEntry) {
      const ev = parentEventsCache.find(e => e.id === eventId);
      if (ev && ev.max_attendees) {
        const { count } = await sb.from('submissions').select('*', { count: 'exact', head: true }).eq('event_id', eventId);
        if (count >= ev.max_attendees) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit';
          errEl.textContent = 'Sorry, this event is now fully booked.';
          errEl.classList.remove('hidden');
          return;
        }
      }
    }

    const { error } = await sb.from('submissions').insert({
      event_id: eventId,
      form_data: data,
      submitted_at: new Date().toISOString()
    });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit';

    if (error) {
      errEl.textContent = 'Failed to submit. Please try again.';
      errEl.classList.remove('hidden');
    } else if (isManualEntry) {
      // Return to submissions view after manual entry
      isManualEntry = false;
      closeModal('modal-event');
      openSubmissions(eventId);
    } else {
      document.getElementById('modal-form-container').classList.add('hidden');
      document.getElementById('modal-form-success').classList.remove('hidden');
    }
  }

  // =============================================
  //  XO: LOAD EVENTS TABLE
  // =============================================

  let currentXoTab = 'upcoming';

  function filterXoTab(tab) {
    currentXoTab = tab;
    // Update tab button styles
    document.querySelectorAll('.xo-tab').forEach(btn => {
      btn.classList.remove('bg-navy', 'text-white');
      btn.classList.add('text-gray-500', 'hover:bg-gray-100');
    });
    const active = document.getElementById('xo-tab-' + tab);
    if (active) {
      active.classList.add('bg-navy', 'text-white');
      active.classList.remove('text-gray-500', 'hover:bg-gray-100');
    }
    // Filter rows
    const tbody = document.getElementById('xo-events-tbody');
    const rows = tbody.querySelectorAll('tr[data-event-past]');
    let visible = 0;
    rows.forEach(tr => {
      const isPast = tr.getAttribute('data-event-past') === 'true';
      let show = tab === 'all' || (tab === 'upcoming' && !isPast) || (tab === 'past' && isPast);
      tr.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    const emptyEl = document.getElementById('xo-events-empty');
    const tableEl = document.getElementById('xo-events-table');
    if (visible === 0 && rows.length > 0) {
      emptyEl.textContent = tab === 'upcoming' ? 'No upcoming events.' : tab === 'past' ? 'No past events.' : 'No events yet.';
      emptyEl.classList.remove('hidden');
      tableEl.classList.add('hidden');
    } else {
      emptyEl.classList.add('hidden');
      if (rows.length > 0) tableEl.classList.remove('hidden');
    }
  }

  async function loadXOEvents() {
    if (!sb) return;
    const loadEl  = document.getElementById('xo-events-loading');
    const emptyEl = document.getElementById('xo-events-empty');
    const tableEl = document.getElementById('xo-events-table');
    const tbody   = document.getElementById('xo-events-tbody');

    loadEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    tableEl.classList.add('hidden');
    tbody.innerHTML = '';

    const { data, error } = await sb
      .from('events')
      .select('id, title, event_date, event_date_end, closing_date, from_time, to_time, location, description, form_fields, is_open, open_to_juniors, open_to_seniors, max_attendees')
      .order('event_date', { ascending: true });

    loadEl.classList.add('hidden');
    if (error || !data) { emptyEl.classList.remove('hidden'); return; }

    xoEventsCache = data;

    if (data.length === 0) { emptyEl.textContent = 'No events yet. Create your first one!'; emptyEl.classList.remove('hidden'); return; }

    // Count submissions per event
    const ids = data.map(e => e.id);
    const { data: subCounts } = await sb
      .from('submissions')
      .select('event_id')
      .in('event_id', ids);

    const countMap = {};
    (subCounts || []).forEach(s => {
      countMap[s.event_id] = (countMap[s.event_id] || 0) + 1;
    });

    data.forEach(ev => {
      const tr = document.createElement('tr');
      const endDate = ev.event_date_end || ev.event_date;
      const isPast = new Date(endDate) < new Date(new Date().toDateString());
      tr.setAttribute('data-event-past', isPast ? 'true' : 'false');
      tr.innerHTML = `
        <td class="px-6 py-4" data-label="Event">
          <div class="font-medium text-gray-800">${escHtml(ev.title)}</div>
          ${!ev.is_open ? '<span class="text-xs text-gray-400">(hidden)</span>' : ''}
          ${isPast ? '<span class="text-xs text-amber-500">(past)</span>' : ''}
        </td>
        <td class="px-6 py-4 text-gray-600" data-label="Date">${formatDateRange(ev.event_date, ev.event_date_end)}</td>
        <td class="px-6 py-4 text-gray-600" data-label="Location">${escHtml(ev.location || '—')}</td>
        <td class="px-6 py-4 text-gray-600" data-label="Closing Date">${ev.closing_date ? formatDate(ev.closing_date + 'T00:00:00') : '—'}</td>
        <td class="px-6 py-4 text-gray-600" data-label="Open To">${[ev.open_to_juniors !== false ? 'Juniors' : '', ev.open_to_seniors !== false ? 'Seniors' : ''].filter(Boolean).join(', ') || '—'}</td>
        <td class="px-6 py-4 text-center" data-label="Sign-ups">
          <button onclick="App.openSubmissions('${ev.id}')"
            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold
              ${(countMap[ev.id] || 0) > 0 ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}
              transition">
            ${countMap[ev.id] || 0}${ev.max_attendees ? ' / ' + ev.max_attendees : ''} sign-up${(countMap[ev.id] || 0) !== 1 ? 's' : ''}
          </button>
        </td>
        <td class="px-6 py-4 text-right" data-label="Actions">
          <div class="flex items-center justify-end gap-2">
            <button onclick="App.openEditEvent('${ev.id}')"
              class="p-1.5 text-gray-400 hover:text-navy hover:bg-blue-50 rounded-lg transition" title="Edit">
              <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.172-8.172z"/>
              </svg>
            </button>
            <button onclick="App.promptDelete('${ev.id}')"
              class="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition" title="Delete">
              <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tableEl.classList.remove('hidden');
    // Apply current tab filter
    filterXoTab(currentXoTab);
  }

  async function loadStats() {
    if (!sb) return;
    const now = new Date().toISOString();
    const { data: allEvents  } = await sb.from('events').select('id, event_date');
    const { data: allSubs    } = await sb.from('submissions').select('id');

    const total    = (allEvents || []).length;
    const upcoming = (allEvents || []).filter(e => e.event_date >= now).length;
    const subs     = (allSubs   || []).length;

    document.getElementById('stat-total').textContent    = total;
    document.getElementById('stat-upcoming').textContent = upcoming;
    document.getElementById('stat-signups').textContent  = subs;
  }

  // =============================================
  //  XO: CREATE / EDIT EVENT
  // =============================================

  function openCreateEvent() {
    editingEventId = null;
    // Pre-load Cadet Name as a default required field
    const cadetNameId = 'field_cadet_name';
    formFields = [{
      id: cadetNameId, type: 'text', label: 'Cadet Name',
      placeholder: 'Enter cadet\'s full name', required: true, options: ''
    }];
    document.getElementById('create-event-title').textContent = 'New Event';
    document.getElementById('save-event-btn').textContent     = 'Create Event';
    document.getElementById('ce-title').value        = '';
    document.getElementById('ce-date').value         = '';
    document.getElementById('ce-date-end').value     = '';
    document.getElementById('ce-closing-date').value = '';
    document.getElementById('ce-from-time').value    = '';
    document.getElementById('ce-to-time').value      = '';
    document.getElementById('ce-location').value     = '';
    document.getElementById('ce-description').value  = '';
    document.getElementById('ce-juniors').checked = true;
    document.getElementById('ce-seniors').checked = true;
    document.getElementById('ce-max-attendees').value = '';
    document.getElementById('create-event-error').classList.add('hidden');
    renderFormBuilder();
    openModal('modal-create-event');
  }

  async function openEditEvent(eventId) {
    if (!sb) return;
    const { data: ev } = await sb.from('events').select('*').eq('id', eventId).single();
    if (!ev) return;

    editingEventId = eventId;
    formFields = (ev.form_fields || []).map(f => ({ ...f }));

    document.getElementById('create-event-title').textContent = 'Edit Event';
    document.getElementById('save-event-btn').textContent     = 'Save Changes';
    document.getElementById('ce-title').value       = ev.title || '';
    document.getElementById('ce-location').value    = ev.location || '';
    document.getElementById('ce-description').value = ev.description || '';
    document.getElementById('create-event-error').classList.add('hidden');

    // Set date fields (date only, no time)
    document.getElementById('ce-date').value = ev.event_date ? ev.event_date.slice(0, 10) : '';
    document.getElementById('ce-date-end').value = ev.event_date_end ? ev.event_date_end.slice(0, 10) : '';
    document.getElementById('ce-closing-date').value = ev.closing_date || '';
    document.getElementById('ce-from-time').value = ev.from_time || '';
    document.getElementById('ce-to-time').value = ev.to_time || '';
    document.getElementById('ce-juniors').checked = ev.open_to_juniors !== false;
    document.getElementById('ce-seniors').checked = ev.open_to_seniors !== false;
    document.getElementById('ce-max-attendees').value = ev.max_attendees || '';

    renderFormBuilder();
    openModal('modal-create-event');
  }

  async function saveEvent(e) {
    e.preventDefault();
    if (!sb) return;

    const btn    = document.getElementById('save-event-btn');
    const errEl  = document.getElementById('create-event-error');
    errEl.classList.add('hidden');

    const fromDate    = document.getElementById('ce-date').value;
    const toDate      = document.getElementById('ce-date-end').value;
    const closingDate = document.getElementById('ce-closing-date').value;
    const fromTime    = document.getElementById('ce-from-time').value;
    const toTime      = document.getElementById('ce-to-time').value;
    const payload = {
      title:          document.getElementById('ce-title').value.trim(),
      event_date:     fromDate    ? new Date(fromDate + 'T00:00:00').toISOString() : null,
      event_date_end: toDate      ? new Date(toDate   + 'T00:00:00').toISOString() : null,
      closing_date:   closingDate || null,
      from_time:      fromTime || null,
      to_time:        toTime || null,
      location:       document.getElementById('ce-location').value.trim() || null,
      description:    document.getElementById('ce-description').value.trim() || null,
      open_to_juniors: document.getElementById('ce-juniors').checked,
      open_to_seniors: document.getElementById('ce-seniors').checked,
      max_attendees:  parseInt(document.getElementById('ce-max-attendees').value) || null,
      form_fields:    formFields,
      is_open:      true
    };

    btn.disabled = true;
    btn.textContent = 'Saving…';

    let error;
    if (editingEventId) {
      ({ error } = await sb.from('events').update(payload).eq('id', editingEventId));
    } else {
      ({ error } = await sb.from('events').insert(payload));
    }

    btn.disabled = false;
    btn.textContent = editingEventId ? 'Save Changes' : 'Create Event';

    if (error) {
      errEl.textContent = error.message;
      errEl.classList.remove('hidden');
    } else {
      closeModal('modal-create-event');
      loadXOEvents();
      loadStats();
    }
  }

  // =============================================
  //  FORM BUILDER
  // =============================================

  let fieldIdCounter = 0;

  function addFormField(type) {
    document.getElementById('field-type-menu').classList.add('hidden');
    const id = 'field_' + (++fieldIdCounter) + '_' + Date.now();
    const defaults = {
      text:      { label: 'Short Text',    placeholder: '', required: false, options: '' },
      textarea:  { label: 'Long Text',     placeholder: '', required: false, options: '' },
      number:    { label: 'Number',        placeholder: '', required: false, options: '' },
      email:     { label: 'Email Address', placeholder: '', required: false, options: '' },
      tel:       { label: 'Phone Number',  placeholder: '', required: false, options: '' },
      date:      { label: 'Date',          placeholder: '', required: false, options: '' },
      checkbox:  { label: 'Checkbox',      placeholder: '', required: false, options: '' },
      dropdown:  { label: 'Dropdown',      placeholder: '', required: false, options: 'Option 1\nOption 2\nOption 3' },
    };
    formFields.push({ id, type, ...defaults[type] });
    renderFormBuilder();
  }

  function removeFormField(fieldId) {
    formFields = formFields.filter(f => f.id !== fieldId);
    renderFormBuilder();
  }

  function updateField(fieldId, key, value) {
    const field = formFields.find(f => f.id === fieldId);
    if (field) field[key] = value;
  }

  function renderFormBuilder() {
    const container = document.getElementById('form-builder-fields');
    container.innerHTML = '';

    if (formFields.length === 0) {
      const emptyP = document.createElement('p');
      emptyP.id = 'form-builder-empty';
      emptyP.className = 'text-center text-sm text-gray-400 py-4';
      emptyP.textContent = 'No fields added yet. Use "Add Field" to build your sign-up form.';
      container.appendChild(emptyP);
      return;
    }

    formFields.forEach((field, index) => {
      const card = document.createElement('div');
      card.className = 'field-card';
      card.draggable = true;
      card.dataset.fieldId = field.id;

      const typeLabel = {
        text: 'Short Text', textarea: 'Long Text', number: 'Number',
        email: 'Email', tel: 'Phone', date: 'Date',
        checkbox: 'Yes / No', dropdown: 'Dropdown'
      }[field.type] || field.type;

      card.innerHTML = `
        <div class="flex items-start gap-3">
          <div class="field-card-handle mt-1 select-none" title="Drag to reorder">
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"/>
            </svg>
          </div>
          <div class="flex-1 space-y-2">
            <div class="flex items-center gap-2">
              <span class="text-xs font-semibold uppercase tracking-wide text-gray-400 bg-gray-200 px-2 py-0.5 rounded-full">${typeLabel}</span>
            </div>
            <input type="text" value="${escHtml(field.label)}"
              oninput="App.updateField('${field.id}','label',this.value)"
              placeholder="Field label"
              class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy" />
            ${field.type !== 'checkbox' && field.type !== 'dropdown' && field.type !== 'date' ? `
            <input type="text" value="${escHtml(field.placeholder || '')}"
              oninput="App.updateField('${field.id}','placeholder',this.value)"
              placeholder="Placeholder text (optional)"
              class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy" />
            ` : ''}
            ${field.type === 'dropdown' ? `
            <textarea
              oninput="App.updateField('${field.id}','options',this.value)"
              placeholder="One option per line"
              rows="3"
              class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy resize-none">${escHtml(field.options || '')}</textarea>
            ` : ''}
            <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input type="checkbox" ${field.required ? 'checked' : ''}
                onchange="App.updateField('${field.id}','required',this.checked)"
                class="h-4 w-4 rounded border-gray-300 text-navy focus:ring-navy" />
              Required field
            </label>
          </div>
          <button type="button" onclick="App.removeFormField('${field.id}')"
            class="text-gray-300 hover:text-red-500 transition mt-0.5" title="Remove field">
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      `;

      // Drag-and-drop reordering
      card.addEventListener('dragstart', onDragStart);
      card.addEventListener('dragover',  onDragOver);
      card.addEventListener('dragleave', onDragLeave);
      card.addEventListener('drop',      onDrop);
      card.addEventListener('dragend',   onDragEnd);

      container.appendChild(card);
    });
  }

  // ---- Drag & Drop state ----
  let dragSrcId = null;

  function onDragStart(e) {
    dragSrcId = e.currentTarget.dataset.fieldId;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
  }
  function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
  function onDragEnd(e)   { e.currentTarget.classList.remove('dragging'); }
  function onDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const targetId = e.currentTarget.dataset.fieldId;
    if (!dragSrcId || dragSrcId === targetId) return;
    const srcIdx = formFields.findIndex(f => f.id === dragSrcId);
    const tgtIdx = formFields.findIndex(f => f.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;
    const [moved] = formFields.splice(srcIdx, 1);
    formFields.splice(tgtIdx, 0, moved);
    renderFormBuilder();
    dragSrcId = null;
  }

  function toggleFieldMenu() {
    document.getElementById('field-type-menu').classList.toggle('hidden');
  }

  // Close menu on outside click
  document.addEventListener('click', (e) => {
    const btn  = document.getElementById('add-field-btn');
    const menu = document.getElementById('field-type-menu');
    if (btn && menu && !btn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });

  // =============================================
  //  XO: MANUAL ENTRY
  // =============================================

  let isManualEntry = false;

  async function manualEntry() {
    if (!sb || !currentSubmissionsEvent) return;
    const eventId = currentSubmissionsEvent;
    const ev = xoEventsCache.find(e => e.id === eventId);
    if (!ev) return;

    isManualEntry = true;
    closeModal('modal-submissions');

    // Reuse the sign-up modal but bypass closing date check
    document.getElementById('modal-event-title').textContent = ev.title + ' — Manual Entry';

    const dateSpan = document.getElementById('modal-event-date');
    const _meTimeStr = formatTimeRange(ev.from_time, ev.to_time);
    dateSpan.innerHTML = `<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 4h10M5 11h14M5 19h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg> ${formatDateRangeLong(ev.event_date, ev.event_date_end)}${_meTimeStr ? ' · ' + _meTimeStr : ''}`;

    const locSpan = document.getElementById('modal-event-location');
    if (ev.location) {
      locSpan.innerHTML = `<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg> ${escHtml(ev.location)}`;
      locSpan.style.display = '';
    } else {
      locSpan.style.display = 'none';
    }

    document.getElementById('modal-event-desc').textContent = ev.description || '';

    const fieldsContainer = document.getElementById('modal-form-fields');
    fieldsContainer.innerHTML = '';
    document.getElementById('modal-form-success').classList.add('hidden');
    document.getElementById('modal-form-container').classList.remove('hidden');
    document.getElementById('modal-form-error').classList.add('hidden');

    // Remove any previous closed message
    const prevClosed = fieldsContainer.parentElement.querySelector('.manual-closed-msg');
    if (prevClosed) prevClosed.remove();

    const schema = ev.form_fields || [];
    if (schema.length === 0) {
      fieldsContainer.innerHTML = '<p class="text-sm text-gray-500 italic">No form fields — just click Submit to sign up.</p>';
    } else {
      schema.forEach(field => {
        fieldsContainer.appendChild(renderFormField(field));
      });
    }

    document.getElementById('modal-signup-form').dataset.eventId = eventId;
    openModal('modal-event');
  }

  // =============================================
  //  XO: SUBMISSIONS
  // =============================================

  async function openSubmissions(eventId) {
    if (!sb) return;
    const ev = xoEventsCache.find(e => e.id === eventId);
    document.getElementById('subs-event-title').textContent = ev ? ev.title : 'Event';
    currentSubmissionsEvent = eventId;

    const loadEl    = document.getElementById('subs-loading');
    const emptyEl   = document.getElementById('subs-empty');
    const tableWrap = document.getElementById('subs-table-wrap');
    const thead     = document.getElementById('subs-thead');
    const tbody     = document.getElementById('subs-tbody');

    loadEl.style.display = '';
    emptyEl.classList.add('hidden');
    tableWrap.classList.add('hidden');

    openModal('modal-submissions');

    const { data: subs } = await sb
      .from('submissions')
      .select('*')
      .eq('event_id', eventId)
      .order('submitted_at', { ascending: false });

    loadEl.style.display = 'none';

    if (!subs || subs.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }

    // Build column headers from first submission
    const allKeys = new Set();
    subs.forEach(s => Object.keys(s.form_data || {}).forEach(k => allKeys.add(k)));
    const keys = Array.from(allKeys);

    // Get field labels from event schema for nicer headers
    let labelMap = {};
    const { data: evFull } = await sb.from('events').select('form_fields').eq('id', eventId).single();
    if (evFull && evFull.form_fields) {
      evFull.form_fields.forEach(f => { labelMap[f.id] = f.label; });
    }

    thead.innerHTML = `<tr>
      <th class="px-4 py-3 text-left">#</th>
      ${keys.map(k => `<th class="px-4 py-3 text-left">${escHtml(labelMap[k] || k)}</th>`).join('')}
      <th class="px-4 py-3 text-left">Submitted</th>
      <th class="px-4 py-3 text-center w-10"></th>
    </tr>`;

    tbody.innerHTML = '';
    subs.forEach((sub, i) => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-gray-50';
      tr.innerHTML = `
        <td class="px-4 py-3 text-gray-400 text-xs">${i + 1}</td>
        ${keys.map(k => `<td class="px-4 py-3 text-gray-700 text-sm">${escHtml(sub.form_data[k] ?? '—')}</td>`).join('')}
        <td class="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">${formatDateLong(sub.submitted_at)}</td>
        <td class="px-4 py-3 text-center">
          <button onclick="App.deleteSubmission('${sub.id}')" title="Delete sign-up"
            class="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition">
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tableWrap.classList.remove('hidden');

    // Store for export
    tableWrap.dataset.keys = JSON.stringify(keys);
    tableWrap.dataset.subs = JSON.stringify(subs);
    tableWrap.dataset.labelMap = JSON.stringify(labelMap);
  }

  async function deleteSubmission(subId) {
    if (!confirm('Delete this sign-up? This cannot be undone.')) return;
    const { error } = await sb.from('submissions').delete().eq('id', subId);
    if (error) { alert('Failed to delete: ' + error.message); return; }
    // Refresh the submissions view
    if (currentSubmissionsEvent) openSubmissions(currentSubmissionsEvent);
  }

  function exportSubmissions() {
    const tableWrap = document.getElementById('subs-table-wrap');
    const keys      = JSON.parse(tableWrap.dataset.keys || '[]');
    const subs      = JSON.parse(tableWrap.dataset.subs || '[]');
    const labelMap  = JSON.parse(tableWrap.dataset.labelMap || '{}');

    const headers = [...keys.map(k => labelMap[k] || k), 'Submitted At'];
    const rows    = subs.map(s => [
      ...keys.map(k => `"${(s.form_data[k] || '').toString().replace(/"/g, '""')}"`),
      `"${formatDateLong(s.submitted_at)}"`
    ]);

    const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `signups-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // =============================================
  //  XO: DELETE
  // =============================================

  function promptDelete(eventId) {
    deleteTargetId = eventId;
    openModal('modal-delete');
  }

  async function confirmDelete() {
    if (!sb || !deleteTargetId) return;
    const btn = document.getElementById('confirm-delete-btn');
    btn.disabled = true;
    btn.textContent = 'Deleting…';

    const { error } = await sb.from('events').delete().eq('id', deleteTargetId);

    btn.disabled = false;
    btn.textContent = 'Delete';

    if (!error) {
      closeModal('modal-delete');
      deleteTargetId = null;
      loadXOEvents();
      loadStats();
    }
  }

  // =============================================
  //  MODAL HELPERS
  // =============================================

  function openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
  function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

  // Close modals on backdrop click
  document.querySelectorAll('[id^="modal-"]').forEach(modal => {
    modal.addEventListener('click', function (e) {
      if (e.target === this) closeModal(this.id);
    });
  });

  // Escape key closes modals
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('[id^="modal-"]').forEach(m => m.classList.add('hidden'));
    }
  });

  // =============================================
  //  DATE HELPERS
  // =============================================

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    });
  }
  function formatDateLong(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  }
  function formatDay(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function formatDateRange(fromIso, toIso) {
    const from = formatDate(fromIso);
    if (!toIso) return from;
    const to = formatDate(toIso);
    return from + ' — ' + to;
  }
  function formatDateRangeLong(fromIso, toIso) {
    const from = formatDateLong(fromIso);
    if (!toIso) return from;
    const to = formatDateLong(toIso);
    return from + ' — ' + to;
  }
  function formatTime12(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const suffix = h >= 12 ? 'pm' : 'am';
    const hour12 = h % 12 || 12;
    return m === 0 ? `${hour12}${suffix}` : `${hour12}:${m.toString().padStart(2,'0')}${suffix}`;
  }
  function formatTimeRange(fromTime, toTime) {
    const f = formatTime12(fromTime);
    const t = formatTime12(toTime);
    if (f && t) return f + ' – ' + t;
    if (f) return f;
    if (t) return 'until ' + t;
    return '';
  }

  // =============================================
  //  UTILS
  // =============================================

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // =============================================
  //  INIT
  // =============================================

  function populateTimeSelects() {
    const selects = [document.getElementById('ce-from-time'), document.getElementById('ce-to-time')];
    selects.forEach(sel => {
      if (!sel) return;
      // keep the blank "—" option already in HTML
      for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 15) {
          const val = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
          const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          const ampm = h < 12 ? 'am' : 'pm';
          const minStr = m === 0 ? '' : ':' + String(m).padStart(2, '0');
          const label = hour12 + minStr + ampm;
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          sel.appendChild(opt);
        }
      }
    });
  }

  function init() {
    initSupabase();
    populateTimeSelects();
    showParentView();
  }

  // =============================================
  //  PUBLIC API
  // =============================================

  window.App = {
    showParentView,
    showXOView,
    login,
    logout,
    openCreateEvent,
    openEditEvent,
    saveEvent,
    openEventModal,
    submitSignup,
    openSubmissions,
    exportSubmissions,
    deleteSubmission,
    manualEntry,
    filterXoTab,
    promptDelete,
    confirmDelete,
    closeModal,
    addFormField,
    removeFormField,
    updateField,
    renderFormBuilder,
    toggleFieldMenu,
  };

  document.addEventListener('DOMContentLoaded', init);
})();

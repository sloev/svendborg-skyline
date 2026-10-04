'use strict';

(() => {
  const $ = (s) => document.querySelector(s);
  const STATUS = { uploading: 'Uploader', review: 'Afventer', published: 'Offentlig', hidden: 'Skjult', pending: 'I kø', processing: 'Behandles', ready: 'Klar', failed: 'Fejlet' };
  const ICON = { image: '🖼', video: '🎬', audio: '🎙', document: '📄' };
  let token = '';
  try {
    token = sessionStorage.getItem('silo-admin') || '';
  } catch {}
  let cursor = null;

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }

  const API = String((window.SILO_CONFIG && window.SILO_CONFIG.apiBase) || '').replace(/\/+$/, '');

  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      logout();
      throw new Error(data.error || 'Ikke logget ind');
    }
    if (!res.ok) throw new Error(data.error || `Fejl ${res.status}`);
    return data;
  }

  function logout() {
    token = '';
    try {
      sessionStorage.removeItem('silo-admin');
    } catch {}
    $('#panel').hidden = true;
    $('#login').hidden = false;
  }

  async function load(reset) {
    if (reset) {
      cursor = null;
      $('#list').textContent = '';
    }
    const qs = new URLSearchParams({ limit: '30' });
    if ($('#status').value) qs.set('status', $('#status').value);
    if (cursor) qs.set('before', cursor);
    const data = await api('GET', `/api/admin/submissions?${qs}`);
    $('#counts').textContent = Object.entries(data.counts).map(([k, v]) => `${STATUS[k] || k}: ${v}`).join(' · ');
    const u = data.usage;
    if (u) $('#counts').textContent += ` — Lager: ${u.storedGb} af ${u.storageLimitGb} GB · Skrivninger denne måned: ${u.classA.toLocaleString('da-DK')} af ${u.classALimit.toLocaleString('da-DK')}`;
    for (const s of data.submissions) $('#list').append(row(s));
    cursor = data.next;
    $('#more').hidden = !cursor;
    if (!$('#list').children.length) $('#list').append(el('p', { class: 'meta', text: 'Ingen bidrag.' }));
  }

  function row(s) {
    const node = el(
      'article',
      { class: `row st-${s.status}` },
      el(
        'header',
        {},
        el('h3', { text: s.title || '(uden titel)' }),
        el('span', {}, el('span', { class: `pill ${s.status}`, text: STATUS[s.status] || s.status }), s.reports ? el('span', { class: 'pill hidden', text: ` ${s.reports} anmeldelse(r)` }) : null),
      ),
      el(
        'p',
        { class: 'meta' },
        [
          new Date(s.created_at).toLocaleString('da-DK'),
          s.credit ? `Kreditering: ${s.credit}${s.show_credit ? ' (offentlig)' : ' (ikke offentlig)'}` : 'ingen kreditering',
          s.email ? `${s.email}${s.contact_ok ? ' – må kontaktes' : ''}` : '',
          s.relation,
          s.perspective,
          s.period,
          s.place,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      s.source_url
        ? el('p', { class: 'meta' }, el('span', { class: 'pill', text: 'Import' }), ' ', el('a', { href: s.source_url, target: '_blank', rel: 'noopener', text: 'Kilde' }), ` · Licens: ${s.license || '?'}`)
        : null,
      s.story ? el('div', { class: 'story', text: s.story }) : null,
      el(
        'div',
        { class: 'items' },
        s.items.map((i) =>
          el(
            'figure',
            {},
            i.thumb ? el('a', { href: i.src || i.thumb, target: '_blank' }, el('img', { src: i.thumb, alt: '', loading: 'lazy' })) : el('div', { class: 'noimg', text: ICON[i.kind] }),
            el('figcaption', {}, el('span', { class: `pill ${i.status}`, text: STATUS[i.status] || i.status }), ' ', i.original_name, i.error ? el('div', { class: 'item-error', text: i.error }) : null,
              i.status === 'failed' && !i.original_deleted ? el('button', { class: 'link', type: 'button', text: 'Behandl igen', onclick: () => act(() => api('POST', `/api/admin/items/${i.id}/retry`)) }) : null),
          ),
        ),
      ),
      el(
        'div',
        { class: 'actions' },
        s.status !== 'published' ? el('button', { type: 'button', text: 'Vis offentligt', onclick: () => act(() => api('PATCH', `/api/admin/submissions/${s.id}`, { status: 'published' })) }) : null,
        s.status !== 'hidden' ? el('button', { type: 'button', text: 'Skjul', onclick: () => act(() => api('PATCH', `/api/admin/submissions/${s.id}`, { status: 'hidden' })) }) : null,
        el('button', { type: 'button', text: 'Rediger', onclick: () => node.replaceWith(editor(s)) }),
        s.status === 'published' ? el('a', { href: `./#bidrag/${s.id}`, target: '_blank', class: 'link', text: 'Se på siden' }) : null,
        el('button', {
          type: 'button',
          class: 'danger',
          text: 'Slet helt',
          onclick: () => confirm('Slet bidraget og alle filer permanent?') && act(() => api('DELETE', `/api/admin/submissions/${s.id}`)),
        }),
      ),
    );
    return node;
  }

  // Valgmuligheder til tilknytning og perspektiv hentes én gang fra workeren.
  let options = null;
  async function getOptions() {
    if (!options) {
      const res = await fetch(`${API}/api/config`);
      options = await res.json();
    }
    return options;
  }

  // Redigér alle felter på et bidrag og dets filer.
  function editor(s) {
    const box = el('article', { class: 'row editing' }, el('p', { class: 'meta', text: 'Henter …' }));
    getOptions().then((cfg) => {
      box.textContent = '';
      const input = (label, name, value, attrs = {}) =>
        el('label', { class: 'field' }, el('span', { text: label }), el('input', { name, value: value ?? '', ...attrs }));
      const select = (label, name, value, choices) =>
        el(
          'label',
          { class: 'field' },
          el('span', { text: label }),
          el('select', { name }, el('option', { value: '', text: '—' }), Object.entries(choices || {}).map(([k, v]) => el('option', { value: k, text: v, selected: k === value }))),
        );
      const check = (label, name, value) => el('label', { class: 'check' }, el('input', { type: 'checkbox', name, checked: !!value }), el('span', { text: label }));
      const L = cfg.limits || {};
      const form = el(
        'form',
        { class: 'edit-form' },
        el('h3', { text: 'Rediger bidrag' }),
        input('Overskrift', 'title', s.title, { maxlength: L.title }),
        el('label', { class: 'field' }, el('span', { text: 'Historie / beskrivelse' }), (() => {
          const ta = el('textarea', { name: 'story', rows: '6', maxlength: L.story });
          ta.value = s.story || '';
          return ta;
        })()),
        el(
          'div',
          { class: 'grid-2' },
          input('Hvornår (skrevet)', 'period', s.period, { maxlength: L.period }),
          input('Hvor fra', 'place', s.place, { maxlength: L.place }),
          select('Perspektiv', 'perspective', s.perspective, cfg.perspectives),
          select('Tilknytning', 'relation', s.relation, cfg.relations),
          input('Kreditering / ophavsret', 'credit', s.credit, { maxlength: L.credit }),
          input('E-mail', 'email', s.email, { type: 'email', maxlength: L.email }),
        ),
        check('Vis krediteringen offentligt', 'show_credit', s.show_credit),
        check('Må kontaktes', 'contact_ok', s.contact_ok),
        el(
          'div',
          { class: 'grid-2' },
          input('Kilde (URL)', 'source_url', s.source_url, { type: 'url' }),
          input('Licens', 'license', s.license, { maxlength: '80' }),
          input('Licens-link (URL)', 'license_url', s.license_url, { type: 'url' }),
        ),
        s.items.length ? el('h4', { text: 'Filer' }) : null,
        s.items.map((i) =>
          el(
            'fieldset',
            { class: 'edit-item', 'data-id': i.id },
            el('legend', { text: `${ICON[i.kind] || ''} ${i.original_name}` }),
            el(
              'div',
              { class: 'grid-2' },
              input('Optaget (ÅÅÅÅ-MM-DD TT:MM)', 'taken_at', (i.taken_at || '').replace('T', ' ').slice(0, 16), { placeholder: '2024-06-21 21:14' }),
              input('Kamera', 'camera', i.camera, { maxlength: '200' }),
              input('Breddegrad (lat)', 'lat', i.lat, { inputmode: 'decimal', placeholder: '55.0612' }),
              input('Længdegrad (lon)', 'lon', i.lon, { inputmode: 'decimal', placeholder: '10.6160' }),
            ),
          ),
        ),
        el(
          'div',
          { class: 'actions' },
          el('button', { type: 'submit', class: 'primary', text: 'Gem' }),
          el('button', { type: 'button', text: 'Annullér', onclick: () => box.replaceWith(row(s)) }),
        ),
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = form.elements;
        const body = {
          title: f.title.value, story: f.story.value, period: f.period.value, place: f.place.value,
          perspective: f.perspective.value, relation: f.relation.value, credit: f.credit.value, email: f.email.value,
          show_credit: f.show_credit.checked, contact_ok: f.contact_ok.checked,
          source_url: f.source_url.value, license: f.license.value, license_url: f.license_url.value,
          items: [...form.querySelectorAll('.edit-item')].map((fs) => {
            const v = (n) => fs.querySelector(`[name=${n}]`).value.trim();
            return { id: fs.dataset.id, taken_at: v('taken_at'), camera: v('camera'), lat: v('lat').replace(',', '.'), lon: v('lon').replace(',', '.') };
          }),
        };
        await act(() => api('PUT', `/api/admin/submissions/${s.id}`, body));
      });
      box.append(form);
    });
    return box;
  }

  async function act(fn) {
    try {
      await fn();
      await load(true);
    } catch (err) {
      alert(err.message);
    }
  }

  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('#token').value.trim();
    try {
      await start();
      try {
        sessionStorage.setItem('silo-admin', token);
      } catch {}
    } catch (err) {
      $('#login-error').textContent = err.message;
      $('#login-error').hidden = false;
    }
  });

  async function start() {
    await load(true);
    $('#login').hidden = true;
    $('#panel').hidden = false;
  }

  // ---------------------------------------------------------------- kommentarer

  const C_STATUS = { pending: 'Afventer', published: 'Offentlig', hidden: 'Skjult' };
  let ccursor = null;
  const commentsView = () => $('#view').value === 'comments';

  async function loadComments(reset) {
    if (reset) {
      ccursor = null;
      $('#list').textContent = '';
    }
    const qs = new URLSearchParams();
    if ($('#cstatus').value) qs.set('status', $('#cstatus').value);
    if (ccursor) qs.set('before', ccursor);
    const data = await api('GET', `/api/admin/comments?${qs}`);
    $('#counts').textContent = Object.entries(data.counts).map(([k, v]) => `${C_STATUS[k] || k}: ${v}`).join(' · ') || 'Ingen kommentarer endnu.';
    for (const c of data.comments) $('#list').append(commentRow(c));
    ccursor = data.next;
    $('#more').hidden = !ccursor;
    if (!$('#list').children.length) $('#list').append(el('p', { class: 'meta', text: 'Ingen kommentarer.' }));
  }

  function commentRow(c) {
    const set = (status) => actC(() => api('PATCH', `/api/admin/comments/${c.id}`, { status }));
    return el(
      'article',
      { class: `row st-${c.status === 'pending' ? 'review' : c.status}` },
      el(
        'header',
        {},
        el('h3', { text: c.name }),
        el(
          'span',
          {},
          el('span', { class: `pill ${c.status === 'pending' ? 'review' : c.status}`, text: C_STATUS[c.status] || c.status }),
          c.reports ? el('span', { class: 'pill hidden', text: ` ${c.reports} anmeldelse(r)` }) : null,
          c.spam_reasons ? el('span', { class: 'pill hidden', text: ` mistænkelig: ${c.spam_reasons}` }) : null,
          c.is_test ? el('span', { class: 'pill', text: ' test' }) : null,
        ),
      ),
      el('p', { class: 'meta' }, new Date(c.created_at).toLocaleString('da-DK'), ' · på ', el('a', { href: `./#bidrag/${c.submission_id}`, target: '_blank', text: c.submission_title || '(uden titel)' })),
      el('div', { class: 'story', text: c.body }),
      el(
        'div',
        { class: 'actions' },
        c.status !== 'published' ? el('button', { type: 'button', text: 'Godkend', onclick: () => set('published') }) : null,
        c.status !== 'hidden' ? el('button', { type: 'button', text: 'Skjul', onclick: () => set('hidden') }) : null,
        el('button', { type: 'button', class: 'danger', text: 'Slet', onclick: () => confirm('Slet kommentaren permanent?') && actC(() => api('DELETE', `/api/admin/comments/${c.id}`)) }),
      ),
    );
  }

  async function actC(fn) {
    try {
      await fn();
      await loadComments(true);
    } catch (err) {
      alert(err.message);
    }
  }

  const reload = (reset) => (commentsView() ? loadComments(reset) : load(reset));
  $('#view').addEventListener('change', () => {
    $('#cstatus').hidden = !commentsView();
    $('#status').hidden = commentsView();
    $('.admin-title').textContent = commentsView() ? 'Kommentarer' : 'Bidrag';
    reload(true).catch((e) => alert(e.message));
  });
  $('#cstatus').addEventListener('change', () => loadComments(true).catch((e) => alert(e.message)));
  $('#status').addEventListener('change', () => load(true).catch((e) => alert(e.message)));
  $('#more').addEventListener('click', () => reload(false).catch((e) => alert(e.message)));
  $('#logout').addEventListener('click', logout);
  $('#export').addEventListener('click', async () => {
    try {
      const data = await api('GET', '/api/admin/export');
      const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: `siloerne-bidrag-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
    } catch (err) {
      alert(err.message);
    }
  });

  if (token) start().catch(logout);
  else logout();
})();

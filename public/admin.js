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
        s.status === 'published' ? el('a', { href: `./#bidrag/${s.id}`, target: '_blank', class: 'link', text: 'Se på siden' }) : null,
        el('button', {
          type: 'button',
          class: 'danger',
          text: 'Slet helt',
          onclick: () => confirm('Slet bidraget og alle filer permanent? (Kopier i Google Drive skal slettes manuelt.)') && act(() => api('DELETE', `/api/admin/submissions/${s.id}`)),
        }),
      ),
    );
    return node;
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

  $('#status').addEventListener('change', () => load(true).catch((e) => alert(e.message)));
  $('#more').addEventListener('click', () => load(false).catch((e) => alert(e.message)));
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

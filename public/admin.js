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
    if ($('#noloc').checked) qs.set('noloc', '1');
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

  // Historien vises formateret (fed, links, lister, citater) som på siden.
  function storyBox(md) {
    const box = el('div', { class: 'story viewer-story' });
    if (window.SiloKit) window.SiloKit.render(md, box);
    else box.textContent = md;
    for (const a of box.querySelectorAll('a')) a.target = '_blank';
    return box;
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
      s.story ? storyBox(s.story) : null,
      el(
        'div',
        { class: 'items' },
        s.items.map((i) =>
          el(
            'figure',
            {},
            i.thumb ? thumbLink(i) : el('div', { class: 'noimg', text: ICON[i.kind] }),
            el('figcaption', {}, el('span', { class: `pill ${i.status}`, text: STATUS[i.status] || i.status }), ' ',
              i.nsfw >= NSFW_FLAG ? el('span', { class: 'pill nsfw', title: 'Billedgenkendelsen mistænker nøgenhed eller porno – se selv efter', text: `NSFW? ${Math.round(i.nsfw * 100)} %` }) : null, ' ',
              i.original_name, i.error ? el('div', { class: 'item-error', text: i.error }) : null,
              i.status === 'failed' && !i.original_deleted ? el('button', { class: 'link', type: 'button', text: 'Behandl igen', onclick: () => act(() => api('POST', `/api/admin/items/${i.id}/retry`)) }) : null,
              LOCATABLE.includes(i.kind) ? locButton(i, s) : null),
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

  // ---------------------------------------------------------------- placering

  // Kortet med en fast nål i midten: man trækker kortet ind under nålen og gemmer.
  const LOCATABLE = ['image', 'video', 'audio'];
  const HARBOUR = [55.0605, 10.6125];
  let lastPos = null; // næste fil uden placering starter, hvor man sidst satte en
  const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const fmt = (lat, lon) => `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
  const hasLoc = (i) => i.lat !== null && i.lat !== undefined && i.lon !== null && i.lon !== undefined;

  function locButton(i, s) {
    return el('button', {
      type: 'button',
      class: `link loc-btn${hasLoc(i) ? '' : ' missing'}`,
      title: hasLoc(i) ? 'Flyt placeringen' : 'Sæt placering på kortet',
      text: hasLoc(i) ? `📍 ${fmt(i.lat, i.lon)}` : '📍 Sæt placering',
      onclick: (e) => openPicker(i, s, e.currentTarget.closest('article')),
    });
  }

  function openPicker(i, s, node) {
    if (!window.L) return alert('Kortet er ikke indlæst endnu – prøv igen om et øjeblik.');
    for (const old of node.querySelectorAll('.loc-picker')) old.remove();
    const sibling = s.items.find((x) => x !== i && hasLoc(x));
    const start = hasLoc(i) ? [i.lat, i.lon] : sibling ? [sibling.lat, sibling.lon] : lastPos || HARBOUR;
    const mapEl = el('div', { class: 'loc-map' });
    const coords = el('code', { class: 'loc-coords' });
    const save = async (lat, lon) => {
      try {
        await api('PATCH', `/api/admin/items/${i.id}/location`, { lat, lon });
        if (lat !== null) lastPos = [lat, lon];
        await reload(true);
      } catch (err) {
        alert(err.message);
      }
    };
    const picker = el(
      'div',
      { class: 'loc-picker' },
      el('p', { class: 'meta' }, `${ICON[i.kind] || ''} ${i.original_name}: træk kortet, så nålen står, hvor ${i.kind === 'audio' ? 'optagelsen er lavet' : 'billedet er taget fra'}.`),
      el('div', { class: 'loc-frame' }, mapEl, el('div', { class: 'loc-pin', 'aria-hidden': 'true' })),
      el(
        'div',
        { class: 'actions' },
        coords,
        el('button', { type: 'button', class: 'primary', text: 'Gem placering', onclick: () => { const c = map.getCenter(); save(Math.round(c.lat * 1e6) / 1e6, Math.round(c.lng * 1e6) / 1e6); } }),
        hasLoc(i) ? el('button', { type: 'button', class: 'danger', text: 'Fjern placering', onclick: () => confirm('Fjern placeringen fra filen?') && save(null, null) }) : null,
        el('button', { type: 'button', text: 'Annullér', onclick: () => { map.remove(); picker.remove(); } }),
      ),
    );
    node.querySelector('.items').after(picker);
    const map = L.map(mapEl, { zoomControl: true }).setView(start, hasLoc(i) || sibling || lastPos ? 17 : 15);
    L.tileLayer(TILES, { maxZoom: 19, attribution: OSM }).addTo(map);
    // De andre filer med placering i samme bidrag vises som små prikker.
    for (const x of s.items) if (x !== i && hasLoc(x)) L.circleMarker([x.lat, x.lon], { radius: 5, color: '#fff', weight: 1, fillColor: '#5b6b73', fillOpacity: 0.8 }).addTo(map);
    const show = () => { const c = map.getCenter(); coords.textContent = fmt(c.lat, c.lng); };
    map.on('move', show);
    show();
    picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------------------------------------------------------------- oversigtskort

  const MAP_COLOR = { published: '#1d8a74', review: '#d99a00', hidden: '#9aa5ab' };
  let overview = null;
  let overviewView = null;

  async function loadMap() {
    if (!window.L) return setTimeout(() => loadMap().catch((e) => alert(e.message)), 300);
    if (overview) {
      overviewView = { center: overview.getCenter(), zoom: overview.getZoom() };
      overview.remove();
      overview = null;
    }
    $('#list').textContent = '';
    $('#more').hidden = true;
    const { points } = await api('GET', '/api/admin/map');
    const groups = new Map();
    for (const p of points) {
      const key = `${p.submissionId}:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
      if (!groups.has(key)) groups.set(key, { ...p, count: 0, thumb: null });
      const g = groups.get(key);
      g.count++;
      g.thumb = g.thumb || p.thumb;
    }
    const subs = new Set(points.map((p) => p.submissionId));
    $('#counts').textContent = `${subs.size} bidrag med placering (${points.length} filer). Grøn: offentlig · gul: afventer · grå: skjult. Brug "Mangler placering" under Bidrag for at finde dem uden.`;
    const mapEl = el('div', { class: 'admin-map' });
    const detail = el('div', { id: 'map-detail' });
    $('#list').append(mapEl, detail);
    overview = L.map(mapEl).setView(HARBOUR, 15);
    L.tileLayer(TILES, { maxZoom: 19, attribution: OSM }).addTo(overview);
    const markers = [];
    for (const p of groups.values()) {
      const showRow = async () => {
        const data = await api('GET', `/api/admin/submissions?id=${encodeURIComponent(p.submissionId)}`);
        detail.textContent = '';
        for (const s of data.submissions) detail.append(row(s));
        detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      const popup = el(
        'div',
        { class: 'map-popup' },
        p.thumb ? el('img', { src: p.thumb, alt: '', loading: 'lazy' }) : el('div', { class: 'map-popup-icon', text: ICON[p.kind] || '📍' }),
        el('strong', { class: 'map-popup-title', text: p.title || '(uden titel)' }),
        el('span', { class: 'map-popup-meta' }, el('span', { class: `pill ${p.status}`, text: STATUS[p.status] || p.status }), p.period ? ` ${p.period}` : '', p.count > 1 ? ` · ${p.count} filer` : ''),
        p.excerpt ? el('p', { class: 'map-popup-text', text: p.excerpt }) : null,
        el(
          'div',
          { class: 'actions' },
          el('button', { type: 'button', class: 'primary', text: 'Læs mere →', onclick: () => showRow().catch((e) => alert(e.message)) }),
          p.status === 'published' ? el('a', { href: `./#bidrag/${p.submissionId}`, target: '_blank', class: 'link', text: 'Se på siden' }) : null,
        ),
      );
      markers.push(
        L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: MAP_COLOR[p.status] || '#5b6b73', fillOpacity: 0.9 })
          .bindPopup(popup, { maxWidth: 260, minWidth: 220 })
          .bindTooltip(p.title || '', { direction: 'top', offset: [0, -6] })
          .addTo(overview),
      );
    }
    if (overviewView) overview.setView(overviewView.center, overviewView.zoom);
    else if (markers.length) overview.fitBounds(L.featureGroup(markers).getBounds().pad(0.15), { maxZoom: 17 });
  }

  // Filer, som billedgenkendelsen mistænker for nøgenhed/porno, vises sløret, indtil man klikker på dem.
  const NSFW_FLAG = 0.5;
  function thumbLink(i) {
    const img = el('img', { src: i.thumb, alt: '', loading: 'lazy' });
    const a = el('a', { href: i.src || i.thumb, target: '_blank', rel: 'noopener', class: i.nsfw >= NSFW_FLAG ? 'blurred' : '' }, img);
    if (i.nsfw >= NSFW_FLAG) {
      a.title = 'Sløret: muligt NSFW. Klik for at se.';
      a.addEventListener('click', (e) => {
        if (!a.classList.contains('blurred')) return;
        e.preventDefault();
        a.classList.remove('blurred');
      });
    }
    return a;
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
  const ENT_DA = { person: 'person', ship: 'skib', building: 'bygning', company: 'firma', place: 'sted', vehicle: 'køretøj', event: 'begivenhed' };
  const ENT_TYPE = Object.fromEntries(Object.entries(ENT_DA).map(([k, v]) => [v, k]));

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
        el('label', { class: 'field' }, el('span', { text: 'Navne i bidraget (én pr. linje: person, skib, bygning, firma, sted, køretøj eller begivenhed – fx »skib: LISTER«)' }), (() => {
          const ta = el('textarea', { name: 'entities', rows: '4', placeholder: 'person: Finn Johannessen\nbygning: FAF-siloen' });
          let list = [];
          try {
            list = JSON.parse(s.entities || '[]');
          } catch {}
          ta.value = list.map(([t, n]) => `${ENT_DA[t] || t}: ${n}`).join('\n');
          return ta;
        })()),
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
          entities: f.entities.value.split('\n').map((l) => l.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/)).filter(Boolean)
            .map(([, t, n]) => [ENT_TYPE[t.toLowerCase()] || t.toLowerCase(), n]),
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
      await reload(true);
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

  const mapView = () => $('#view').value === 'map';
  function reload(reset) {
    if (overview && !mapView()) {
      overview.remove();
      overview = null;
    }
    return commentsView() ? loadComments(reset) : mapView() ? loadMap() : load(reset);
  }
  $('#view').addEventListener('change', () => {
    $('#cstatus').hidden = !commentsView();
    $('#status').hidden = commentsView() || mapView();
    $('.admin-noloc').hidden = commentsView() || mapView();
    $('.admin-title').textContent = commentsView() ? 'Kommentarer' : mapView() ? 'Kort' : 'Bidrag';
    reload(true).catch((e) => alert(e.message));
  });
  $('#cstatus').addEventListener('change', () => loadComments(true).catch((e) => alert(e.message)));
  $('#status').addEventListener('change', () => load(true).catch((e) => alert(e.message)));
  $('#noloc').addEventListener('change', () => load(true).catch((e) => alert(e.message)));
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

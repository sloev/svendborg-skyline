'use strict';

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const fmtDate = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtNum = new Intl.NumberFormat('da-DK');

  let config = { maxFiles: 40, maxFileMb: 2048, chunkSize: 16 * 1024 * 1024, relations: {}, perspectives: {} };

  // ------------------------------------------------------------------ helpers

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  async function getJson(url, opts = {}) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Fejl ${res.status}`);
    return data;
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
  }

  function formatDuration(s) {
    if (!s) return '';
    s = Math.round(s);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function formatTaken(v) {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? v : fmtDate.format(d);
  }

  function kindOf(file) {
    const t = (file.type || '').toLowerCase();
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (t.startsWith('image/') || /^(jpe?g|png|gif|webp|heic|heif|avif|tiff?|bmp|dng|cr2|cr3|nef|arw|orf|raf|rw2)$/.test(ext)) return 'image';
    if (t.startsWith('video/') || /^(mp4|mov|m4v|avi|mkv|webm|3gp|mts|m2ts|mpe?g|wmv)$/.test(ext)) return 'video';
    if (t.startsWith('audio/') || /^(mp3|m4a|aac|wav|ogg|oga|opus|flac|amr|wma)$/.test(ext)) return 'audio';
    if (t === 'application/pdf' || ext === 'pdf') return 'document';
    return null;
  }

  const KIND_ICON = { image: '🖼', video: '🎬', audio: '🎙', document: '📄' };

  // ------------------------------------------------------------------ config + stats

  async function init() {
    try {
      config = { ...config, ...(await getJson('/api/config')) };
    } catch (e) {
      console.warn('config', e);
    }
    for (const sel of $$('select[data-options]')) {
      for (const [value, label] of Object.entries(config[sel.dataset.options] || {})) sel.append(el('option', { value, text: label }));
    }
    $$('[data-cfg=maxFiles]').forEach((n) => (n.textContent = config.maxFiles));
    $$('[data-cfg=maxFileGb]').forEach((n) => (n.textContent = fmtNum.format(Math.round((config.maxFileMb / 1024) * 10) / 10)));
    if (config.contactEmail) {
      const line = $('#contact-line');
      line.textContent = ' på ';
      line.append(el('a', { href: `mailto:${config.contactEmail}`, text: config.contactEmail }), ', så retter eller sletter vi det.');
    }
    renderTurnstile();
    loadStats();
    loadFeed(true);
    openFromHash();
  }

  async function loadStats(fresh = false) {
    try {
      const s = await getJson('/api/stats', fresh ? { cache: 'reload' } : {});
      const set = (k, v) => ($(`[data-stat=${k}]`).textContent = fmtNum.format(v || 0));
      set('contributions', s.contributions);
      set('images', s.images);
      set('videos', s.videos);
      set('other', (s.audio || 0) + (s.documents || 0));
    } catch {}
  }

  // ------------------------------------------------------------------ turnstile

  let turnstileWidget = null;
  let turnstileToken = '';
  function renderTurnstile(tries = 0) {
    if (!config.turnstileSiteKey) return;
    if (!window.turnstile) {
      if (tries < 100) setTimeout(() => renderTurnstile(tries + 1), 150);
      return;
    }
    turnstileWidget = window.turnstile.render('#turnstile', {
      sitekey: config.turnstileSiteKey,
      language: 'da',
      callback: (t) => (turnstileToken = t),
      'expired-callback': () => (turnstileToken = ''),
      'error-callback': () => (turnstileToken = ''),
    });
  }

  // ------------------------------------------------------------------ file picker

  const form = $('#share-form');
  const fileInput = $('#files');
  const fileList = $('#file-list');
  const drop = $('#drop');
  const formLoadedAt = Date.now();
  /** @type {{file: File, kind: string, li: HTMLElement, url?: string}[]} */
  let picked = [];

  function addFiles(list) {
    const errors = [];
    for (const file of list) {
      const kind = kindOf(file);
      if (!kind) {
        errors.push(`"${file.name}" er ikke et billede, en video, lyd eller PDF.`);
        continue;
      }
      if (file.size === 0) {
        errors.push(`"${file.name}" er tom.`);
        continue;
      }
      if (file.size > config.maxFileMb * 1024 * 1024) {
        errors.push(`"${file.name}" er for stor (max ${fmtNum.format(config.maxFileMb)} MB).`);
        continue;
      }
      if (picked.some((p) => p.file.name === file.name && p.file.size === file.size && p.file.lastModified === file.lastModified)) continue;
      if (picked.length >= config.maxFiles) {
        errors.push(`Du kan højst sende ${config.maxFiles} filer ad gangen. Send gerne resten bagefter.`);
        break;
      }
      const entry = { file, kind };
      const thumb = el('div', { class: 'thumb', text: KIND_ICON[kind] });
      if (kind === 'image' && /^image\/(jpeg|png|gif|webp|avif)$/.test(file.type)) {
        entry.url = URL.createObjectURL(file);
        thumb.textContent = '';
        thumb.append(el('img', { src: entry.url, alt: '' }));
      } else if (kind === 'video' && file.size < 600 * 1024 * 1024) {
        entry.url = URL.createObjectURL(file);
        thumb.textContent = '';
        thumb.append(el('video', { src: `${entry.url}#t=0.5`, muted: true, preload: 'metadata', playsinline: true }));
      }
      entry.li = el(
        'li',
        {},
        thumb,
        el('div', { class: 'name', title: file.name, text: file.name }),
        el('div', { class: 'size', text: formatSize(file.size) }),
        el('div', { class: 'fbar' }, el('div')),
        el('button', { type: 'button', class: 'remove', 'aria-label': `Fjern ${file.name}`, text: '×', onclick: () => removeFile(entry) }),
      );
      picked.push(entry);
      fileList.append(entry.li);
    }
    showError(errors.join(' '));
  }

  function removeFile(entry) {
    if (form.classList.contains('busy')) return;
    picked = picked.filter((p) => p !== entry);
    entry.li.remove();
    if (entry.url) URL.revokeObjectURL(entry.url);
  }

  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  function showError(msg) {
    const box = $('#form-error');
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  // ------------------------------------------------------------------ submit + upload

  let uploading = false;
  window.addEventListener('beforeunload', (e) => {
    if (uploading) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const data = new FormData(form);
    const story = String(data.get('story') || '').trim();
    if (!picked.length && story.length < 20) return showError('Vælg mindst én fil, eller skriv en historie (mindst et par sætninger).');
    if (!data.get('consent')) return showError('Sæt kryds ved tilladelsen nederst, så vi må vise og gemme dit bidrag.');
    if (config.turnstileSiteKey && !turnstileToken) return showError('Vent et øjeblik på spam-tjekket, eller sæt kryds i boksen ved "Send".');

    const btn = $('#submit');
    btn.disabled = true;
    form.classList.add('busy');
    let wakeLock = null;
    try {
      const payload = {
        title: data.get('title'),
        story,
        period: data.get('period'),
        place: data.get('place'),
        perspective: data.get('perspective'),
        relation: data.get('relation'),
        name: data.get('name'),
        email: data.get('email'),
        showName: !!data.get('showName'),
        contactOk: !!data.get('contactOk'),
        shareLocation: !!data.get('shareLocation'),
        consent: !!data.get('consent'),
        website: data.get('website'),
        elapsedMs: Date.now() - formLoadedAt,
        turnstileToken,
        files: picked.map((p) => ({ name: p.file.name, size: p.file.size, type: p.file.type, lastModified: p.file.lastModified })),
      };
      const sub = await getJson('/api/submissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

      uploading = true;
      try {
        wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null;
      } catch {}
      const failures = await uploadAll(sub, picked);
      const done = await getJson(`/api/submissions/${sub.id}/complete`, { method: 'POST', headers: { 'x-upload-token': sub.uploadToken } });
      uploading = false;

      let msg = done.status === 'review' ? 'Dit bidrag er modtaget og bliver vist på siden, så snart vi har kigget på det.' : 'Dit bidrag er modtaget og kan allerede ses på siden.';
      if (done.pending) msg += ` Vi er i gang med at gøre ${done.pending === 1 ? 'filen' : `de ${done.pending} filer`} klar til visning. Det tager som regel et par minutter.`;
      if (failures.length) msg += ` Desværre kom ${failures.length === 1 ? 'denne fil' : 'disse filer'} ikke igennem: ${failures.join(', ')}. Prøv gerne at sende ${failures.length === 1 ? 'den' : 'dem'} igen.`;
      $('#thanks-text').textContent = msg;
      $('#progress').hidden = true;
      $('#thanks').hidden = false;
      form.hidden = true;
      $('#thanks').scrollIntoView({ behavior: 'smooth', block: 'center' });
      resetForm();
      loadStats(true);
      loadFeed(true, true);
    } catch (err) {
      uploading = false;
      $('#progress').hidden = true;
      showError(err.message || 'Noget gik galt. Prøv igen.');
    } finally {
      if (wakeLock) wakeLock.release().catch(() => {});
      btn.disabled = false;
      form.classList.remove('busy');
      if (turnstileWidget !== null && window.turnstile) {
        window.turnstile.reset(turnstileWidget);
        turnstileToken = '';
      }
    }
  });

  function resetForm() {
    form.reset();
    for (const p of picked) if (p.url) URL.revokeObjectURL(p.url);
    picked = [];
    fileList.textContent = '';
  }

  $('#again').addEventListener('click', () => {
    $('#thanks').hidden = true;
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth' });
  });

  async function uploadAll(sub, entries) {
    if (!entries.length) return [];
    const total = entries.reduce((n, p) => n + p.file.size, 0);
    const sent = new Array(entries.length).fill(0);
    const progress = $('#progress');
    progress.hidden = false;
    $('#progress-title').textContent = `Sender ${entries.length === 1 ? '1 fil' : `${entries.length} filer`} (${formatSize(total)}) …`;
    const update = () => {
      const s = sent.reduce((a, b) => a + b, 0);
      const pct = Math.min(100, (s / total) * 100);
      $('#progress-bar').style.width = `${pct}%`;
      $('#progress-text').textContent = `${formatSize(s)} af ${formatSize(total)} · ${Math.floor(pct)} %`;
    };
    update();

    const failures = [];
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const i = next++;
        const entry = entries[i];
        const item = sub.items.find((it) => it.position === i);
        const bar = $('.fbar div', entry.li);
        try {
          await uploadFile(sub, item.id, entry.file, (bytes) => {
            sent[i] = bytes;
            bar.style.width = `${(bytes / entry.file.size) * 100}%`;
            update();
          });
          entry.li.classList.add('done');
        } catch (err) {
          console.error(err);
          entry.li.classList.add('error');
          failures.push(entry.file.name);
          sent[i] = entry.file.size;
          update();
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return failures;
  }

  async function uploadFile(sub, itemId, file, onProgress) {
    const chunk = sub.chunkSize || config.chunkSize;
    const count = Math.ceil(file.size / chunk);
    const parts = [];
    for (let n = 1; n <= count; n++) {
      const start = (n - 1) * chunk;
      const blob = file.slice(start, Math.min(file.size, start + chunk));
      let attempt = 0;
      for (;;) {
        try {
          parts.push(await putPart(`/api/upload/${itemId}/${n}`, blob, sub.uploadToken, (loaded) => onProgress(start + loaded)));
          break;
        } catch (err) {
          if (++attempt >= 5 || err.fatal) throw err;
          await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        }
      }
    }
    await getJson(`/api/upload/${itemId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-upload-token': sub.uploadToken },
      body: JSON.stringify({ parts }),
    });
    onProgress(file.size);
  }

  function putPart(url, blob, token, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('x-upload-token', token);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || `Fejl ${xhr.status}`), { fatal: xhr.status >= 400 && xhr.status < 500 && xhr.status !== 408 && xhr.status !== 429 }));
      };
      xhr.onerror = () => reject(new Error('Netværksfejl'));
      xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.send(blob);
    });
  }

  // ------------------------------------------------------------------ feed

  const feed = $('#feed');
  const moreBtn = $('#more');
  const filters = { kind: '', relation: '', perspective: '' };
  let cursor = null;
  let feedToken = 0;
  const known = new Map();

  async function loadFeed(reset, fresh = false) {
    const token = ++feedToken;
    if (reset) {
      cursor = null;
      feed.textContent = '';
      for (let i = 0; i < 4; i++) feed.append(el('div', { class: 'tile skeleton' }));
    }
    const qs = new URLSearchParams({ limit: '24' });
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    if (cursor) qs.set('before', cursor);
    try {
      const data = await getJson(`/api/contributions?${qs}`, fresh ? { cache: 'reload' } : {});
      if (token !== feedToken) return;
      if (reset) feed.textContent = '';
      for (const c of data.contributions) {
        known.set(c.id, c);
        feed.append(tile(c));
      }
      cursor = data.next;
      moreBtn.hidden = !cursor;
      $('#feed-empty').hidden = feed.children.length > 0;
    } catch (err) {
      if (token !== feedToken) return;
      feed.textContent = '';
      feed.append(el('p', { class: 'muted', text: `Kunne ikke hente bidrag: ${err.message}` }));
    }
  }

  function tile(c) {
    const first = c.items.find((i) => i.thumb) || c.items[0];
    const excerpt = c.story ? c.story.slice(0, 400) : '';
    const byline = [c.name, c.relationLabel, c.period].filter(Boolean).join(' · ');
    let media = null;
    let body;
    if (first && first.thumb) {
      media = el(
        'div',
        { class: 'tile-media' },
        el('img', { src: first.thumb, alt: c.title || 'Bidrag', loading: 'lazy', width: first.width || null, height: first.height || null }),
        first.kind === 'video' ? el('span', { class: 'play', 'aria-hidden': 'true', text: '▶' }) : null,
        c.items.length > 1 ? el('span', { class: 'badge', text: `${c.items.length} filer` }) : null,
      );
    } else if (first && first.kind === 'audio') {
      media = el('div', { class: 'tile-audio' }, el('span', { text: '🎙' }), el('span', { text: `Lydoptagelse ${formatDuration(first.duration)}` }));
    }
    if (!media && excerpt) {
      body = el(
        'div',
        { class: 'tile-quote' },
        el('p', { text: excerpt }),
        el(
          'div',
          { class: 'tile-body', style: 'padding:0 0 14px' },
          c.title ? el('h3', { text: c.title }) : null,
          el('span', { class: 'byline', text: byline }),
          processingNote(c),
        ),
      );
    } else {
      body = el(
        'div',
        { class: 'tile-body' },
        c.title ? el('h3', { text: c.title }) : null,
        excerpt ? el('p', { text: excerpt }) : null,
        byline ? el('span', { class: 'byline', text: byline }) : null,
        processingNote(c),
      );
    }
    return el('button', { type: 'button', class: 'tile', 'aria-label': `Åbn bidrag${c.title ? `: ${c.title}` : ''}`, onclick: () => openViewer(c, 0) }, media, body);
  }

  function processingNote(c) {
    return c.processing ? el('p', { class: 'processing-note', text: `⏳ ${c.processing === 1 ? '1 fil' : `${c.processing} filer`} gøres klar …` }) : null;
  }

  moreBtn.addEventListener('click', () => loadFeed(false));
  $('#kind-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    $$('#kind-filter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    filters.kind = b.dataset.kind;
    loadFeed(true);
  });
  $('#relation-filter').addEventListener('change', (e) => {
    filters.relation = e.target.value;
    loadFeed(true);
  });
  $('#perspective-filter').addEventListener('change', (e) => {
    filters.perspective = e.target.value;
    loadFeed(true);
  });

  // ------------------------------------------------------------------ viewer

  const viewer = $('#viewer');
  let current = null;
  let index = 0;

  function openViewer(c, i) {
    current = c;
    $('#viewer-title').textContent = c.title || (c.items.length ? 'Bidrag' : 'Historie');
    $('#viewer-meta').textContent = [c.name ? `Delt af ${c.name}` : 'Delt anonymt', c.publishedAt ? fmtDate.format(new Date(c.publishedAt)) : ''].filter(Boolean).join(' · ');
    $('#viewer-story').textContent = c.story || '';
    const strip = $('#viewer-strip');
    strip.textContent = '';
    if (c.items.length > 1) {
      c.items.forEach((it, n) =>
        strip.append(
          el('button', { type: 'button', 'aria-label': `Vis fil ${n + 1}`, onclick: () => showItem(n) }, it.thumb ? el('img', { src: it.thumb, alt: '', loading: 'lazy' }) : KIND_ICON[it.kind]),
        ),
      );
    }
    showItem(i);
    if (!viewer.open) viewer.showModal();
    history.replaceState(null, '', `#bidrag/${c.id}`);
  }

  function showItem(n) {
    const c = current;
    const box = $('#viewer-media');
    box.textContent = '';
    index = n;
    const it = c.items[n];
    $('#viewer-media').hidden = !it;
    if (it) {
      if (it.kind === 'image') box.append(el('img', { src: it.src, alt: c.title || 'Billede' }));
      else if (it.kind === 'video') box.append(el('video', { src: it.src, poster: it.poster, controls: true, playsinline: true, preload: 'metadata' }));
      else if (it.kind === 'audio') box.append(el('audio', { src: it.src, controls: true, preload: 'metadata' }));
      else if (it.kind === 'document')
        box.append(el('div', { class: 'doc' }, it.thumb ? el('img', { src: it.thumb, alt: '' }) : null, el('a', { class: 'btn btn-primary', href: it.src, target: '_blank', rel: 'noopener', text: 'Åbn PDF' })));
      if (c.items.length > 1) {
        box.append(
          el('button', { type: 'button', class: 'nav prev', 'aria-label': 'Forrige', text: '‹', onclick: () => showItem((n - 1 + c.items.length) % c.items.length) }),
          el('button', { type: 'button', class: 'nav next', 'aria-label': 'Næste', text: '›', onclick: () => showItem((n + 1) % c.items.length) }),
        );
      }
    }
    $$('#viewer-strip button').forEach((b, k) => b.setAttribute('aria-current', String(k === n)));

    const facts = $('#viewer-facts');
    facts.textContent = '';
    const add = (k, v) => v && facts.append(el('dt', { text: k }), el('dd', { text: v }));
    add('Hvornår', c.period);
    if (it) add('Optaget', formatTaken(it.takenAt));
    add('Hvor fra', c.place);
    add('Perspektiv', c.perspectiveLabel);
    add('Tilknytning', c.relationLabel);
    if (it) {
      add('Kamera', it.camera);
      if (it.duration) add('Længde', formatDuration(it.duration));
      if (it.kind !== 'audio' && it.kind !== 'document') {
        const full = el('a', { href: it.src, target: '_blank', rel: 'noopener', text: 'Åbn i fuld størrelse' });
        facts.append(el('dt', { text: 'Fil' }), el('dd', {}, full));
      }
    }
    if (c.processing) add('Bemærk', `${c.processing} fil(er) gøres stadig klar til visning`);
  }

  viewer.addEventListener('close', () => {
    $$('video, audio', viewer).forEach((m) => m.pause());
    if (location.hash.startsWith('#bidrag/')) history.replaceState(null, '', '#bidrag');
  });
  viewer.addEventListener('click', (e) => {
    if (e.target === viewer || e.target.closest('[data-close]')) viewer.close();
  });
  document.addEventListener('keydown', (e) => {
    if (!viewer.open || !current || current.items.length < 2) return;
    if (e.target.closest && e.target.closest('video, audio')) return;
    if (e.key === 'ArrowRight') showItem((index + 1) % current.items.length);
    if (e.key === 'ArrowLeft') showItem((index - 1 + current.items.length) % current.items.length);
  });
  $('#viewer-share').addEventListener('click', async (e) => {
    const url = `${location.origin}/#bidrag/${current.id}`;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: current.title || 'Siloerne på Østre Kaj', url });
      else {
        await navigator.clipboard.writeText(url);
        e.target.textContent = 'Link kopieret ✓';
        setTimeout(() => (e.target.textContent = 'Kopiér link'), 2000);
      }
    } catch {}
  });
  $('#viewer-report').addEventListener('click', async () => {
    const reason = prompt('Hvorfor skal bidraget fjernes? (f.eks. spam, krænkende, mit eget billede brugt uden lov)');
    if (reason === null) return;
    try {
      await getJson(`/api/contributions/${current.id}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) });
      alert('Tak – vi kigger på det.');
    } catch (err) {
      alert(err.message);
    }
  });

  async function openFromHash() {
    const m = location.hash.match(/^#bidrag\/([\w-]+)/);
    if (!m) return;
    try {
      const c = known.get(m[1]) || (await getJson(`/api/contributions/${m[1]}`));
      openViewer(c, 0);
    } catch (err) {
      console.warn(err);
    }
  }
  window.addEventListener('hashchange', openFromHash);

  // ------------------------------------------------------------------ map

  let mapStarted = false;
  function startMap() {
    if (mapStarted) return;
    if (!window.L) return setTimeout(startMap, 300);
    mapStarted = true;
    const map = L.map('map', { scrollWheelZoom: false }).setView([55.0605, 10.6125], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    getJson('/api/map')
      .then(({ points }) => {
        const markers = [];
        for (const p of points) {
          const popup = el(
            'div',
            { class: 'map-popup' },
            p.thumb ? el('img', { src: p.thumb, alt: '' }) : null,
            el('button', { type: 'button', class: 'link', text: p.title || 'Se bidraget', onclick: () => (location.hash = `#bidrag/${p.submissionId}`) }),
          );
          markers.push(L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#1d8a74', fillOpacity: 0.9 }).bindPopup(popup).addTo(map));
        }
        if (markers.length) map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2), { maxZoom: 16 });
      })
      .catch((err) => console.warn('map', err));
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        startMap();
      }
    }, { rootMargin: '300px' });
    io.observe($('#map'));
  } else startMap();

  init();
})();

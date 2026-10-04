'use strict';

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  // ------------------------------------------------------------------ sprog (dansk er standard)
  const I = window.I18N;
  let lang = (() => {
    const q = new URLSearchParams(location.search).get('lang');
    if (q && I.LANGS[q]) return q;
    try {
      const saved = localStorage.getItem('silo-lang');
      if (saved && I.LANGS[saved]) return saved;
    } catch {}
    return 'da';
  })();
  let fmtDate;
  let fmtNum;
  function setFormatters() {
    fmtDate = new Intl.DateTimeFormat(I.LOCALE[lang], { day: 'numeric', month: 'long', year: 'numeric' });
    fmtNum = new Intl.NumberFormat(I.LOCALE[lang]);
  }
  setFormatters();

  function t(key, vars = {}) {
    const str = (I.TEXT[lang] && I.TEXT[lang][key]) || I.TEXT.da[key] || key;
    return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }
  const relLabel = (k) => (k ? t(`rel.${k}`) : '');
  const perLabel = (k) => (k ? t(`per.${k}`) : '');
  // Workeren sender { code, params, error }. Oversæt ud fra code; brug den danske tekst som reserve.
  function errText(data) {
    if (!data || !data.code) return data && data.error;
    const key = `e.${data.code}`;
    if (!I.TEXT.da[key]) return data.error;
    const params = { ...(data.params || {}) };
    if (params.field) params.field = t(`field.${params.field}`);
    return t(key, params);
  }

  // Faste tekster: den danske udgave står i HTML'en og gemmes første gang, så vi kan skifte tilbage.
  const ORIGINAL = new Map();
  const ORIGINAL_TITLE = document.title;
  function remember(node, attr) {
    const k = attr || 'html';
    if (!ORIGINAL.has(node)) ORIGINAL.set(node, {});
    const o = ORIGINAL.get(node);
    if (!(k in o)) o[k] = attr ? node.getAttribute(attr) : node.innerHTML;
    return o[k];
  }
  function translated(key) {
    if (lang === 'da') return null;
    return (I.STATIC[lang] && I.STATIC[lang][key]) || (I.TEXT[lang] && I.TEXT[lang][key]) || null;
  }
  function applyStatic() {
    document.documentElement.lang = lang;
    document.title = translated('doc.title') || ORIGINAL_TITLE;
    for (const node of $$('[data-i18n]')) {
      const da = remember(node);
      node.innerHTML = translated(node.dataset.i18n) ?? da;
    }
    for (const [sel, attr] of [['[data-i18n-ph]', 'placeholder'], ['[data-i18n-aria]', 'aria-label'], ['[data-i18n-alt]', 'alt']]) {
      for (const node of $$(sel)) {
        const da = remember(node, attr);
        node.setAttribute(attr, translated(node.getAttribute(`data-${sel.slice(6, -1)}`)) ?? da);
      }
    }
    fillConfigTexts();
    for (const sel of $$('select[data-options]')) {
      for (const opt of sel.options) if (opt.value) opt.textContent = sel.dataset.options === 'relations' ? relLabel(opt.value) : perLabel(opt.value);
    }
    const picker = $('#lang');
    if (picker) picker.value = lang;
  }

  function fillConfigTexts() {
    $$('[data-cfg=maxFiles]').forEach((n) => (n.textContent = config.maxFiles));
    $$('[data-cfg=maxFileGb]').forEach((n) => (n.textContent = fmtNum.format(Math.round((config.maxFileMb / 1024) * 10) / 10)));
    const line = $('#contact-line');
    if (line) {
      line.textContent = '';
      if (config.contactEmail) {
        const [before, after] = t('contact.line').split('{email}');
        line.append(before, el('a', { href: `mailto:${config.contactEmail}`, text: config.contactEmail }), after);
      } else {
        line.textContent = t('contact.none');
      }
    }
    for (const c of $$('.counter')) c.dispatchEvent(new Event('refresh'));
  }

  function setLang(next) {
    if (!I.LANGS[next] || next === lang) return;
    lang = next;
    try {
      localStorage.setItem('silo-lang', lang);
    } catch {}
    setFormatters();
    applyStatic();
    loadStats();
    loadFeed(true);
    updateGpsHint();
    if (viewer.open && current) openViewer(current, index);
    if (turnstileWidget !== null && window.turnstile) {
      window.turnstile.remove(turnstileWidget);
      turnstileWidget = null;
      turnstileToken = '';
      renderTurnstile();
    }
  }

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

  // API base URL: empty when the worker also serves the site, else set in config.js (GitHub Pages).
  const API = String((window.SILO_CONFIG && window.SILO_CONFIG.apiBase) || '').replace(/\/+$/, '');

  async function getJson(url, opts = {}) {
    const res = await fetch(API + url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errText(data) || t('err.http', { status: res.status }));
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
      for (const value of Object.keys(config[sel.dataset.options] || {})) sel.append(el('option', { value, text: value }));
    }
    for (const [name, max] of Object.entries(config.limits || {})) {
      const input = form.elements[name];
      if (input && input.setAttribute) input.setAttribute('maxlength', String(max));
    }
    for (const ta of $$('[data-counter]')) {
      const counter = el('small', { class: 'counter', 'aria-live': 'polite' });
      ta.after(counter);
      const upd = () => (counter.textContent = t('counter', { n: ta.value.length, max: ta.maxLength }));
      ta.addEventListener('input', upd);
      counter.addEventListener('refresh', upd);
      upd();
    }
    applyStatic();
    $('#lang').addEventListener('change', (e) => setLang(e.target.value));
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
      action: 'bidrag',
      language: lang,
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
        errors.push(t('file.notMedia', { name: file.name }));
        continue;
      }
      if (file.size === 0) {
        errors.push(t('file.empty', { name: file.name }));
        continue;
      }
      if (file.size > config.maxFileMb * 1024 * 1024) {
        errors.push(t('file.tooBig', { name: file.name, mb: fmtNum.format(config.maxFileMb) }));
        continue;
      }
      if (picked.some((p) => p.file.name === file.name && p.file.size === file.size && p.file.lastModified === file.lastModified)) continue;
      if (picked.length >= config.maxFiles) {
        errors.push(t('file.tooMany', { n: config.maxFiles }));
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
        el('button', { type: 'button', class: 'remove', 'aria-label': t('file.remove', { name: file.name }), text: '×', onclick: () => removeFile(entry) }),
      );
      picked.push(entry);
      fileList.append(entry.li);
      if (kind === 'image' || kind === 'video') checkGps(entry);
    }
    showError(errors.join(' '));
  }

  // Tell the uploader right away which files carry a GPS position (it will be public).
  async function checkGps(entry) {
    if (!(await hasGps(entry.file, entry.kind))) return;
    entry.gps = true;
    $('.size', entry.li).textContent += ' · 📍 GPS';
    updateGpsHint();
  }

  function updateGpsHint() {
    const n = picked.filter((p) => p.gps).length;
    const hint = $('#gps-hint');
    hint.textContent = n === 1 ? t('gps.one') : t('gps.many', { n });
    hint.hidden = n === 0;
  }

  // Cheap check, good enough for a heads-up (the server reads the real values):
  //   photos (JPEG/HEIC/…): parse the EXIF/TIFF header and look for the GPS IFD pointer (tag 0x8825)
  //   videos (MOV/MP4):     look for an ISO 6709 position string, e.g. "+55.0612+010.6160/",
  //                         in the first and last megabyte (where the metadata box lives)
  async function hasGps(file, kind) {
    try {
      const span = 1024 * 1024;
      const head = new Uint8Array(await file.slice(0, span).arrayBuffer());
      if (kind === 'image') return exifHasGps(head);
      const tail = file.size > 2 * span ? new Uint8Array(await file.slice(file.size - span).arrayBuffer()) : new Uint8Array();
      return [head, tail].some((buf) => /[+-]\d{2}\.\d{3,}[+-]\d{3}\.\d{3,}/.test(new TextDecoder('latin1').decode(buf)));
    } catch {
      return false;
    }
  }

  function exifHasGps(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i + 8 < buf.length; i++) {
      const le = buf[i] === 0x49 && buf[i + 1] === 0x49 && buf[i + 2] === 0x2a && buf[i + 3] === 0x00; // "II*\0"
      const be = buf[i] === 0x4d && buf[i + 1] === 0x4d && buf[i + 2] === 0x00 && buf[i + 3] === 0x2a; // "MM\0*"
      if (!le && !be) continue;
      const ifd = i + dv.getUint32(i + 4, le);
      if (ifd + 2 > buf.length) continue;
      const count = dv.getUint16(ifd, le);
      if (count === 0 || count > 300 || ifd + 2 + count * 12 > buf.length) continue;
      for (let e = 0; e < count; e++) if (dv.getUint16(ifd + 2 + e * 12, le) === 0x8825) return true;
    }
    return false;
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
    const credit = String(data.get('credit') || '').trim();
    if (!picked.length && story.length < 20) return showError(t('v.needContent'));
    if (credit.length < 2) {
      form.elements.credit.focus();
      return showError(t('v.needCredit'));
    }
    for (const [name, max] of Object.entries(config.limits || {})) {
      const v = String(data.get(name) || '');
      if (v.length > max) return showError(t('v.tooLong', { max }));
    }
    if (!data.get('consent')) return showError(t('v.consent'));
    // window.SILO_E2E sættes kun af den automatiske test (som serveren genkender på et hemmeligt token).
    if (config.turnstileSiteKey && !turnstileToken && !window.SILO_E2E) return showError(t('v.turnstile'));

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
        credit,
        showCredit: !!data.get('showCredit'),
        email: data.get('email'),
        contactOk: !!data.get('contactOk'),
        consent: !!data.get('consent'),
        website: data.get('website'),
        url: data.get('url'),
        phone: data.get('phone'),
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

      let msg = done.status === 'review' ? t('done.review') : t('done.published');
      if (done.pending) msg += done.pending === 1 ? t('done.pendingOne') : t('done.pendingMany', { n: done.pending });
      if (failures.length) msg += t(failures.length === 1 ? 'done.failedOne' : 'done.failedMany', { names: failures.join(', ') });
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
      showError(err.message || t('err.generic'));
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
    $('#gps-hint').hidden = true;
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
    $('#progress-title').textContent = t('progress.title', {
      files: entries.length === 1 ? t('files.one') : t('files.many', { n: entries.length }),
      size: formatSize(total),
    });
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
      xhr.open('PUT', API + url);
      xhr.setRequestHeader('x-upload-token', token);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(errText(data) || t('err.http', { status: xhr.status })), { fatal: xhr.status >= 400 && xhr.status < 500 && xhr.status !== 408 && xhr.status !== 429 }));
      };
      xhr.onerror = () => reject(new Error(t('err.network')));
      xhr.ontimeout = () => reject(new Error(t('err.timeout')));
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
      feed.append(el('p', { class: 'muted', text: t('feed.error', { msg: err.message }) }));
    }
  }

  function tile(c) {
    const first = c.items.find((i) => i.thumb) || c.items[0];
    const excerpt = c.story ? c.story.slice(0, 400) : '';
    const byline = [c.credit, relLabel(c.relation), c.period].filter(Boolean).join(' · ');
    let media = null;
    let body;
    if (first && first.thumb) {
      media = el(
        'div',
        { class: 'tile-media' },
        el('img', { src: first.thumb, alt: c.title || t('v.contribution'), loading: 'lazy', width: first.width || null, height: first.height || null }),
        first.kind === 'video' ? el('span', { class: 'play', 'aria-hidden': 'true', text: '▶' }) : null,
        c.items.length > 1 ? el('span', { class: 'badge', text: t('tile.files', { n: c.items.length }) }) : null,
      );
    } else if (first && first.kind === 'audio') {
      media = el('div', { class: 'tile-audio' }, el('span', { text: '🎙' }), el('span', { text: t('tile.audio', { d: formatDuration(first.duration) }) }));
    }
    if (!media && excerpt) {
      body = el(
        'div',
        { class: 'tile-quote' },
        el('p', { text: excerpt }),
        el(
          'div',
          { class: 'tile-body tile-body-quote' },
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
    return el('button', { type: 'button', class: 'tile', 'aria-label': `${t('tile.open')}${c.title ? `: ${c.title}` : ''}`, onclick: () => openViewer(c, 0) }, media, body);
  }

  function processingNote(c) {
    const files = c.processing === 1 ? t('files.one') : t('files.many', { n: c.processing });
    return c.processing ? el('p', { class: 'processing-note', text: t('tile.processing', { files }) }) : null;
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
    $('#viewer-title').textContent = c.title || (c.items.length ? t('v.contribution') : t('v.story'));
    $('#viewer-meta').textContent = [c.credit ? t('v.credit', { credit: c.credit }) : t('v.creditHidden'), c.publishedAt ? fmtDate.format(new Date(c.publishedAt)) : ''].filter(Boolean).join(' · ');
    $('#viewer-story').textContent = c.story || '';
    const strip = $('#viewer-strip');
    strip.textContent = '';
    if (c.items.length > 1) {
      c.items.forEach((it, n) =>
        strip.append(
          el('button', { type: 'button', 'aria-label': t('v.showFile', { n: n + 1 }), onclick: () => showItem(n) }, it.thumb ? el('img', { src: it.thumb, alt: '', loading: 'lazy' }) : KIND_ICON[it.kind]),
        ),
      );
    }
    showItem(i);
    renderShare(c);
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
      if (it.kind === 'image') box.append(el('img', { src: it.src, alt: c.title || t('v.image') }));
      else if (it.kind === 'video') box.append(el('video', { src: it.src, poster: it.poster, controls: true, playsinline: true, preload: 'metadata' }));
      else if (it.kind === 'audio') box.append(el('audio', { src: it.src, controls: true, preload: 'metadata' }));
      else if (it.kind === 'document')
        box.append(el('div', { class: 'doc' }, it.thumb ? el('img', { src: it.thumb, alt: '' }) : null, el('a', { class: 'btn btn-primary', href: it.src, target: '_blank', rel: 'noopener', text: t('v.openPdf') })));
      if (c.items.length > 1) {
        box.append(
          el('button', { type: 'button', class: 'nav prev', 'aria-label': t('v.prev'), text: '‹', onclick: () => showItem((n - 1 + c.items.length) % c.items.length) }),
          el('button', { type: 'button', class: 'nav next', 'aria-label': t('v.next'), text: '›', onclick: () => showItem((n + 1) % c.items.length) }),
        );
      }
    }
    $$('#viewer-strip button').forEach((b, k) => b.setAttribute('aria-current', String(k === n)));

    const facts = $('#viewer-facts');
    facts.textContent = '';
    const add = (k, v) => v && facts.append(el('dt', { text: k }), el('dd', { text: v }));
    add(t('f.when'), c.period);
    if (it) add(t('f.taken'), formatTaken(it.takenAt));
    add(t('f.where'), c.place);
    add(t('f.persp'), perLabel(c.perspective));
    add(t('f.relation'), relLabel(c.relation));
    if (it) {
      add(t('f.camera'), it.camera);
      if (it.duration) add(t('f.length'), formatDuration(it.duration));
      if (it.kind !== 'audio' && it.kind !== 'document') {
        const full = el('a', { href: it.full || it.src, target: '_blank', rel: 'noopener', text: it.kind === 'image' ? t('f.openFull') : t('f.openVideo') });
        facts.append(el('dt', { text: t('f.file') }), el('dd', {}, full));
      }
    }
    if (c.processing) add(t('f.note'), t('f.stillProcessing', { n: c.processing }));
    if (c.source) {
      // Krav i Creative Commons-licenser: kilde, licens (med link) og at materialet er ændret.
      const dd = el('dd', {});
      if (/^https:\/\//.test(c.source.url)) dd.append(el('a', { href: c.source.url, target: '_blank', rel: 'noopener', text: new URL(c.source.url).hostname.replace(/^www\./, '') }));
      facts.append(el('dt', { text: t('f.source') }), dd);
      const lic = el('dd', {});
      if (/^https?:\/\//.test(c.source.licenseUrl || '')) lic.append(el('a', { href: c.source.licenseUrl, target: '_blank', rel: 'noopener license', text: c.source.license }));
      else lic.textContent = c.source.license;
      lic.append(` · ${t('f.changed')}`);
      facts.append(el('dt', { text: t('f.license') }), lic);
    }
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
  // Delelinket peger på workerens /s/<id>, som giver et pænt forhåndsvisningskort på sociale medier.
  const shareUrl = (c) => (config.shareBase ? `${config.shareBase}${c.id}` : `${location.origin}${location.pathname}#bidrag/${c.id}`);

  function renderShare(c) {
    const box = $('#viewer-sharebar');
    box.textContent = '';
    const url = shareUrl(c);
    const title = c.title || t('share.title');
    const enc = encodeURIComponent;
    const link = (cls, label, href) => el('a', { class: `share-btn ${cls}`, href, target: '_blank', rel: 'noopener noreferrer', text: label });
    if (navigator.share) {
      box.append(el('button', { type: 'button', class: 'share-btn native', text: t('share.native'), onclick: () => navigator.share({ title, url }).catch(() => {}) }));
    }
    box.append(
      link('facebook', t('share.facebook'), `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`),
      link('x', t('share.x'), `https://twitter.com/intent/tweet?url=${enc(url)}&text=${enc(title)}`),
      link('whatsapp', t('share.whatsapp'), `https://wa.me/?text=${enc(`${title} ${url}`)}`),
      el('a', { class: 'share-btn email', href: `mailto:?subject=${enc(t('share.mailSubject'))}&body=${enc(`${title}\n${url}`)}`, text: t('share.email') }),
    );
  }

  $('#viewer-share').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(shareUrl(current));
      e.target.textContent = t('share.copied');
      setTimeout(() => (e.target.textContent = t('share.copy')), 2000);
    } catch {}
  });
  $('#viewer-report').addEventListener('click', async () => {
    const reason = prompt(t('report.prompt'));
    if (reason === null) return;
    try {
      await getJson(`/api/contributions/${current.id}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) });
      alert(t('report.thanks'));
    } catch (err) {
      alert(err.message);
    }
  });

  async function openFromHash() {
    const m = location.hash.match(/^#bidrag\/([\w-]+)/);
    if (!m) return;
    try {
      const cached = known.get(m[1]);
      // Brug ikke en gammel kopi, hvis filerne stadig var ved at blive gjort klar.
      const c = cached && !cached.processing ? cached : await getJson(`/api/contributions/${m[1]}`, { cache: 'reload' });
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
            el('button', { type: 'button', class: 'link', text: p.title || t('map.open'), onclick: () => (location.hash = `#bidrag/${p.submissionId}`) }),
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

  // Links til #privatliv (f.eks. "Læs mere" ved samtykket) folder afsnittet ud.
  function openPrivacy() {
    if (location.hash === '#privatliv') $('#privacy-details').open = true;
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href="#privatliv"]');
    if (a) $('#privacy-details').open = true;
  });
  window.addEventListener('hashchange', openPrivacy);
  openPrivacy();

  // "made with …": en tilfældig emoji hver gang (samme liste som gifshooter).
  const FUN = ['❤️', '💖', '💘', '💝', '💜', '🧡', '💛', '💚', '💙', '🩷', '✨', '🌈', '🦄', '🍩', '🪐', '🔥', '👾', '🎉', '🍄', '🌀', '🚀', '🛸', '🎨', '🍕', '🐙', '🦖', '🍭', '💾', '🕹️', '🪩'];
  $('#made-with').textContent = FUN[Math.floor(Math.random() * FUN.length)];

  init();
})();

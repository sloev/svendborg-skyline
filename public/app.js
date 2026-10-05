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
    renderActive();
    if (searchIndex) renderYears();
    if (view === 'insights') renderInsights();
    updateGpsHint();
    if (storyEditor) storyEditor.labels();
    renderDrafts();
    if (viewer.open && current) openViewer(current, index);
    if (turnstileWidget !== null && window.turnstile) {
      window.turnstile.remove(turnstileWidget);
      turnstileWidget = null;
      turnstileToken = '';
      renderTurnstile();
    }
  }

  let storyEditor = null;
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

  // Dato: EXIF-datoen fra filen først (med den skrevne dato i parentes, hvis den findes),
  // ellers den skrevne dato, ellers datoen for uploaden.
  function dateText(c, it) {
    const taken = it ? formatTaken(it.takenAt) : '';
    if (taken && c.period) return `${taken} (${c.period})`;
    return taken || c.period || formatTaken(c.publishedAt);
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
    storyEditor = Kit.editor(form.elements.story, t);
    applyStatic();
    renderDrafts();
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
      set('audio', s.audio);
      set('stories', s.stories);
      set('documents', s.documents);
    } catch {}
    loadArchive();
  }

  // Hele arkivet som PDF (bygges dagligt af en GitHub Action, kun når der er nyt).
  async function loadArchive() {
    try {
      const a = await getJson('/api/archive');
      if (!a.available || !/^https?:\/\//.test(a.url || '')) return;
      $('#archive-link').href = a.url;
      $('#archive-meta').textContent = t('archive.meta', { n: fmtNum.format(a.count || 0), size: formatSize(a.bytes || 0), date: formatTaken(a.generatedAt) });
      $('#archive-dl').hidden = false;
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

  // ------------------------------------------------------------------ nyt bidrag (ét ad gangen, i tre trin)

  const form = $('#share-form');
  const fileInput = $('#file');
  const drop = $('#drop');
  let formOpenedAt = Date.now();
  /** Det bidrag der er ved at blive udfyldt: { kind, file?, url?, gps? } */
  let draft = null;
  let step = 1;

  // Hvilke felter der vises for hver type, deres overskrift, og om de skal udfyldes.
  const FIELDS = {
    image: { title: 'q.title', story: 'q.story.visual', period: 'q.period.visual', place: 'q.place', perspective: 'q.persp', relation: 'q.relation' },
    video: { title: 'q.title', story: 'q.story.visual', period: 'q.period.visual', place: 'q.place', perspective: 'q.persp', relation: 'q.relation' },
    audio: { title: 'q.title', story: 'q.story.audio', period: 'q.period.audio', relation: 'q.relation' },
    document: { title: 'q.title', story: 'q.story.document', period: 'q.period.document', relation: 'q.relation' },
    story: { title: 'q.title', story: 'q.story.story', period: 'q.period.story', relation: 'q.relation' },
  };
  const REQUIRED = { image: [], video: [], audio: ['title'], document: ['title'], story: ['story'] };

  // Husk ophavsret, e-mail og afkrydsninger til næste bidrag (kun i denne browser).
  const REMEMBER = ['credit', 'email', 'showCredit', 'contactOk'];
  function loadRemembered() {
    try {
      const saved = JSON.parse(localStorage.getItem('silo-ophavsret') || '{}');
      for (const k of REMEMBER) {
        const input = form.elements[k];
        if (!input || saved[k] === undefined) continue;
        if (input.type === 'checkbox') input.checked = !!saved[k];
        else input.value = saved[k];
      }
    } catch {}
  }
  function saveRemembered() {
    try {
      const out = {};
      for (const k of REMEMBER) out[k] = form.elements[k].type === 'checkbox' ? form.elements[k].checked : form.elements[k].value.trim();
      localStorage.setItem('silo-ophavsret', JSON.stringify(out));
    } catch {}
  }

  // Åbn formularen – tom, eller med en gemt kladde.
  function openForm(saved = null) {
    resetDraft();
    form.reset();
    loadRemembered();
    storyEditor.setMarkdown('');
    formOpenedAt = Date.now();
    draftId = saved ? saved.id : newId();
    if (saved) {
      for (const k of DRAFT_FIELDS) {
        const input = form.elements[k];
        if (!input || saved.fields[k] === undefined) continue;
        // Tomme felter i kladden overskriver ikke den huskede kreditering/e-mail.
        if (REMEMBER.includes(k) && input.type !== 'checkbox' && !saved.fields[k]) continue;
        if (input.type === 'checkbox') input.checked = !!saved.fields[k];
        else input.value = saved.fields[k];
      }
      storyEditor.setMarkdown(saved.fields.story || '');
      if (saved.kind) {
        draft = { kind: saved.kind };
        if (saved.file) {
          const file = saved.file instanceof File ? saved.file : new File([saved.file], saved.fileName || 'fil', { type: saved.fileType || '', lastModified: saved.fileLastModified || Date.now() });
          setDraftFile(file, saved.kind);
        } else if (saved.fileName) {
          draft.missing = { name: saved.fileName, size: saved.fileSize };
        }
      }
    }
    $('#new-item-row').hidden = true;
    form.hidden = false;
    renderDrafts();
    goStep(saved ? (saved.kind && (!draft.missing || saved.kind === 'story') ? Math.max(2, saved.step || 2) : 1) : 1);
    if (draft && draft.missing) showError(t('drafts.fileMissing'));
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Luk formularen. Arbejdet er allerede gemt som kladde.
  async function closeForm() {
    await saveDraftNow();
    resetDraft();
    draftId = null;
    form.hidden = true;
    $('#new-item-row').hidden = false;
    showError('');
    renderDrafts();
  }

  function resetDraft() {
    if (draft && draft.url) URL.revokeObjectURL(draft.url);
    draft = null;
    fileInput.value = '';
  }

  // ------------------------------------------------------------------ kladder på enheden

  const Kit = window.SiloKit;
  const DRAFT_FIELDS = ['title', 'story', 'period', 'place', 'perspective', 'relation', 'credit', 'showCredit', 'email', 'contactOk'];
  let draftId = null;
  let saveTimer = null;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function collectDraft() {
    const fields = {};
    for (const k of DRAFT_FIELDS) {
      const input = form.elements[k];
      fields[k] = input.type === 'checkbox' ? input.checked : input.value;
    }
    const file = draft && draft.file;
    return {
      id: draftId,
      kind: draft ? draft.kind : null,
      step,
      fields,
      file: file || null,
      fileName: file ? file.name : draft && draft.missing ? draft.missing.name : '',
      fileType: file ? file.type : '',
      fileSize: file ? file.size : draft && draft.missing ? draft.missing.size : 0,
      fileLastModified: file ? file.lastModified : 0,
      status: 'draft',
    };
  }

  // Er der noget værd at gemme? (Ophavsret alene tæller ikke – den huskes i forvejen.)
  const worthSaving = (d) => d.kind || ['title', 'story', 'period', 'place'].some((k) => String(d.fields[k] || '').trim());

  async function saveDraftNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (form.hidden || !draftId) return;
    const d = collectDraft();
    if (!worthSaving(d)) return;
    await Kit.drafts.save(d);
    const note = $('#draft-status');
    note.textContent = t('drafts.autosaved');
    note.hidden = false;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraftNow, 600);
  }
  form.addEventListener('input', scheduleSave);
  form.addEventListener('change', scheduleSave);
  // Gem også når siden skjules (fanen lukkes, telefonen låses osv.).
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveDraftNow());
  window.addEventListener('pagehide', () => saveDraftNow());

  async function renderDrafts() {
    const list = (await Kit.drafts.all()).filter((d) => d.id !== draftId && !uploads.some((u) => u.draftId === d.id && (u.state === 'queued' || u.state === 'uploading')));
    const box = $('#drafts');
    const ul = $('#draft-list');
    ul.textContent = '';
    box.hidden = list.length === 0;
    for (const d of list) {
      const name = d.fields.title || d.fileName || Kit.plain(d.fields.story).slice(0, 60) || t('drafts.untitled');
      const notes = [t('drafts.saved', { time: new Date(d.updatedAt).toLocaleString(I.LOCALE[lang], { dateStyle: 'short', timeStyle: 'short' }) })];
      if (d.status === 'sending' || d.status === 'failed') notes.push(t('drafts.unsent'));
      if (d.fileMissing) notes.push(t('drafts.fileMissingShort'));
      ul.append(
        el(
          'li',
          { class: 'draft-item' },
          el('span', { class: 'upload-icon', text: d.kind === 'story' || !d.kind ? '✍️' : KIND_ICON[d.kind] }),
          el('div', { class: 'upload-main' }, el('strong', { text: name }), el('span', { class: 'upload-status', text: notes.join(' · ') })),
          el('button', {
            type: 'button',
            class: 'btn btn-small',
            text: t('drafts.continue'),
            onclick: async () => {
              if (!form.hidden) await closeForm();
              openForm(await Kit.drafts.get(d.id));
            },
          }),
          el('button', {
            type: 'button',
            class: 'link danger',
            text: t('drafts.delete'),
            onclick: async () => {
              if (!confirm(t('drafts.deleteConfirm'))) return;
              await Kit.drafts.remove(d.id);
              renderDrafts();
            },
          }),
        ),
      );
    }
  }

  function goStep(n) {
    step = n;
    showError('');
    for (const sec of $$('.step', form)) sec.hidden = Number(sec.dataset.step) !== n;
    for (const li of $$('.steps li', form)) {
      const k = Number(li.dataset.step);
      li.classList.toggle('active', k === n);
      li.classList.toggle('done', k < n);
    }
    if (n === 2) renderFields();
    else $('#prefill-note').hidden = true;
    if (draftId) scheduleSave();
    if (n === 3) {
      if (turnstileWidget === null) renderTurnstile();
      const credit = form.elements.credit;
      if (!credit.value) setTimeout(() => credit.focus(), 50);
    }
  }

  function pickFile(file) {
    const kind = kindOf(file);
    if (!kind) return showError(t('file.notMedia', { name: file.name }));
    if (file.size === 0) return showError(t('file.empty', { name: file.name }));
    if (file.size > config.maxFileMb * 1024 * 1024) return showError(t('file.tooBig', { name: file.name, mb: fmtNum.format(config.maxFileMb) }));
    resetDraft();
    setDraftFile(file, kind);
    prefill(file, kind);
    goStep(2);
    saveDraftNow();
  }

  function setDraftFile(file, kind) {
    draft = { kind, file };
    if ((kind === 'image' && /^image\/(jpeg|png|gif|webp|avif)$/.test(file.type)) || (kind === 'video' && file.size < 600 * 1024 * 1024)) {
      draft.url = URL.createObjectURL(file);
    }
    if (kind === 'image' || kind === 'video') {
      hasGps(file, kind).then((gps) => {
        if (draft && draft.file === file && gps) {
          draft.gps = true;
          if (step === 2) renderPicked();
        }
      });
    }
  }

  // Foreslå overskrift og beskrivelse ud fra filnavnet og filens egne oplysninger (EXIF/XMP, ID3,
  // MP4, PDF). Udfylder kun tomme felter – det, man selv har skrevet, overskrives aldrig.
  async function prefill(file, kind) {
    const meta = await Kit.readMeta(file, kind);
    if (!draft || draft.file !== file) return;
    const title = form.elements.title;
    if (meta.title && !title.value.trim()) title.value = meta.title;
    if (meta.description && !form.elements.story.value.trim()) storyEditor.setMarkdown(meta.description);
    if (meta.title || meta.description) {
      const note = $('#prefill-note');
      note.hidden = false;
      scheduleSave();
    }
  }

  function renderPicked() {
    const box = $('#picked');
    box.textContent = '';
    if (!draft) return;
    let preview = el('div', { class: 'picked-thumb', text: draft.kind === 'story' ? '✍️' : KIND_ICON[draft.kind] });
    if (draft.url && draft.kind === 'image') preview = el('img', { class: 'picked-thumb', src: draft.url, alt: '' });
    if (draft.url && draft.kind === 'video') preview = el('video', { class: 'picked-thumb', src: `${draft.url}#t=0.5`, muted: true, preload: 'metadata', playsinline: true });
    box.append(
      preview,
      el(
        'div',
        { class: 'picked-info' },
        el('strong', { text: t(`kind.${draft.kind}`) }),
        draft.file ? el('span', { class: 'muted', text: `${draft.file.name} · ${formatSize(draft.file.size)}${draft.gps ? ' · 📍 GPS' : ''}` }) : null,
        el('button', { type: 'button', class: 'link', text: t('btn.changeFile'), onclick: () => goStep(1) }),
      ),
    );
  }

  function renderFields() {
    renderPicked();
    const kind = draft ? draft.kind : 'story';
    const fields = FIELDS[kind];
    for (const box of $$('[data-field]', form)) {
      const name = box.dataset.field;
      if (name === 'gps') {
        box.hidden = !(kind === 'image' || kind === 'video');
        continue;
      }
      box.hidden = !fields[name];
      if (!fields[name]) continue;
      $('[data-label]', box).textContent = t(fields[name]);
      const required = REQUIRED[kind].includes(name);
      $('.req-star', box).hidden = !required;
      const input = $('input, textarea, select', box);
      input.required = required;
    }
    storyEditor.labels();
  }

  // Tjek felterne i et trin. Returnerer en fejltekst eller ''.
  function validateStep(n) {
    const kind = draft ? draft.kind : 'story';
    if (n === 2) {
      for (const name of REQUIRED[kind]) {
        const input = form.elements[name];
        const v = input.value.trim();
        if (name === 'story' && v.length < 20) return (storyEditor.focus(), t('v.storyShort'));
        if (!v) return (input.focus(), t('v.required'));
      }
      for (const [name, max] of Object.entries(config.limits || {})) {
        const input = form.elements[name];
        if (input && input.value && input.value.length > max) return t('v.tooLong', { max });
      }
    }
    if (n === 3) {
      if (form.elements.credit.value.trim().length < 2) return (form.elements.credit.focus(), t('v.needCredit'));
      if (!form.elements.consent.checked) return t('v.consent');
      // window.SILO_E2E sættes kun af den automatiske test (som serveren genkender på et hemmeligt token).
      if (config.turnstileSiteKey && !turnstileToken && !window.SILO_E2E) return t('v.turnstile');
    }
    return '';
  }

  $('#new-item').addEventListener('click', () => openForm());
  for (const b of $$('[data-cancel]', form)) b.addEventListener('click', closeForm);
  for (const b of $$('[data-back]', form)) b.addEventListener('click', () => goStep(step - 1));
  for (const b of $$('[data-next]', form)) {
    b.addEventListener('click', () => {
      const err = validateStep(step);
      if (err) return showError(err);
      goStep(step + 1);
    });
  }
  $('#story-only').addEventListener('click', () => {
    resetDraft();
    draft = { kind: 'story' };
    goStep(2);
    setTimeout(() => storyEditor.focus(), 50);
    saveDraftNow();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) pickFile(fileInput.files[0]);
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
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files[0]) pickFile(files[0]);
  });

  // Fortæl med det samme, hvis filen har en GPS-placering (den bliver offentlig).
  //   billeder (JPEG/HEIC/…): læs EXIF/TIFF-hovedet og led efter GPS-pegeren (tag 0x8825)
  //   video (MOV/MP4):        led efter en ISO 6709-position, f.eks. "+55.0612+010.6160/",
  //                           i den første og sidste megabyte (hvor metadata ligger)
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

  // Bruges stadig ved sprogskift.
  function updateGpsHint() {
    if (!form.hidden && step === 2) renderFields();
    renderUploads();
  }

  function showError(msg) {
    const box = $('#form-error');
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  // ------------------------------------------------------------------ send + upload i baggrunden

  /** Indsendte bidrag i denne session: { title, kind, size, sent, state, error, id, review } */
  const uploads = [];
  let queue = Promise.resolve();
  let wakeLock = null;
  const busy = () => uploads.some((u) => u.state === 'queued' || u.state === 'uploading');

  window.addEventListener('beforeunload', (e) => {
    if (busy()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = validateStep(3);
    if (err) return showError(err);
    showError('');
    const d = new FormData(form);
    const kind = draft ? draft.kind : 'story';
    const btn = $('#submit');
    btn.disabled = true;
    try {
      const payload = {
        title: d.get('title'),
        story: String(d.get('story') || '').trim(),
        period: d.get('period'),
        place: FIELDS[kind].place ? d.get('place') : '',
        perspective: FIELDS[kind].perspective ? d.get('perspective') : '',
        relation: d.get('relation'),
        credit: String(d.get('credit') || '').trim(),
        showCredit: !!d.get('showCredit'),
        email: d.get('email'),
        contactOk: !!d.get('contactOk'),
        consent: !!d.get('consent'),
        website: d.get('website'),
        url: d.get('url'),
        phone: d.get('phone'),
        elapsedMs: Date.now() - formOpenedAt,
        turnstileToken,
        files: draft && draft.file ? [{ name: draft.file.name, size: draft.file.size, type: draft.file.type, lastModified: draft.file.lastModified }] : [],
      };
      // Bidraget oprettes med det samme (Turnstile-tokenet gælder kun kort); filen sendes i baggrunden.
      const sub = await getJson('/api/submissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      saveRemembered();
      // Kladden beholdes, indtil filen er helt sendt – så går intet tabt, hvis siden lukkes undervejs.
      const sentDraft = { ...collectDraft(), status: 'sending' };
      await Kit.drafts.save(sentDraft);
      const entry = {
        title: payload.title || (draft && draft.file ? draft.file.name : payload.story.slice(0, 60)),
        kind,
        file: draft && draft.file,
        size: draft && draft.file ? draft.file.size : 0,
        sent: 0,
        state: 'queued',
        error: '',
        id: sub.id,
        draftId,
      };
      uploads.unshift(entry);
      queue = queue.then(() => runUpload(entry, sub));
      draft = null; // filen ejes nu af upload-køen
      fileInput.value = '';
      draftId = null;
      form.hidden = true;
      $('#new-item-row').hidden = false;
      renderDrafts();
      renderUploads();
      $('#uploads').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      showError(err.message || t('err.generic'));
    } finally {
      btn.disabled = false;
      if (turnstileWidget !== null && window.turnstile) {
        window.turnstile.reset(turnstileWidget);
        turnstileToken = '';
      }
    }
  });

  async function runUpload(entry, sub) {
    entry.state = 'uploading';
    renderUploads();
    try {
      if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    } catch {}
    try {
      if (entry.file) {
        let last = 0;
        await uploadFile(sub, sub.items[0].id, entry.file, (bytes) => {
          entry.sent = bytes;
          if (Date.now() - last > 250) {
            last = Date.now();
            renderUploads();
          }
        });
      }
      const done = await getJson(`/api/submissions/${sub.id}/complete`, { method: 'POST', headers: { 'x-upload-token': sub.uploadToken } });
      entry.state = 'done';
      entry.review = done.status === 'review';
      entry.file = null;
      await Kit.drafts.remove(entry.draftId);
      loadStats(true);
      loadFeed(true, true);
    } catch (err) {
      console.error(err);
      entry.state = 'failed';
      entry.error = err.message || t('err.generic');
      const saved = await Kit.drafts.get(entry.draftId);
      if (saved) await Kit.drafts.save({ ...saved, status: 'failed' });
    }
    renderDrafts();
    if (!busy() && wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    renderUploads();
  }

  function renderUploads() {
    $('#uploads').hidden = uploads.length === 0;
    $('#uploads-warning').hidden = !busy();
    const list = $('#upload-list');
    list.textContent = '';
    for (const u of uploads) {
      const pct = u.size ? Math.min(100, Math.floor((u.sent / u.size) * 100)) : u.state === 'done' ? 100 : 0;
      const status =
        u.state === 'queued' ? t('up.queued') :
        u.state === 'uploading' ? (u.size ? t('up.uploading', { pct }) : t('up.sending')) :
        u.state === 'done' ? (u.review ? t('up.doneReview') : t('up.done')) :
        t('up.failed', { msg: u.error });
      list.append(
        el(
          'li',
          { class: `upload-item ${u.state}` },
          el('span', { class: 'upload-icon', text: u.kind === 'story' ? '✍️' : KIND_ICON[u.kind] }),
          el(
            'div',
            { class: 'upload-main' },
            el('strong', { text: u.title }),
            el('span', { class: 'upload-status', text: status }),
            u.state === 'uploading' || u.state === 'queued' ? el('div', { class: 'bar' }, el('div', { style: null, 'data-pct': pct })) : null,
          ),
          u.state === 'done' && !u.review ? el('a', { class: 'link', href: `#bidrag/${u.id}`, text: t('up.view') }) : null,
        ),
      );
    }
    for (const bar of $$('.upload-item .bar > div', list)) bar.style.width = `${bar.dataset.pct}%`;
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
  let hasMore = false;
  let feedIds = null; // ved søgning: de bidrag (id'er), der passer, i samme rækkefølge som feedet
  let chunk = 0;
  const CHUNK = 90; // så mange id'er kan workeren tage i ét kald
  let feedToken = 0;
  const known = new Map();

  async function loadFeed(reset, fresh = false) {
    const token = ++feedToken;
    if (reset) cancelAutoMore();
    if (reset) {
      cursor = null;
      chunk = 0;
      feedIds = matchingIds();
      feed.textContent = '';
      for (let i = 0; i < 4; i++) feed.append(el('div', { class: 'tile skeleton' }));
    }
    const qs = new URLSearchParams({ limit: '24' });
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    if (years && !years.none) {
      qs.set('from', String(years.from));
      qs.set('to', String(years.to));
    }
    if (feedIds) qs.set('ids', feedIds.slice(chunk * CHUNK, (chunk + 1) * CHUNK).join(','));
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
      hasMore = !!cursor;
      if (!cursor && feedIds && (chunk + 1) * CHUNK < feedIds.length) {
        chunk++;
        hasMore = true;
      }
      moreBtn.hidden = !hasMore;
      $('#feed-empty').hidden = feed.children.length > 0;
    } catch (err) {
      if (token !== feedToken) return;
      feed.textContent = '';
      feed.append(el('p', { class: 'muted', text: t('feed.error', { msg: err.message }) }));
    }
  }

  function tile(c) {
    const first = c.items.find((i) => i.thumb) || c.items[0];
    const excerpt = c.story ? window.SiloKit.plain(c.story).slice(0, 400) : '';
    const byline = [c.credit, relLabel(c.relation), dateText(c, c.items.find((i) => i.takenAt))].filter(Boolean).join(' · ');
    let media = null;
    let body;
    let slideAt = () => 0; // hvilken fil karrusellen står på, når man åbner bidraget
    const slides = c.items.filter((i) => i.thumb);
    if (slides.length > 1) {
      ({ media, slideAt } = carousel(c, slides));
    } else if (first && first.thumb) {
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
    // Et div med role=button (ikke <button>), så karrusellens pile kan være rigtige knapper.
    const open = () => openViewer(c, c.items.indexOf(slides[slideAt()]) > -1 ? c.items.indexOf(slides[slideAt()]) : 0);
    return el(
      'div',
      {
        class: 'tile', role: 'button', tabindex: '0', 'aria-label': `${t('tile.open')}${c.title ? `: ${c.title}` : ''}`,
        onclick: (e) => !e.target.closest('.car-nav') && open(),
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), open()),
      },
      media,
      body,
    );
  }

  // Bidrag med flere billeder: stryg (eller brug pilene) for at se dem i kortet.
  function carousel(c, slides) {
    const f = slides[0];
    const track = el(
      'div',
      { class: 'car-track' },
      slides.map((it, k) =>
        el(
          'div',
          { class: 'car-slide' },
          el('img', { src: it.thumb, alt: k === 0 ? c.title || t('v.contribution') : '', loading: 'lazy', draggable: 'false' }),
          it.kind === 'video' ? el('span', { class: 'play', 'aria-hidden': 'true', text: '▶' }) : null,
        ),
      ),
    );
    // Kortets højde følger det første billede (sat via CSSOM, da CSP ikke tillader style-attributter).
    if (f.width && f.height) track.style.aspectRatio = `${f.width} / ${f.height}`;
    const badge = el('span', { class: 'badge', text: `1/${slides.length}` });
    const dots = el('div', { class: 'car-dots', 'aria-hidden': 'true' }, slides.map((_, k) => el('span', { class: k === 0 ? 'on' : '' })));
    const at = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    const go = (d) => track.scrollTo({ left: (at() + d) * track.clientWidth, behavior: 'smooth' });
    track.addEventListener('scroll', () => {
      const k = Math.min(slides.length - 1, Math.max(0, at()));
      badge.textContent = `${k + 1}/${slides.length}`;
      [...dots.children].forEach((d, j) => d.classList.toggle('on', j === k));
    }, { passive: true });
    const media = el(
      'div',
      { class: 'tile-media car' },
      track,
      el('button', { type: 'button', class: 'car-nav prev', 'aria-label': t('v.prev'), text: '‹', onclick: (e) => (e.stopPropagation(), go(-1)) }),
      el('button', { type: 'button', class: 'car-nav next', 'aria-label': t('v.next'), text: '›', onclick: (e) => (e.stopPropagation(), go(1)) }),
      badge,
      dots,
    );
    return { media, slideAt: () => Math.min(slides.length - 1, Math.max(0, at())) };
  }

  function processingNote(c) {
    const files = c.processing === 1 ? t('files.one') : t('files.many', { n: c.processing });
    return c.processing ? el('p', { class: 'processing-note', text: t('tile.processing', { files }) }) : null;
  }

  // Uendelig rulning: når "Vis flere" kommer til syne, vises en indikator i 5 sekunder (så man kan
  // nå at læse sidefoden), og så hentes de næste bidrag. Ruller man væk, afbrydes nedtællingen.
  const moreLoading = $('#more-loading');
  const AUTO_MORE_MS = 5000;
  let moreTimer = null;
  let loadingMore = false;
  function cancelAutoMore() {
    clearTimeout(moreTimer);
    moreTimer = null;
    if (!loadingMore) moreLoading.hidden = true;
  }
  async function loadMore() {
    cancelAutoMore();
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    moreLoading.hidden = false;
    moreLoading.classList.add('busy');
    try {
      await loadFeed(false);
    } finally {
      loadingMore = false;
      moreLoading.hidden = true;
      moreLoading.classList.remove('busy', 'counting');
      // Står knappen stadig synlig (få bidrag på skærmen), starter næste nedtælling.
      if (moreObserver && !moreBtn.hidden) {
        moreObserver.unobserve(moreBtn);
        moreObserver.observe(moreBtn);
      }
    }
  }
  const moreObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || moreBtn.hidden || loadingMore) return cancelAutoMore();
      if (moreTimer) return;
      moreLoading.hidden = false;
      moreLoading.classList.remove('counting');
      void moreLoading.offsetWidth; // genstart animationen
      moreLoading.classList.add('counting');
      moreTimer = setTimeout(() => {
        moreTimer = null;
        loadMore();
      }, AUTO_MORE_MS);
    })
    : null;
  if (moreObserver) moreObserver.observe(moreBtn);
  moreBtn.addEventListener('click', () => loadMore());
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

  // ------------------------------------------------------------------ søgning og årstal
  // Søgeindekset (/api/search-index) er en lille, færdigbygget fil med alle offentlige bidrag
  // (id, titel, årstal, filtyper) og de navne, der er knyttet til dem. Al søgning sker i browseren;
  // feedet hentes derefter med ?ids=… (og ?from=…&to=… for årstal).

  const ENT_ICON = { person: '👤', ship: '🚢', building: '🏛️', company: '🏭', place: '📍', vehicle: '🚂', event: '📅', post: '📝', year: '🗓️', text: '🔎' };
  const KIND_LETTER = { image: 'i', video: 'v', audio: 'a', document: 'd', story: 's' };
  const fold = (x) =>
    String(x || '').toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  let searchIndex = null;
  let indexPromise = null;
  let search = null; // { type, label, ids: [indeks i searchIndex.posts] }
  let years = null; // { from, to } eller { none: true }
  let anchor = null; // første tryk i årstalsvælgeren

  function loadIndex() {
    indexPromise ||= getJson('/api/search-index')
      .then((ix) => {
        for (const p of ix.posts) p.f = fold(p[1]);
        for (const e of ix.entities) e.f = fold(e[1]);
        searchIndex = ix;
        renderYears();
        return ix;
      })
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
    return indexPromise;
  }

  // Bidragene, der passer til søgningen, årstallene og filtypen (så tomme sider undgås).
  function matchingIds() {
    if (!searchIndex || (!search && !(years && years.none))) return null;
    const P = searchIndex.posts;
    const letter = KIND_LETTER[filters.kind];
    const base = search ? search.ids : P.map((_, n) => n);
    return [...new Set(base)]
      .filter((n) => {
        const p = P[n];
        if (!p || (letter && !p[4].includes(letter))) return false;
        if (years && years.none) return p[2] == null;
        if (years) return p[2] != null && p[3] >= years.from && p[2] <= years.to;
        return true;
      })
      .sort((a, b) => a - b)
      .map((n) => P[n][0]);
  }

  const words = (f) => f.split(' ');
  const matches = (f, toks) => {
    const w = words(f);
    return toks.every((tk) => w.some((x) => x.startsWith(tk)));
  };

  function suggestions(q) {
    const out = [];
    const raw = q.trim();
    let m;
    if ((m = raw.match(/^(1[6-9]\d\d|20\d\d)\s*[-–]\s*(1[6-9]\d\d|20\d\d)$/))) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      out.push({ type: 'year', label: `${a}–${b}`, years: { from: a, to: b } });
    } else if ((m = raw.match(/^(1[6-9]\d|20\d)(\d)?(?:['’]?(?:erne|s|er))?$/))) {
      const d = Number(m[1]) * 10;
      if (m[2] !== undefined) {
        const y = d + Number(m[2]);
        out.push({ type: 'year', label: t('search.year', { y }), years: { from: y, to: y } });
      }
      out.push({ type: 'year', label: t('search.decade', { d }), years: { from: d, to: d + 9 } });
    }
    const toks = fold(raw).split(' ').filter(Boolean);
    if (!toks.length || !searchIndex) return out;
    const ents = searchIndex.entities
      .filter((e) => matches(e.f, toks))
      .sort((a, b) => Number(b.f.startsWith(toks[0])) - Number(a.f.startsWith(toks[0])) || b[2].length - a[2].length)
      .slice(0, 8);
    for (const e of ents) out.push({ type: e[0], label: e[1], ids: e[2] });
    const posts = [];
    searchIndex.posts.forEach((p, n) => matches(p.f, toks) && posts.push(n));
    if (posts.length > 1) out.push({ type: 'text', label: t('search.title', { q: raw }), ids: posts, chip: raw });
    for (const n of posts.slice(0, 4)) out.push({ type: 'post', label: searchIndex.posts[n][1], id: searchIndex.posts[n][0] });
    return out;
  }

  const qInput = $('#q');
  const qList = $('#q-list');
  let sugg = [];
  let active = -1;

  function showSuggestions() {
    const q = qInput.value;
    sugg = q.trim() ? suggestions(q) : [];
    active = -1;
    qList.textContent = '';
    if (!q.trim()) return closeSuggestions();
    if (!sugg.length) qList.append(el('li', { class: 'search-none', text: searchIndex ? t('search.none') : '…' }));
    sugg.forEach((s, k) =>
      qList.append(
        el(
          'li',
          { role: 'option', id: `q-opt-${k}`, 'aria-selected': 'false', onmousedown: (e) => e.preventDefault(), onclick: () => choose(s) },
          el('span', { class: 'search-ic', 'aria-hidden': 'true', text: ENT_ICON[s.type] || '🔎' }),
          el('span', { class: 'search-name', text: s.label }),
          el('span', { class: 'search-type', text: s.ids ? `${t(`ent.${s.type}`)} · ${new Set(s.ids).size}` : t(`ent.${s.type}`) }),
        ),
      ),
    );
    qList.hidden = false;
    qInput.setAttribute('aria-expanded', 'true');
  }
  function closeSuggestions() {
    qList.hidden = true;
    qInput.setAttribute('aria-expanded', 'false');
    qInput.removeAttribute('aria-activedescendant');
  }
  function moveActive(d) {
    if (!sugg.length) return;
    active = (active + d + sugg.length) % sugg.length;
    $$('li[role=option]', qList).forEach((li, k) => li.setAttribute('aria-selected', String(k === active)));
    qInput.setAttribute('aria-activedescendant', `q-opt-${active}`);
    $(`#q-opt-${active}`).scrollIntoView({ block: 'nearest' });
  }

  function choose(s) {
    closeSuggestions();
    qInput.value = '';
    if (s.type === 'post') {
      location.hash = `#bidrag/${s.id}`;
      return;
    }
    if (s.years) {
      setYears(s.years);
      return;
    }
    search = { type: s.type, label: s.chip || s.label, ids: s.ids };
    applyFilters();
  }

  function setYears(y) {
    years = y;
    anchor = null;
    applyFilters();
  }

  function applyFilters() {
    if (!search && location.hash.startsWith('#find/')) history.replaceState(null, '', '#bidrag');
    renderActive();
    renderYears();
    loadFeed(true);
  }

  function renderActive() {
    const box = $('#active-filters');
    box.textContent = '';
    const chip = (icon, label, n, clear) =>
      box.append(
        el(
          'button',
          { type: 'button', class: 'active-chip', 'aria-label': `${label} – ${t('search.clear')}`, onclick: clear },
          el('span', { 'aria-hidden': 'true', text: icon }),
          el('span', { text: label }),
          n !== null ? el('span', { class: 'muted', text: `· ${t('search.n', { n })}` }) : null,
          el('span', { class: 'x', 'aria-hidden': 'true', text: '✕' }),
        ),
      );
    if (search) chip(ENT_ICON[search.type] || '🔎', search.label, new Set(search.ids).size, () => ((search = null), applyFilters()));
    if (years) chip('🗓️', years.none ? t('years.none', { n: '' }).trim() : yearsLabel(years), null, () => setYears(null));
    box.hidden = !box.children.length;
  }
  const yearsLabel = (y) => (y.from === y.to ? String(y.from) : y.to - y.from === 9 && y.from % 10 === 0 ? t('search.decade', { d: y.from }) : `${y.from}–${y.to}`);

  // Årtier som et lille søjlediagram: tryk på et årti, og på et andet for en periode.
  function renderYears() {
    const box = $('#years');
    const bars = $('#years-bars');
    if (!searchIndex) return;
    const P = searchIndex.posts;
    const dated = P.filter((p) => p[2] != null);
    if (!dated.length) return;
    const lo = Math.floor(Math.min(...dated.map((p) => p[2])) / 10) * 10;
    const hi = Math.floor(Math.max(...dated.map((p) => p[3])) / 10) * 10;
    const counts = [];
    for (let d = lo; d <= hi; d += 10) counts.push([d, dated.filter((p) => p[3] >= d && p[2] <= d + 9).length]);
    const max = Math.max(...counts.map((c) => c[1]), 1);
    bars.textContent = '';
    for (const [d, n] of counts) {
      const on = years && !years.none && d + 9 >= years.from && d <= years.to;
      const bar = el('span', { class: 'bar' });
      bar.style.height = `${n ? Math.max(6, Math.round((n / max) * 100)) : 0}%`;
      bars.append(
        el(
          'button',
          {
            type: 'button', class: `yr${d % 100 === 0 ? ' century' : ''}${anchor === d ? ' anchor' : ''}`, 'aria-pressed': String(!!on),
            title: `${t('search.decade', { d })}: ${t('search.n', { n })}`, 'aria-label': `${t('search.decade', { d })}: ${t('search.n', { n })}`,
            onclick: () => pickDecade(d),
          },
          el('span', { class: 'bar-wrap' }, bar),
          el('span', { class: 'yr-label', text: d % 100 === 0 || d === lo ? String(d) : `’${String(d).slice(2)}` }),
        ),
      );
    }
    const none = P.length - dated.length;
    const head = $('.years-head', box);
    $$('.yr-none', head).forEach((x) => x.remove());
    head.append(
      el('button', { type: 'button', class: 'yr-none', 'aria-pressed': String(!!(years && years.none)), onclick: () => setYears(years && years.none ? null : { none: true }), text: t('years.none', { n: none }) }),
    );
    $('#years-toggle').hidden = false;
  }

  // Årstalsvælgeren er foldet sammen, så feedet ikke skubbes ned; et valgt årstal står som chip.
  $('#years-toggle').addEventListener('click', (e) => {
    const open = $('#years').hidden;
    $('#years').hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  function pickDecade(d) {
    if (anchor !== null && anchor !== d) {
      const [a, b] = [Math.min(anchor, d), Math.max(anchor, d)];
      return setYears({ from: a, to: b + 9 });
    }
    if (years && !years.none && years.from === d && years.to === d + 9) return setYears(null);
    years = { from: d, to: d + 9 };
    anchor = d;
    renderActive();
    renderYears();
    loadFeed(true);
  }

  // Et navn i fremviseren: vis alle bidrag, hvor det optræder.
  async function showEntity(type, name) {
    try {
      const ix = await loadIndex();
      const e = ix.entities.find((x) => x[0] === type && x[1] === name);
      if (!e) return;
      search = { type, label: name, ids: e[2] };
      if (viewer.open) viewer.close();
      applyFilters();
      $('#bidrag').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.warn(err);
    }
  }

  // ------------------------------------------------------------------ visninger: arkivet og indsigt
  // #indsigt viser siden med navne og downloads; alle andre adresser viser arkivet.
  // #find/<type>/<navn> viser arkivet filtreret på et navn (kan deles som link).

  const ENT_ORDER = ['building', 'ship', 'company', 'person', 'place', 'vehicle', 'event'];
  let view = 'archive';
  let insType = 'building';

  function setView(v) {
    if (v === view) return false;
    view = v;
    document.body.classList.toggle('view-insights', v === 'insights');
    $$('.topbar nav a[href="#indsigt"]').forEach((a) => (v === 'insights' ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    if (v === 'archive') window.dispatchEvent(new Event('resize')); // kortet skal måle sig selv igen
    return true;
  }

  function route() {
    const h = location.hash;
    if (h === '#indsigt') {
      setView('insights');
      window.scrollTo(0, 0);
      renderInsights();
      return;
    }
    const changed = setView('archive');
    const m = h.match(/^#find\/(\w+)\/(.+)$/);
    if (m) {
      showEntity(m[1], decodeURIComponent(m[2]));
      return;
    }
    // Kom man fra indsigt, var målet skjult, da browseren prøvede at rulle til det.
    if (changed && h.length > 1 && !h.startsWith('#bidrag/')) {
      try {
        const target = document.getElementById(decodeURIComponent(h.slice(1)));
        if (target) target.scrollIntoView();
      } catch {}
    } else if (changed && !h) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  async function renderInsights() {
    const list = $('#ins-list');
    const tabs = $('#ins-tabs');
    let ix;
    try {
      ix = await loadIndex();
    } catch {
      list.textContent = t('search.loadErr');
      return;
    }
    const P = ix.posts;
    const photosOf = (ids) => ids.reduce((sum, n) => sum + (P[n] ? P[n][5] || 0 : 0), 0);
    const stats = $('#ins-stats');
    stats.textContent = '';
    const stat = (n, label) => stats.append(el('div', {}, el('dt', { text: label }), el('dd', { text: fmtNum.format(n) })));
    stat(P.length, t('ins.stat.posts'));
    stat(photosOf(P.map((_, n) => n)), t('ins.stat.photos'));
    stat(ix.entities.length, t('ins.stat.names'));
    stat(P.filter((p) => p[2] != null).length, t('ins.stat.dated'));

    const byType = Object.fromEntries(ENT_ORDER.map((ty) => [ty, ix.entities.filter((e) => e[0] === ty)]));
    if (!byType[insType].length) insType = ENT_ORDER.find((ty) => byType[ty].length) || insType;
    tabs.textContent = '';
    for (const ty of ENT_ORDER) {
      if (!byType[ty].length) continue;
      tabs.append(
        el(
          'button',
          { type: 'button', role: 'tab', 'aria-selected': String(ty === insType), 'aria-pressed': String(ty === insType), onclick: () => ((insType = ty), renderInsights()) },
          `${ENT_ICON[ty]} ${t(`ents.${ty}`)} `,
          el('span', { class: 'n', text: byType[ty].length }),
        ),
      );
    }
    const rows = byType[insType]
      .map((e) => ({ e, photos: photosOf(e[2]), posts: e[2].length }))
      .sort((a, b) => b.photos - a.photos || b.posts - a.posts || a.e[1].localeCompare(b.e[1], 'da'));
    const max = Math.max(1, ...rows.map((r) => Math.max(r.photos, r.posts)));
    list.textContent = '';
    for (const { e, photos, posts } of rows) {
      const meter = el('span', { class: 'meter', 'aria-hidden': 'true' });
      meter.style.width = `${Math.round((Math.max(photos, posts) / max) * 100)}%`;
      list.append(
        el(
          'li',
          {},
          el(
            'a',
            { href: `#find/${e[0]}/${encodeURIComponent(e[1])}` },
            meter,
            el('span', { class: 'ins-name', text: e[1] }),
            el('span', { class: 'ins-count', text: [photos ? t('ins.photos', { n: photos }) : '', t('search.n', { n: posts })].filter(Boolean).join(' · ') }),
          ),
        ),
      );
    }
  }

  // Svæveknap til toppen, når man er rullet et stykke ned.
  const toTop = $('#to-top');
  const showTop = () => toTop.classList.toggle('on', window.scrollY > window.innerHeight * 1.2);
  window.addEventListener('scroll', showTop, { passive: true });
  showTop();
  toTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    $('.brand').focus({ preventScroll: true });
  });

  qInput.addEventListener('focus', () => loadIndex().then(() => qInput.value && showSuggestions()).catch(() => {}));
  qInput.addEventListener('input', showSuggestions);
  qInput.addEventListener('blur', () => setTimeout(closeSuggestions, 100));
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), qList.hidden ? showSuggestions() : moveActive(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), moveActive(-1));
    else if (e.key === 'Escape') closeSuggestions();
    else if (e.key === 'Enter') {
      e.preventDefault();
      const s = sugg[active] || sugg.find((x) => x.type !== 'post') || sugg[0];
      if (s) choose(s);
    }
  });
  $('#export-link').href = `${API}/api/export`;
  loadIndex().catch(() => {});
  route();

  // ------------------------------------------------------------------ viewer

  const viewer = $('#viewer');
  let current = null;
  let index = 0;

  function openViewer(c, i) {
    current = c;
    $('#viewer-title').textContent = c.title || (c.items.length ? t('v.contribution') : t('v.story'));
    $('#viewer-meta').textContent = [c.credit ? t('v.credit', { credit: c.credit }) : t('v.creditHidden'), c.publishedAt ? fmtDate.format(new Date(c.publishedAt)) : ''].filter(Boolean).join(' · ');
    window.SiloKit.render(c.story || '', $('#viewer-story'));
    const tags = $('#viewer-tags');
    tags.textContent = '';
    const ents = Array.isArray(c.entities) ? c.entities : [];
    if (ents.length) tags.append(el('span', { class: 'muted', text: t('v.mentions') }));
    for (const [type, name] of ents) {
      tags.append(el('button', { type: 'button', class: 'tag', title: t(`ent.${type}`), onclick: () => showEntity(type, name) }, el('span', { 'aria-hidden': 'true', text: ENT_ICON[type] || '•' }), ` ${name}`));
    }
    tags.hidden = !ents.length;
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
    loadComments(c);
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
    add(t('f.when'), dateText(c, it));
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

  // Stryg til siden i fremviseren for at skifte billede.
  {
    let x0 = null;
    let y0 = 0;
    const media = $('#viewer-media');
    media.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || e.target.closest('video, audio')) return (x0 = null);
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    }, { passive: true });
    media.addEventListener('touchend', (e) => {
      if (x0 === null || !current || current.items.length < 2) return;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const n = current.items.length;
      showItem(dx < 0 ? (index + 1) % n : (index - 1 + n) % n);
    }, { passive: true });
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

  // ------------------------------------------------------------------ kommentarer
  //
  // Spambeskyttelse (se også workeren): når man begynder at skrive, hentes en billet fra serveren,
  // og browseren løser en lille regneopgave (proof of work) i baggrunden. Turnstile vises først nu.
  // Kommentarer vises, når en admin har godkendt dem.

  const cForm = $('#comment-form');
  let cState = null; // { subId, ticket, minAgeMs, issuedAt, nonce: Promise<string> }
  let cWidget = null;
  let cToken = '';

  async function loadComments(c) {
    const box = $('#comments');
    box.hidden = !config.comments || config.comments === 'closed';
    if (box.hidden) return;
    if (!cState || cState.subId !== c.id) {
      cState = { subId: c.id };
      cForm.elements.body.value = '';
      cForm.elements.body.dispatchEvent(new Event('input'));
      showCommentError('');
      $('#comment-status').textContent = '';
    }
    try {
      cForm.elements.name.value ||= localStorage.getItem('silo-navn') || '';
    } catch {}
    const list = $('#comment-list');
    try {
      const { comments } = await getJson(`/api/contributions/${c.id}/comments`, { cache: 'no-store' });
      if (current !== c) return;
      list.textContent = '';
      for (const cm of comments) list.append(commentItem(cm));
      $('#comment-count').textContent = comments.length ? `(${fmtNum.format(comments.length)})` : '';
      $('#comment-empty').hidden = comments.length > 0;
    } catch {
      list.textContent = '';
    }
  }

  function commentItem(cm) {
    return el(
      'li',
      { class: 'comment' },
      el('div', { class: 'comment-head' }, el('strong', { text: cm.name }), ' ', el('time', { datetime: cm.createdAt, class: 'muted', text: formatTaken(cm.createdAt) })),
      el('p', { class: 'comment-body', text: cm.body }),
      el('button', {
        type: 'button',
        class: 'link danger small',
        text: t('cm.report'),
        onclick: async (e) => {
          if (!confirm(t('cm.reportConfirm'))) return;
          try {
            await getJson(`/api/comments/${cm.id}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            e.target.replaceWith(el('span', { class: 'muted small', text: t('report.thanks') }));
          } catch (err) {
            alert(err.message);
          }
        },
      }),
    );
  }

  function showCommentError(msg) {
    $('#comment-error').textContent = msg || '';
    $('#comment-error').hidden = !msg;
  }

  // Billet + proof of work startes, så snart man går i gang med at skrive.
  function startCommentWork() {
    if (!cState || cState.nonce) return;
    const st = cState;
    st.nonce = (async () => {
      const tk = await getJson(`/api/comments/ticket?submission=${encodeURIComponent(st.subId)}`, { cache: 'no-store' });
      Object.assign(st, { ticket: tk.ticket, minAgeMs: tk.minAgeMs, issuedAt: Date.now() });
      return solvePow(tk.ticket, tk.zeros, st);
    })();
    st.nonce.catch(() => {});
    renderCommentTurnstile();
  }

  async function solvePow(ticket, zeros, st) {
    const enc = new TextEncoder();
    const full = Math.floor(zeros / 2);
    const ok = (b) => {
      for (let i = 0; i < full; i++) if (b[i] !== 0) return false;
      return zeros % 2 === 0 || b[full] >> 4 === 0;
    };
    for (let n = 0; n < 1e9; n += 256) {
      if (cState !== st) throw new Error('cancelled');
      const batch = await Promise.all(Array.from({ length: 256 }, (_, k) => crypto.subtle.digest('SHA-256', enc.encode(`${ticket}:${n + k}`))));
      const hit = batch.findIndex((buf) => ok(new Uint8Array(buf)));
      if (hit >= 0) return String(n + hit);
    }
    throw new Error('pow');
  }

  function renderCommentTurnstile(tries = 0) {
    if (!config.turnstileSiteKey || cWidget !== null) return;
    if (!window.turnstile) {
      if (tries < 100) setTimeout(() => renderCommentTurnstile(tries + 1), 150);
      return;
    }
    cWidget = window.turnstile.render('#comment-turnstile', {
      sitekey: config.turnstileSiteKey,
      action: 'kommentar',
      language: lang,
      appearance: 'interaction-only',
      callback: (tok) => (cToken = tok),
      'expired-callback': () => (cToken = ''),
      'error-callback': () => (cToken = ''),
    });
  }

  // Kun rigtige tastetryk/fokus (ikke når siden selv nulstiller feltet).
  cForm.addEventListener('focusin', (e) => e.isTrusted && startCommentWork());
  cForm.addEventListener('input', (e) => e.isTrusted && startCommentWork());

  cForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showCommentError('');
    const name = cForm.elements.name.value.trim();
    const body = cForm.elements.body.value.trim();
    if (name.length < 2) return showCommentError(t('e.name_missing'));
    if (body.length < 3) return showCommentError(t('e.comment_short'));
    if (config.turnstileSiteKey && !cToken && !window.SILO_E2E) return showCommentError(t('v.turnstile'));
    startCommentWork();
    const st = cState;
    const btn = $('#comment-send');
    btn.disabled = true;
    $('#comment-status').textContent = t('cm.checking');
    try {
      const nonce = await st.nonce;
      // Billetten skal have en vis alder (bots sender med det samme).
      const wait = st.issuedAt + st.minAgeMs + 300 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const res = await getJson(`/api/contributions/${st.subId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          body,
          ticket: st.ticket,
          nonce,
          turnstileToken: cToken,
          website: cForm.elements.website.value,
          email: cForm.elements.email.value,
        }),
      });
      try {
        localStorage.setItem('silo-navn', name);
      } catch {}
      cForm.elements.body.value = '';
      cForm.elements.body.dispatchEvent(new Event('input'));
      $('#comment-status').textContent = res.status === 'published' ? t('cm.thanks') : t('cm.thanksPending');
      if (res.status === 'published' && current) loadComments(current);
    } catch (err) {
      $('#comment-status').textContent = '';
      showCommentError(err.message === 'cancelled' ? '' : err.message);
    } finally {
      btn.disabled = false;
      // Hver billet og hvert Turnstile-svar kan kun bruges én gang.
      if (cState === st) cState = { subId: st.subId };
      cToken = '';
      if (cWidget !== null && window.turnstile) window.turnstile.reset(cWidget);
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
        // Én nål pr. bidrag og sted (flere billeder fra samme sted giver ellers nåle oven i hinanden).
        const groups = new Map();
        for (const p of points) {
          const key = `${p.submissionId}:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
          if (!groups.has(key)) groups.set(key, { ...p, count: 0, thumb: null });
          const g = groups.get(key);
          g.count++;
          g.thumb = g.thumb || p.thumb;
        }
        const markers = [];
        for (const p of groups.values()) {
          const open = () => (location.hash = `#bidrag/${p.submissionId}`);
          const popup = el(
            'div',
            { class: 'map-popup' },
            p.thumb ? el('img', { src: p.thumb, alt: '', loading: 'lazy', onclick: open }) : el('div', { class: 'map-popup-icon', text: KIND_ICON[p.kind] || '📍' }),
            el('strong', { class: 'map-popup-title', text: p.title || t('map.open') }),
            p.period ? el('span', { class: 'map-popup-meta', text: p.period }) : null,
            p.excerpt ? el('p', { class: 'map-popup-text', text: p.excerpt }) : null,
            el('button', { type: 'button', class: 'btn btn-primary map-popup-more', text: `${t('map.more')} →`, onclick: open }),
          );
          markers.push(
            L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#1d8a74', fillOpacity: 0.9 })
              .bindPopup(popup, { maxWidth: 240, minWidth: 200 })
              .bindTooltip(p.title || '', { direction: 'top', offset: [0, -6] })
              .addTo(map),
          );
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

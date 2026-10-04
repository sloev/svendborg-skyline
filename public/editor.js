'use strict';

// Hjælpere til formularen:
//   - en simpel tekst-editor (fed, kursiv, overskrift, lister, links), der gemmer som Markdown
//   - visning af den Markdown som rigtige elementer (aldrig innerHTML, så intet kan sprøjtes ind)
//   - udtræk af titel/beskrivelse fra filnavn og metadata (EXIF/XMP, ID3, MP4, PDF)
//   - kladder gemt i browserens IndexedDB, så intet halvfærdigt arbejde går tabt

window.SiloKit = (() => {
  // ------------------------------------------------------------------ Markdown → elementer

  const INLINE = /\*\*(.+?)\*\*|\*(?!\s)(.+?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

  function inline(text, parent) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1] !== undefined) {
        const b = document.createElement('strong');
        inline(m[1], b);
        parent.append(b);
      } else if (m[2] !== undefined) {
        const i = document.createElement('em');
        inline(m[2], i);
        parent.append(i);
      } else {
        const a = document.createElement('a');
        a.href = m[4];
        a.target = '_blank';
        a.rel = 'noopener nofollow ugc';
        a.textContent = m[3];
        parent.append(a);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(md, container) {
    container.textContent = '';
    let list = null;
    for (const raw of String(md || '').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if ((m = /^#{1,6}\s+(.*)$/.exec(line))) {
        list = null;
        const h = document.createElement('h4');
        inline(m[1], h);
        container.append(h);
      } else if ((m = /^[-*•]\s+(.*)$/.exec(line))) {
        if (!list || list.tagName !== 'UL') container.append((list = document.createElement('ul')));
        const li = document.createElement('li');
        inline(m[1], li);
        list.append(li);
      } else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) {
        if (!list || list.tagName !== 'OL') container.append((list = document.createElement('ol')));
        const li = document.createElement('li');
        inline(m[1], li);
        list.append(li);
      } else if (line.trim() === '') {
        list = null;
      } else {
        list = null;
        const p = document.createElement('p');
        inline(line, p);
        container.append(p);
      }
    }
  }

  // Ren tekst (til uddrag og forhåndsvisninger).
  function plain(md) {
    return String(md || '')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(?!\s)(.+?)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[-*•]\s+/gm, '• ')
      .replace(/^(\d+)[.)]\s+/gm, '$1. ');
  }

  // ------------------------------------------------------------------ elementer → Markdown

  const BLOCK = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE']);

  function wrap(text, mark) {
    if (!text.trim()) return text;
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    return `${lead}${mark}${text.trim()}${mark}${trail}`;
  }

  function inlineMd(node) {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue.replace(/ /g, ' ').replace(/[*[\]]/g, '\\$&');
      else if (c.nodeType !== 1) continue;
      else if (c.tagName === 'BR') s += '\n';
      else if (c.tagName === 'B' || c.tagName === 'STRONG') s += wrap(inlineMd(c), '**');
      else if (c.tagName === 'I' || c.tagName === 'EM') s += wrap(inlineMd(c), '*');
      else if (c.tagName === 'A' && /^https?:\/\//.test(c.getAttribute('href') || '')) s += `[${inlineMd(c).trim()}](${c.getAttribute('href')})`;
      else s += inlineMd(c);
    }
    return s;
  }

  function toMarkdown(root) {
    const lines = [];
    let buffer = '';
    const flush = () => {
      if (buffer.trim()) lines.push(...buffer.split('\n').map((l) => l.trim()));
      buffer = '';
    };
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 1 && BLOCK.has(c.tagName)) {
          flush();
          if (/^H\d$/.test(c.tagName)) lines.push(`## ${inlineMd(c).trim()}`);
          else if (c.tagName === 'UL' || c.tagName === 'OL') {
            let n = 1;
            for (const li of c.children) if (li.tagName === 'LI') lines.push(`${c.tagName === 'UL' ? '-' : `${n++}.`} ${inlineMd(li).replace(/\n/g, ' ').trim()}`);
          } else if ([...c.childNodes].some((x) => x.nodeType === 1 && BLOCK.has(x.tagName))) walk(c);
          else {
            const text = inlineMd(c);
            lines.push(...(text.trim() ? text.split('\n').map((l) => l.trim()) : ['']));
          }
        } else {
          buffer += c.nodeType === 3 ? c.nodeValue.replace(/ /g, ' ').replace(/[*[\]]/g, '\\$&') : inlineMd({ childNodes: [c] });
        }
      }
      flush();
    };
    walk(root);
    // Escape-tegnene bruges kun for at undgå utilsigtet formatering; vis dem ikke.
    return lines.join('\n').replace(/\\([*[\]])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ------------------------------------------------------------------ editor

  function editor(textarea, t) {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'editor';
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    bar.setAttribute('role', 'toolbar');
    const area = document.createElement('div');
    area.className = 'editor-area';
    area.contentEditable = 'true';
    area.setAttribute('role', 'textbox');
    area.setAttribute('aria-multiline', 'true');

    const buttons = [
      ['bold', '<b>B</b>', () => document.execCommand('bold')],
      ['italic', '<i>I</i>', () => document.execCommand('italic')],
      ['heading', 'H', () => document.execCommand('formatBlock', false, /^h\d$/i.test(document.queryCommandValue('formatBlock')) ? 'p' : 'h3')],
      ['ul', '•', () => document.execCommand('insertUnorderedList')],
      ['ol', '1.', () => document.execCommand('insertOrderedList')],
      ['link', '🔗', () => {
        const url = prompt(t('ed.linkPrompt'), 'https://');
        if (url && /^https?:\/\/\S+$/.test(url)) document.execCommand('createLink', false, url);
      }],
    ];
    for (const [name, label, fn] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.cmd = name;
      b.innerHTML = label; // faste, egne tegn
      b.addEventListener('mousedown', (e) => e.preventDefault()); // bevar markeringen
      b.addEventListener('click', () => {
        area.focus();
        fn();
        sync();
      });
      bar.append(b);
    }

    function sync() {
      textarea.value = toMarkdown(area).slice(0, Number(textarea.maxLength) > 0 ? textarea.maxLength : 100000);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      area.classList.toggle('empty', !area.textContent.trim() && !area.querySelector('li'));
    }
    function labels() {
      for (const b of bar.children) b.setAttribute('aria-label', t(`ed.${b.dataset.cmd}`)), (b.title = t(`ed.${b.dataset.cmd}`));
      area.dataset.placeholder = textarea.placeholder || '';
      area.setAttribute('aria-label', textarea.closest('label')?.querySelector('[data-label]')?.textContent || '');
    }
    function setMarkdown(md) {
      render(md, area);
      for (const h of area.querySelectorAll('h4')) {
        const h3 = document.createElement('h3');
        h3.append(...h.childNodes);
        h.replaceWith(h3);
      }
      textarea.value = md || '';
      area.classList.toggle('empty', !String(md || '').trim());
    }

    area.addEventListener('input', sync);
    area.addEventListener('paste', (e) => {
      // Indsæt kun ren tekst (ingen skjult formatering fra Word, mails osv.).
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
    });
    // Klik på feltets overskrift skal sætte markøren i editoren.
    textarea.closest('label')?.addEventListener('click', (e) => {
      if (!wrapEl.contains(e.target)) {
        e.preventDefault();
        area.focus();
      }
    });

    textarea.hidden = true;
    textarea.after(wrapEl);
    wrapEl.append(bar, area);
    labels();
    setMarkdown(textarea.value);
    return { setMarkdown, labels, focus: () => area.focus(), area };
  }

  // ------------------------------------------------------------------ titel og beskrivelse fra filen

  const GENERIC_NAME = /^(img|dsc|dscn|dscf|dcim|pxl|vid|mvi|mov|gopr|gh\d|dji|pano|p\d{5,}|screenshot|skærmbillede|bildschirmfoto|whatsapp|signal|telegram|image|photo|foto|video|billede|bild|scan|scanned|document|dokument|audio|recording|optagelse|new recording|lyd|voice|memo|untitled|unavngivet|[a-f0-9-]{16,}|\d)/i;
  const GENERIC_TEXT = /^(olympus digital camera|sony dsc|digital camera|samsung|dcim|default|image|picture|photo|untitled|\s*|.{0,2})$/i;

  function titleFromName(name) {
    const base = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim();
    if (!base || GENERIC_NAME.test(base)) return '';
    const t = base.replace(/[_]+/g, ' ').replace(/\s*-\s*/g, ' – ').replace(/\s+/g, ' ').trim();
    if (!/[a-zæøåäöü]{3}/i.test(t)) return '';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  const good = (s) => {
    s = String(s || '').replace(/\0/g, '').replace(/\s+/g, ' ').trim();
    return s && !GENERIC_TEXT.test(s) ? s.slice(0, 2000) : '';
  };

  async function readMeta(file, kind) {
    const out = { title: titleFromName(file.name), description: '' };
    try {
      const span = 2 * 1024 * 1024;
      const head = new Uint8Array(await file.slice(0, span).arrayBuffer());
      const tail = file.size > 2 * span ? new Uint8Array(await file.slice(file.size - span).arrayBuffer()) : null;
      // Kilder i prioriteret rækkefølge; den første brugbare værdi vinder.
      let sources = [];
      if (kind === 'image') sources = [exifText(head), xmpText(head)];
      else if (kind === 'audio' || kind === 'video') sources = [id3Text(head), mp4Text(head), tail ? mp4Text(tail) : {}, xmpText(head)];
      else if (kind === 'document') sources = [tail ? pdfText(tail) : {}, pdfText(head), xmpText(head)];
      const first = (k) => sources.map((x) => good(x[k])).find(Boolean) || '';
      if (first('title')) out.title = first('title').slice(0, 120);
      out.description = first('description');
    } catch {}
    return out;
  }

  const latin1 = (buf) => new TextDecoder('latin1').decode(buf);
  const utf8 = (buf) => new TextDecoder('utf-8').decode(buf);
  const utf16 = (buf) => new TextDecoder('utf-16le').decode(buf);

  // EXIF: ImageDescription, XPTitle/XPComment/XPSubject (Windows) og UserComment.
  function exifText(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i + 8 < buf.length; i++) {
      const le = buf[i] === 0x49 && buf[i + 1] === 0x49 && buf[i + 2] === 0x2a && buf[i + 3] === 0;
      const be = buf[i] === 0x4d && buf[i + 1] === 0x4d && buf[i + 2] === 0 && buf[i + 3] === 0x2a;
      if (!le && !be) continue;
      const base = i;
      const out = {};
      const readIfd = (off, depth) => {
        if (depth > 2 || base + off + 2 > buf.length) return;
        const n = dv.getUint16(base + off, le);
        if (!n || n > 300) return;
        for (let e = 0; e < n; e++) {
          const p = base + off + 2 + e * 12;
          if (p + 12 > buf.length) return;
          const tag = dv.getUint16(p, le);
          const type = dv.getUint16(p + 2, le);
          const count = dv.getUint32(p + 4, le);
          const size = count * ([0, 1, 1, 2, 4, 8, 1, 1][type] || 1);
          const at = size > 4 ? base + dv.getUint32(p + 8, le) : p + 8;
          if (at + size > buf.length) continue;
          const data = buf.subarray(at, at + size);
          if (tag === 0x8769) readIfd(dv.getUint32(p + 8, le), depth + 1);
          else if (tag === 0x010e) out.description = out.description || utf8(data);
          else if (tag === 0x9c9b) out.title = utf16(data);
          else if (tag === 0x9c9c || tag === 0x9c9f) out.description = out.description || utf16(data);
          else if (tag === 0x9286 && size > 8) {
            const head = latin1(data.subarray(0, 8));
            out.description = out.description || (head.startsWith('UNICODE') ? (le ? utf16(data.subarray(8)) : new TextDecoder('utf-16be').decode(data.subarray(8))) : utf8(data.subarray(8)));
          }
        }
      };
      readIfd(dv.getUint32(base + 4, le), 0);
      if (out.title || out.description) return out;
    }
    return {};
  }

  // XMP (Lightroom, Google Fotos, Apple Fotos m.fl.): dc:title og dc:description.
  function xmpText(buf) {
    const s = utf8(buf);
    const pick = (tag) => {
      const m = new RegExp(`<dc:${tag}>[\\s\\S]*?<rdf:li[^>]*>([\\s\\S]*?)</rdf:li>`).exec(s);
      return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"') : '';
    };
    return { ...(pick('title') ? { title: pick('title') } : {}), ...(pick('description') ? { description: pick('description') } : {}) };
  }

  // MP3: ID3v2-felterne TIT2 (titel) og COMM (kommentar).
  function id3Text(buf) {
    if (latin1(buf.subarray(0, 3)) !== 'ID3') return {};
    const ver = buf[3];
    const size = ((buf[6] & 127) << 21) | ((buf[7] & 127) << 14) | ((buf[8] & 127) << 7) | (buf[9] & 127);
    const out = {};
    const dec = (enc, data) => (enc === 1 || enc === 2 ? new TextDecoder(enc === 2 ? 'utf-16be' : 'utf-16').decode(data) : enc === 3 ? utf8(data) : latin1(data));
    for (let p = 10; p + 10 < Math.min(buf.length, size + 10); ) {
      const id = latin1(buf.subarray(p, p + 4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = ver >= 4 ? ((buf[p + 4] & 127) << 21) | ((buf[p + 5] & 127) << 14) | ((buf[p + 6] & 127) << 7) | (buf[p + 7] & 127) : (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
      const data = buf.subarray(p + 10, p + 10 + len);
      if (id === 'TIT2') out.title = dec(data[0], data.subarray(1));
      if (id === 'TXXX' && data.length > 2) {
        const [desc, ...rest] = dec(data[0], data.subarray(1)).split('\0');
        const value = rest.join(' ').trim();
        if (/^(comment|description|beskrivelse|beschreibung)$/i.test(desc) && !out.description) out.description = value;
        if (/^title$/i.test(desc) && !out.title) out.title = value;
      }
      if (id === 'COMM' && data.length > 4) {
        const enc = data[0];
        const rest = data.subarray(4);
        const nul = enc === 1 || enc === 2 ? rest.findIndex((b, i) => i % 2 === 0 && b === 0 && rest[i + 1] === 0) : rest.indexOf(0);
        out.description = dec(enc, rest.subarray(nul >= 0 ? nul + (enc === 1 || enc === 2 ? 2 : 1) : 0));
      }
      p += 10 + len;
    }
    return out;
  }

  // MP4/MOV/M4A: ©nam (titel), ©cmt og desc (beskrivelse).
  function mp4Text(buf) {
    const out = {};
    const find = (atom) => {
      const bytes = [...atom].map((c) => (c === '©' ? 0xa9 : c.charCodeAt(0)));
      for (let i = 4; i + 24 < buf.length; i++) {
        if (buf[i] === bytes[0] && buf[i + 1] === bytes[1] && buf[i + 2] === bytes[2] && buf[i + 3] === bytes[3]) {
          if (latin1(buf.subarray(i + 8, i + 12)) !== 'data') continue;
          const dataSize = (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
          if (dataSize < 16 || i + 4 + dataSize > buf.length) continue;
          return utf8(buf.subarray(i + 20, i + 4 + dataSize));
        }
      }
      return '';
    };
    let title = find('©nam');
    let desc = find('desc') || find('©cmt');
    // Nyere format (iPhone m.fl.): navnene står i 'keys', værdierne i 'ilst' med 1-baseret indeks.
    if (!title || !desc) {
      const k = latin1(buf).indexOf('keys');
      if (k > 4) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const names = [];
        let p = k + 12;
        const count = dv.getUint32(k + 8);
        for (let n = 0; n < count && p + 8 < buf.length; n++) {
          const size = dv.getUint32(p);
          if (size < 8 || p + size > buf.length) break;
          names.push(latin1(buf.subarray(p + 8, p + size)));
          p += size;
        }
        const ilst = latin1(buf).indexOf('ilst', p);
        if (ilst > 0) {
          const end = Math.min(buf.length, ilst - 4 + dv.getUint32(ilst - 4));
          for (let q = ilst + 4; q + 24 < end; ) {
            const size = dv.getUint32(q);
            const idx = dv.getUint32(q + 4);
            if (size < 24 || q + size > end) break;
            const name = (names[idx - 1] || '').replace(/^com\.apple\.quicktime\./, '');
            const value = utf8(buf.subarray(q + 24, q + size));
            if (name === 'title' && !title) title = value;
            if (/^(description|comment)$/.test(name) && !desc) desc = value;
            q += size;
          }
        }
      }
    }
    if (title) out.title = title;
    if (desc) out.description = desc;
    return out;
  }

  // PDF: /Title i dokumentinformationen.
  function pdfText(buf) {
    const s = latin1(buf);
    // Den sidste forekomst er den nyeste (PDF-rettelser lægges i slutningen af filen).
    const all = [...s.matchAll(/\/Title\s*(?:\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f]+)>)/g)];
    const last = all[all.length - 1];
    const m = last && (last[1] !== undefined ? [last[0], last[1]] : [last[0], last[2]]);
    if (!m) return {};
    let title = m[1];
    if (/^[0-9A-Fa-f]+$/.test(title) && title.length % 2 === 0 && m[0].includes('<')) {
      const bytes = new Uint8Array(title.match(/../g).map((h) => parseInt(h, 16)));
      title = bytes[0] === 0xfe && bytes[1] === 0xff ? new TextDecoder('utf-16be').decode(bytes.subarray(2)) : latin1(bytes);
    } else title = title.replace(/\\([()\\])/g, '$1');
    return { title };
  }

  // ------------------------------------------------------------------ kladder (IndexedDB på enheden)

  const MAX_FILE_IN_DRAFT = 1024 * 1024 * 1024; // større filer gemmes ikke i kladden (vælges igen)
  let dbPromise = null;
  function db() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('no indexedDB'));
    dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('silo-kladder', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('drafts', mode);
      const store = t.objectStore('drafts');
      const req = fn(store);
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  const drafts = {
    async all() {
      try {
        const list = await tx('readonly', (s) => s.getAll());
        return (list || []).sort((a, b) => b.updatedAt - a.updatedAt);
      } catch {
        return [];
      }
    },
    async get(id) {
      try {
        return await tx('readonly', (s) => s.get(id));
      } catch {
        return null;
      }
    },
    // Gemmer kladden; hvis filen er for stor eller der ikke er plads, gemmes resten uden filen.
    async save(draft) {
      const record = { ...draft, updatedAt: Date.now() };
      if (record.file && record.file.size > MAX_FILE_IN_DRAFT) {
        record.file = null;
        record.fileMissing = true;
      }
      try {
        await tx('readwrite', (s) => s.put(record));
      } catch {
        try {
          await tx('readwrite', (s) => s.put({ ...record, file: null, fileMissing: !!(draft.file || draft.fileName) }));
        } catch {}
      }
    },
    async remove(id) {
      try {
        await tx('readwrite', (s) => s.delete(id));
      } catch {}
    },
  };

  return { render, plain, toMarkdown, editor, readMeta, titleFromName, drafts };
})();

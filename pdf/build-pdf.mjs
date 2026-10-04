#!/usr/bin/env node
// Bygger hele arkivet som én PDF – alle offentlige bidrag med tekst, billeder, overskrifter,
// beskrivelser, datoer og øvrige felter – sorteret ældst først efter
//   1. datoen fra filernes metadata (EXIF), ellers
//   2. den skrevne dato ("sommeren 1987" → 1987), ellers
//   3. upload-datoen.
//
// Læser kun den offentlige API (/api/contributions), så der kommer aldrig skjulte oplysninger
// (e-mail, ikke-offentlig kreditering, testbidrag) med. Bygger kun, hvis indholdet har ændret sig
// siden sidste PDF (fingeraftryk i media/arkiv/info.json), medmindre FORCE=1.
//
// Køres dagligt af .github/workflows/pdf.yml. Repoet er offentligt, så logs er offentlige:
// der skrives kun antal og størrelser ud.
//
// Miljø: WORKER_URL, ADMIN_TOKEN, SITE_URL (valgfri), FORCE (valgfri), OUT (valgfri: gem kun lokalt),
//       CHECK_ONLY=1 (skriv kun changed=true/false til GITHUB_OUTPUT)

import { createHash } from 'node:crypto';
import { readFile, stat, open, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SITE_URL = (process.env.SITE_URL || 'https://sloev.github.io/svendborg-skyline/').replace(/\/*$/, '/');
const OUT = process.env.OUT || '';
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
// Hæves, når layoutet ændres, så PDF'en bygges igen, selv om indholdet er det samme.
const LAYOUT_VERSION = 1;
const PDF_KEY = 'media/arkiv/siloerne.pdf';
const INFO_KEY = 'media/arkiv/info.json';
const PART = 64 * 1024 * 1024;
const fmtDate = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric' });
const here = path.dirname(fileURLToPath(import.meta.url));

if (!WORKER_URL || (!ADMIN_TOKEN && !OUT && process.env.CHECK_ONLY !== '1')) {
  console.error('WORKER_URL og ADMIN_TOKEN skal være sat');
  process.exit(1);
}

// ---------------------------------------------------------------- data

const contributions = [];
for (let before = null; ; ) {
  const qs = new URLSearchParams({ limit: '60', ...(before ? { before } : {}) });
  const data = await getJson(`/api/contributions?${qs}`);
  contributions.push(...data.contributions);
  if (!data.next) break;
  before = data.next;
}

const fingerprint = createHash('sha256')
  .update(JSON.stringify({ v: LAYOUT_VERSION, c: contributions.map(({ processing, ...c }) => c) }))
  .digest('hex');
const current = await getJson('/api/archive').catch(() => ({}));
const changed = FORCE || !current.available || current.fingerprint !== fingerprint;
if (process.env.CHECK_ONLY === '1') {
  // Bruges af workflowet, så browseren kun installeres, når der faktisk skal bygges.
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed && contributions.length ? 'true' : 'false'}\n`);
  console.log(changed ? `Nyt indhold: ${contributions.length} bidrag.` : `Intet nyt siden ${current.generatedAt}.`);
  process.exit(0);
}
if (!changed && !OUT) {
  console.log(`Intet nyt siden ${current.generatedAt} – PDF'en er uændret.`);
  process.exit(0);
}
if (!contributions.length) {
  console.log('Ingen offentlige bidrag endnu – ingen PDF.');
  process.exit(0);
}

const sorted = contributions
  .map((c) => ({ ...c, sortKey: sortKey(c) }))
  .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.publishedAt.localeCompare(b.publishedAt));

// ---------------------------------------------------------------- render

const generatedAt = new Date();
const browser = await chromium.launch();
let pdf;
try {
  const page = await browser.newPage();
  await page.setContent(html(), { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: path.join(here, '..', 'public', 'editor.js') });
  await page.evaluate((list) => {
    for (const c of list) {
      const box = document.querySelector(`[data-story="${c.id}"]`);
      if (box && c.story) window.SiloKit.render(c.story, box);
    }
  }, sorted.map(({ id, story }) => ({ id, story })));
  // Vent på alle billeder; et billede, der ikke kan hentes, erstattes af en note.
  await page.evaluate(async () => {
    await Promise.all(
      [...document.images].map((img) =>
        img.complete && img.naturalWidth
          ? null
          : new Promise((done) => {
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', () => {
                img.replaceWith(Object.assign(document.createElement('p'), { className: 'missing', textContent: 'Billedet kunne ikke hentes.' }));
                done();
              }, { once: true });
            }),
      ),
    );
  });
  pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', bottom: '20mm', left: '18mm', right: '18mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      '<div style="width:100%;font:8px Helvetica,Arial,sans-serif;color:#777;padding:0 18mm;display:flex;justify-content:space-between">' +
      '<span>Siloerne på Østre Kaj · fælles arkiv</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    tagged: true,
    outline: true,
  });
} finally {
  await browser.close();
}

if (OUT) {
  await writeFile(OUT, pdf);
  console.log(`Gemt lokalt: ${sorted.length} bidrag, ${(pdf.length / 1048576).toFixed(1)} MB.`);
  process.exit(0);
}

const tmp = path.join(process.env.RUNNER_TEMP || '/tmp', 'siloerne.pdf');
await writeFile(tmp, pdf);
await upload(tmp, PDF_KEY, 'application/pdf');
const info = { generatedAt: generatedAt.toISOString(), count: sorted.length, bytes: pdf.length, fingerprint };
await putObject(INFO_KEY, Buffer.from(JSON.stringify(info)), 'application/json');
console.log(`PDF opdateret: ${sorted.length} bidrag, ${(pdf.length / 1048576).toFixed(1)} MB.`);

// ---------------------------------------------------------------- dates

function earliestTaken(c) {
  return c.items.map((i) => i.takenAt).filter(Boolean).sort()[0] || '';
}

// "sommeren 1987", "1980'erne", "21.6.1987", "1987-06-21" → sammenlignelig ISO-dato.
function periodDate(period) {
  if (!period) return '';
  let m = period.match(/\b(\d{1,2})[./-](\d{1,2})[./-](1[89]\d\d|20\d\d)\b/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = period.match(/\b(1[89]\d\d|20\d\d)-(\d{2})(?:-(\d{2}))?\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3] || '01'}`;
  m = period.match(/\b(1[89]\d\d|20\d\d)/);
  return m ? `${m[1]}-01-01` : '';
}

function sortKey(c) {
  return earliestTaken(c) || periodDate(c.period) || c.publishedAt || '';
}

function formatDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? v : fmtDate.format(d);
}

// Samme regel som på siden: EXIF-dato (med den skrevne dato i parentes), ellers skrevet dato, ellers upload-dato.
function dateText(c) {
  const taken = formatDate(earliestTaken(c));
  if (taken && c.period) return `${taken} (${c.period})`;
  return taken || c.period || formatDate(c.publishedAt);
}

function duration(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---------------------------------------------------------------- html

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function plainTitle(c) {
  if (c.title) return c.title;
  const text = String(c.story || '').replace(/[*#>\[\]()_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? (text.length > 70 ? `${text.slice(0, 69)}…` : text) : 'Et bidrag om siloerne';
}

function item(c, it) {
  const link = `${SITE_URL}#bidrag/${c.id}`;
  const facts = [];
  if (it.takenAt && it.takenAt !== earliestTaken(c)) facts.push(formatDate(it.takenAt));
  if (it.camera) facts.push(it.camera);
  if (it.lat != null && it.lon != null) facts.push(`${Number(it.lat).toFixed(5)}, ${Number(it.lon).toFixed(5)}`);
  if (it.kind === 'image') {
    return `<figure><img src="${esc(it.src)}" alt=""><figcaption>${esc(facts.join(' · '))}</figcaption></figure>`;
  }
  const label = { video: 'Video', audio: 'Lydoptagelse', document: 'Dokument' }[it.kind] || 'Fil';
  const verb = { video: 'Se den', audio: 'Hør den', document: 'Læs det' }[it.kind] || 'Se den';
  const pic = it.poster || it.thumb;
  return `<figure class="media ${esc(it.kind)}">${pic ? `<img src="${esc(pic)}" alt="">` : ''}
    <figcaption><strong>${label}${it.duration ? `, ${duration(it.duration)}` : ''}</strong>${facts.length ? ` · ${esc(facts.join(' · '))}` : ''}
    <br>${verb} på siden: <a href="${esc(link)}">${esc(link)}</a></figcaption></figure>`;
}

function article(c, n) {
  const rows = [
    ['Dato', dateText(c)],
    ['Sted', c.place],
    ['Perspektiv', c.perspectiveLabel],
    ['Tilknytning', c.relationLabel],
    ['Kreditering', c.credit],
  ].filter(([, v]) => v);
  const src = c.source;
  const link = `${SITE_URL}#bidrag/${c.id}`;
  return `<article>
  <p class="no">Nr. ${n}</p>
  <h2>${esc(plainTitle(c))}</h2>
  <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}
  ${src ? `<dt>Kilde</dt><dd><a href="${esc(src.url)}">${esc(src.url)}</a>${src.license ? ` · Licens: ${src.licenseUrl ? `<a href="${esc(src.licenseUrl)}">${esc(src.license)}</a>` : esc(src.license)}` : ''}</dd>` : ''}
  <dt>På siden</dt><dd><a href="${esc(link)}">${esc(link)}</a></dd>
  <dt>Lagt op</dt><dd>${esc(formatDate(c.publishedAt))}</dd></dl>
  ${c.story ? `<div class="story" data-story="${esc(c.id)}"></div>` : ''}
  ${c.items.map((it) => item(c, it)).join('\n')}
</article>`;
}

function html() {
  const first = sorted[0].sortKey.slice(0, 4);
  const last = sorted[sorted.length - 1].sortKey.slice(0, 4);
  return `<!doctype html><html lang="da"><head><meta charset="utf-8"><title>Siloerne på Østre Kaj – fælles arkiv</title>
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.5 Georgia, 'DejaVu Serif', 'Liberation Serif', serif; color: #1d1d1b; margin: 0; }
  a { color: #23527c; word-break: break-all; }
  .cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; break-after: page; }
  .cover .kicker { font: 600 10pt Helvetica, Arial, 'Liberation Sans', sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #8a5a2b; margin: 0; }
  .cover h1 { font-size: 34pt; line-height: 1.1; margin: 6mm 0; }
  .cover p { max-width: 140mm; }
  .cover .facts { font-family: Helvetica, Arial, 'Liberation Sans', sans-serif; font-size: 9.5pt; color: #555; }
  article { padding-top: 6mm; margin-top: 6mm; border-top: 0.6pt solid #c9c2b6; }
  article:first-of-type { border-top: 0; margin-top: 0; }
  .no { font: 600 8pt Helvetica, Arial, 'Liberation Sans', sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #8a5a2b; margin: 0; break-after: avoid; }
  h2 { font-size: 16pt; line-height: 1.25; margin: 1mm 0 3mm; break-after: avoid; }
  dl { display: grid; grid-template-columns: 26mm 1fr; gap: 0.6mm 4mm; margin: 0 0 4mm; font: 8.5pt/1.4 Helvetica, Arial, 'Liberation Sans', sans-serif; color: #444; break-inside: avoid; }
  dt { font-weight: 600; color: #777; }
  dd { margin: 0; }
  .story { margin: 0 0 4mm; }
  .story p { margin: 0 0 2.5mm; }
  .story h3, .story h4 { font-size: 11.5pt; margin: 4mm 0 1.5mm; break-after: avoid; }
  .story ul, .story ol { margin: 0 0 2.5mm; padding-left: 6mm; }
  figure { margin: 0 0 5mm; break-inside: avoid; }
  figure img { display: block; max-width: 100%; max-height: 190mm; margin: 0 auto; }
  figure.media { display: flex; gap: 4mm; align-items: flex-start; }
  figure.media img { width: 45mm; max-height: 45mm; object-fit: cover; margin: 0; flex: none; }
  figcaption { font: 8pt/1.4 Helvetica, Arial, 'Liberation Sans', sans-serif; color: #666; margin-top: 1.5mm; text-align: center; }
  figure.media figcaption { text-align: left; margin: 0; }
  .missing { font: italic 8.5pt Helvetica, Arial, sans-serif; color: #999; }
</style></head><body>
<section class="cover">
  <p class="kicker">Svendborg · Østre Kaj</p>
  <h1>Siloerne på Østre Kaj<br>– fælles arkiv</h1>
  <p>Billeder, videoer, lyd, dokumenter og historier om siloerne på havnen i Svendborg, samlet af byens borgere, før siloerne rives ned.</p>
  <p class="facts">${sorted.length} bidrag · ${first === last ? first : `${first}–${last}`} · sorteret ældst først<br>
  Udtræk dannet ${esc(formatDate(generatedAt))} · <a href="${esc(SITE_URL)}">${esc(SITE_URL)}</a><br>
  Ophavsretten tilhører de krediterede. Importeret materiale er vist under den angivne licens.</p>
</section>
${sorted.map((c, i) => article(c, i + 1)).join('\n')}
</body></html>`;
}

// ---------------------------------------------------------------- worker

async function getJson(p) {
  const res = await fetch(WORKER_URL + p);
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
  return res.json();
}

async function putObject(key, body, type) {
  const res = await fetch(`${WORKER_URL}/api/admin/object/${key}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': type },
    body,
  });
  if (!res.ok) throw new Error(`Upload af ${key} fejlede: ${res.status}`);
}

async function upload(file, key, type) {
  const { size } = await stat(file);
  if (size <= PART) return putObject(key, await readFile(file), type);
  const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const q = (extra) => `key=${encodeURIComponent(key)}&type=${encodeURIComponent(type)}${extra}`;
  const call = async (method, p, body) => {
    const res = await fetch(WORKER_URL + p, { method, headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`${method} ${p.split('?')[0]}: ${res.status}`);
    return res.json();
  };
  const { uploadId } = await call('POST', `/api/admin/mpu/create?${q('')}`);
  const parts = [];
  const fh = await open(file, 'r');
  try {
    for (let n = 1, off = 0; off < size; n++, off += PART) {
      const buf = Buffer.alloc(Math.min(PART, size - off));
      await fh.read(buf, 0, buf.length, off);
      const res = await fetch(`${WORKER_URL}/api/admin/mpu/part?${q(`&uploadId=${encodeURIComponent(uploadId)}&part=${n}`)}`, { method: 'PUT', headers: auth, body: buf });
      if (!res.ok) throw new Error(`Upload af del ${n} fejlede: ${res.status}`);
      parts.push(await res.json());
    }
  } finally {
    await fh.close();
  }
  await call('POST', `/api/admin/mpu/complete?${q(`&uploadId=${encodeURIComponent(uploadId)}`)}`, { parts });
}

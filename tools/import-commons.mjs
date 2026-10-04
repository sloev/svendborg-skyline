#!/usr/bin/env node
// Finder åbent licenserede billeder og videoer af siloerne/havnen i Svendborg på Wikimedia Commons
// og lægger dem i arkivet som "afventer godkendelse", med fotograf, kilde og licens.
//
// Kun licenser der tillader genbrug med kreditering: CC0, Public Domain, CC BY og CC BY-SA
// (ikke NC/ND). Allerede importerede filer springes over (genkendes på kilde-adressen).
//
//   WORKER_URL   workerens adresse
//   ADMIN_TOKEN  samme som workerens
//   MAX_IMPORT   højst så mange nye filer pr. kørsel (standard 40)
//   DRY_RUN      "true" = vis kun hvad der ville blive importeret

const WORKER = must('WORKER_URL').replace(/\/+$/, '');
const ADMIN = must('ADMIN_TOKEN');
const MAX = Number(process.env.MAX_IMPORT || 40);
const DRY = process.env.DRY_RUN === 'true';
const UA = 'SiloArkivImporter/1.0 (https://github.com/sloev/svendborg-skyline; fremmedartet@gmail.com)';
const API = 'https://commons.wikimedia.org/w/api.php';

// Søgninger og kategorier der kan indeholde siloerne. Alt bliver alligevel gennemset før visning.
const SEARCHES = [
  'Svendborg silo',
  'Svendborg siloer',
  'Svendborg DLG',
  'Svendborg Østre Kaj',
  'Svendborg havn',
  'Svendborg harbour',
  'Svendborg harbor',
  'Svendborg port',
  'Svendborg Sund havn silo',
];
const CATEGORIES = ['Category:Port of Svendborg', 'Category:Svendborg Havn', 'Category:Harbours in Svendborg', 'Category:Silos in Denmark'];
const RELEVANT = /silo|dlg|østre\s*kaj|oestre\s*kaj|havn|harbou?r|port\b|hafen|kaj\b|quay/i;
// Tydeligt uden for emnet (skibsportrætter, andre havne/øer osv.).
const EXCLUDE = /tallinn|hjortø|hjortoe|postbaad|postbåd|mailboat|vester\s*åby|skibsportræt|ship portrait|marstal|ærøfærge|aeroefaerge|ærøskøbing|sundance|tugboat|polar nuka|helle saj|vindeby|taasinge\s*set|tåsinge\s*set|laura 1886/i;
const ALLOWED_LICENSE = /^(cc0|public domain|pd(-|\b)|cc[ -]by(-sa)?[ -]?\d|cc[ -]by(-sa)?$)/i;
const MIME = /^(image\/(jpeg|png|tiff|webp)|video\/(webm|ogg|mp4))$/;

const candidates = new Map();

for (const q of SEARCHES) {
  const data = await commons({
    action: 'query', generator: 'search', gsrsearch: q, gsrnamespace: '6', gsrlimit: '50',
    prop: 'imageinfo|categories', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '4000', cllimit: '50',
  });
  for (const page of Object.values(data.query?.pages || {})) candidates.set(page.title, page);
}
for (const cat of CATEGORIES) {
  const data = await commons({
    action: 'query', generator: 'categorymembers', gcmtitle: cat, gcmtype: 'file', gcmlimit: '100',
    prop: 'imageinfo|categories', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '4000', cllimit: '50',
  });
  for (const page of Object.values(data.query?.pages || {})) candidates.set(page.title, page);
}
console.log(`Fundet ${candidates.size} filer på Wikimedia Commons.`);

let imported = 0;
let skipped = 0;
for (const page of candidates.values()) {
  if (imported >= MAX) break;
  const info = page.imageinfo?.[0];
  if (!info) continue;
  const meta = info.extmetadata || {};
  const v = (k) => stripHtml(meta[k]?.value || '');
  const text = [page.title, v('ImageDescription'), v('ObjectName'), (page.categories || []).map((c) => c.title).join(' ')].join(' ');
  const license = v('LicenseShortName');
  const why =
    !/svendborg/i.test(text) ? 'ikke Svendborg' :
    !RELEVANT.test(text) ? 'ikke havn/silo' :
    EXCLUDE.test(page.title) ? 'uden for emnet' :
    !MIME.test(info.mime) ? `filtype ${info.mime}` :
    !ALLOWED_LICENSE.test(license) || /\bnc\b|\bnd\b|non-?commercial|no-?deriv/i.test(license) ? `licens "${license || 'ukendt'}"` :
    null;
  if (why) {
    skipped++;
    continue;
  }

  const isImage = info.mime.startsWith('image/');
  const fileUrl = isImage && info.thumburl && info.width > 4000 ? info.thumburl : info.url;
  const name = page.title.replace(/^File:/, '');
  const artist = v('Artist') || 'Ukendt';
  const date = v('DateTimeOriginal') || v('DateTime');
  const year = (date.match(/\b(18|19|20)\d{2}\b/) || [])[0] || '';
  const description = v('ImageDescription');
  const title = truncate(name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' '), 120);
  const story = truncate(description, 8000);
  console.log(`→ ${name} (${license}, ${artist})`);
  if (DRY) {
    imported++;
    continue;
  }

  const file = await fetch(fileUrl, { headers: { 'user-agent': UA } });
  if (!file.ok) {
    console.log(`  kunne ikke hente filen (${file.status})`);
    continue;
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > 95 * 1024 * 1024) {
    console.log('  for stor, springes over');
    continue;
  }
  const ext = (fileUrl.match(/\.([a-z0-9]{2,5})(?:$|\?)/i) || [])[1] || 'jpg';
  const created = await admin('POST', '/api/admin/import', {
    title,
    story,
    period: year,
    place: '',
    credit: truncate(`Foto: ${artist} / Wikimedia Commons`, 120),
    sourceUrl: info.descriptionurl,
    license,
    licenseUrl: v('LicenseUrl'),
    files: [{ name: `${title.replace(/[^\wæøåÆØÅ .-]+/g, '').slice(0, 80) || 'commons'}.${ext.toLowerCase()}`, size: buf.length, type: info.mime }],
  });
  if (created.duplicate) {
    console.log('  allerede importeret');
    continue;
  }
  const res = await fetch(`${WORKER}/api/admin/import/${created.items[0].id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': info.mime },
    body: buf,
  });
  if (!res.ok) {
    console.log(`  upload fejlede (${res.status} ${(await res.json().catch(() => ({}))).code || ''})`);
    continue;
  }
  imported++;
  console.log('  ✓ importeret – afventer godkendelse');
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n${DRY ? 'Ville importere' : 'Importeret'}: ${imported}. Sprunget over (ikke relevant eller forkert licens): ${skipped}.`);
if (!DRY && imported) console.log('Godkend eller slet dem i /admin.html under "Afventer godkendelse".');

// ---------------------------------------------------------------- hjælpere

async function commons(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '1', origin: '*', ...params })}`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Commons ${res.status}`);
  return res.json();
}

async function admin(method, path, body) {
  const res = await fetch(`${WORKER}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${out.code || ''}`);
  return out;
}

function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function truncate(str, max) {
  str = String(str || '').trim();
  return str.length > max ? `${str.slice(0, max - 1).trimEnd()}…` : str;
}

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} skal være sat`);
    process.exit(2);
  }
  return v;
}

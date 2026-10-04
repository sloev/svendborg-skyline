#!/usr/bin/env node
// Importerer et håndplukket udvalg af billeder (tools/udvalg-oestre-kaj.json) til arkivet som
// "afventer godkendelse" – med titel, beskrivelse, dato, perspektiv, kreditering og kildelink.
// Billederne hentes fra det repo, som udvalget peger på (klones af workflowet).
//
// Ophavsretten er ikke afklaret for udvalget, så licensen sættes til "Ophavsret ikke afklaret".
// Ret den i admin, når rettighederne er på plads – og godkend først derefter.
//
// Miljø: WORKER_URL, ADMIN_TOKEN, PHOTO_ROOT (mappen med det klonede repo),
//        MANIFEST (valgfri, standard tools/udvalg-oestre-kaj.json), DRY_RUN=true (vis kun)
//
// Repoet er offentligt, så logs er offentlige: der skrives kun titler (offentlige data) og antal.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const WORKER = must('WORKER_URL').replace(/\/+$/, '');
const ADMIN = must('ADMIN_TOKEN');
const ROOT = must('PHOTO_ROOT');
const DRY = process.env.DRY_RUN === 'true';
const MANIFEST = process.env.MANIFEST || path.join(path.dirname(new URL(import.meta.url).pathname), 'udvalg-oestre-kaj.json');
const LICENSE = 'Ophavsret ikke afklaret';

const { dir, items } = JSON.parse(await readFile(MANIFEST, 'utf8'));
let imported = 0;
let duplicates = 0;
let failed = 0;

for (const it of items) {
  console.log(`• ${it.title}`);
  let buf;
  try {
    buf = await readFile(path.join(ROOT, dir, it.file));
  } catch {
    console.log('  filen findes ikke i repoet');
    failed++;
    continue;
  }
  if (DRY) {
    imported++;
    continue;
  }
  const created = await admin('POST', '/api/admin/import', {
    title: it.title,
    story: it.story,
    period: it.period,
    place: '',
    perspective: it.perspective,
    credit: it.credit,
    sourceUrl: it.sourceUrl,
    license: LICENSE,
    licenseUrl: '',
    files: [{ name: it.file, size: buf.length, type: 'image/jpeg' }],
  });
  if (created.duplicate) {
    console.log('  allerede importeret');
    duplicates++;
    continue;
  }
  const res = await fetch(`${WORKER}/api/admin/import/${created.items[0].id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'image/jpeg' },
    body: buf,
  });
  if (!res.ok) {
    console.log(`  upload fejlede (${res.status} ${(await res.json().catch(() => ({}))).code || ''})`);
    failed++;
    continue;
  }
  imported++;
  console.log('  ✓ importeret – afventer godkendelse');
  await new Promise((r) => setTimeout(r, 300));
}

console.log(`\n${DRY ? 'Ville importere' : 'Importeret'}: ${imported}. Allerede importeret: ${duplicates}. Fejlede: ${failed}.`);
if (!DRY && imported) console.log('Godkend eller slet dem i /admin.html under "Afventer godkendelse".');
if (failed) process.exit(1);

async function admin(method, p, body) {
  const res = await fetch(`${WORKER}${p}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: ${res.status} ${out.code || ''}`);
  return out;
}

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} mangler`);
    process.exit(1);
  }
  return v;
}

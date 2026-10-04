#!/usr/bin/env node
// Lægger tekstbidragene i tools/tekster.json i arkivet som "afventer godkendelse" (uden filer).
// Teksterne er skrevet til arkivet ud fra de kilder, der står nederst i hver tekst.
// Et bidrag, der allerede er importeret (samme sourceUrl), springes over.
//
// Miljø: WORKER_URL, ADMIN_TOKEN, ONLY=<nr>[,<nr>] (valgfri, 1-baseret)

import { readFileSync } from 'node:fs';
import path from 'node:path';

const WORKER = must('WORKER_URL').replace(/\/+$/, '');
const ADMIN = must('ADMIN_TOKEN');
const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'tekster.json');
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean).map(Number);
const { items } = JSON.parse(readFileSync(file, 'utf8'));

let imported = 0;
for (const [n, it] of items.entries()) {
  if (ONLY.length && !ONLY.includes(n + 1)) continue;
  const res = await fetch(`${WORKER}/api/admin/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: it.title,
      story: it.story,
      period: it.period,
      place: '',
      perspective: it.perspective || '',
      credit: it.credit || 'Siloarkivet, skrevet ud fra de nævnte kilder',
      sourceUrl: it.sourceUrl,
      license: it.license || 'Egen tekst – kilder angivet',
      licenseUrl: '',
      files: [],
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${it.title}: ${res.status} ${out.code || ''}`);
  console.log(`${out.duplicate ? '  allerede importeret' : '  ✓ importeret – afventer godkendelse'}: ${it.title}`);
  if (!out.duplicate) imported++;
}
console.log(`\nImporteret: ${imported}.`);

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} mangler`);
    process.exit(1);
  }
  return v;
}

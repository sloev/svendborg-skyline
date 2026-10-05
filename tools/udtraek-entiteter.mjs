#!/usr/bin/env node
// Finder navne på personer, skibe, bygninger, firmaer, steder, køretøjer og begivenheder i alle
// bidrag ud fra tools/entiteter-ordbog.json og gemmer dem som strukturerede data på bidraget.
// Resultatet skrives også til tools/entiteter.json, så det kan gennemgås.
//
// Miljø: WORKER_URL, ADMIN_TOKEN, DRY=1 (skriv kun filen), REPLACE=1 (overskriv i stedet for at
// lægge til de entiteter, der allerede står på bidraget, fx tilføjet i admin)

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WORKER = must('WORKER_URL').replace(/\/+$/, '');
const ADMIN = must('ADMIN_TOKEN');
const DIR = path.dirname(new URL(import.meta.url).pathname);
const dict = JSON.parse(readFileSync(path.join(DIR, 'entiteter-ordbog.json'), 'utf8'));
const auth = { authorization: `Bearer ${ADMIN}` };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [];
for (const [type, names] of Object.entries(dict)) {
  if (type.startsWith('_')) continue;
  for (const [name, aliases] of Object.entries(names)) {
    const alts = [...new Set([name, ...aliases])].sort((a, b) => b.length - a.length).map(esc);
    rules.push({ type, name, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'u') });
  }
}

const subs = [];
let before = '';
for (;;) {
  const res = await fetch(`${WORKER}/api/admin/submissions?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`, { headers: auth });
  if (!res.ok) throw new Error(`liste: ${res.status}`);
  const data = await res.json();
  subs.push(...data.submissions.filter((s) => s.status !== 'uploading' && !s.is_test));
  if (!data.next) break;
  before = data.next;
}

const out = [];
const tally = {};
for (const s of subs) {
  const text = [s.title, s.story, s.period, s.place, s.credit, ...s.items.map((i) => i.caption)].filter(Boolean).join('\n');
  const found = rules.filter((r) => r.re.test(text)).map((r) => [r.type, r.name]);
  let old = [];
  try {
    old = JSON.parse(s.entities || '[]');
  } catch {}
  const merged = process.env.REPLACE ? found : [...old, ...found.filter(([t, n]) => !old.some(([t2, n2]) => t2 === t && n2 === n))];
  for (const [t] of merged) tally[t] = (tally[t] || 0) + 1;
  out.push({ id: s.id, title: s.title, status: s.status, entities: merged });
  if (process.env.DRY || JSON.stringify(merged) === JSON.stringify(old)) continue;
  const res = await fetch(`${WORKER}/api/admin/submissions/${s.id}/meta`, {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ entities: merged }),
  });
  if (!res.ok) throw new Error(`${s.id}: ${res.status}`);
}
// Kun offentlige bidrag i filen (den ligger i et offentligt repo).
const pub = out.filter((o) => o.status === 'published').map(({ status, ...o }) => o);
writeFileSync(path.join(DIR, 'entiteter.json'), JSON.stringify(pub, null, 1) + '\n');
console.log(`${subs.length} bidrag, ${out.filter((o) => o.entities.length).length} med entiteter`, tally);
if (!process.env.DRY) {
  const res = await fetch(`${WORKER}/api/admin/reindex`, { method: 'POST', headers: auth });
  console.log('indeks:', await res.json());
}

function must(k) {
  if (!process.env[k]) throw new Error(`mangler ${k}`);
  return process.env[k];
}

#!/usr/bin/env node
// Lægger en statisk delesider pr. offentligt bidrag i public/s/<id>/index.html, så delelinks kan
// pege på hjemmesiden (https://havn.skifting.net/s/<id>/) og stadig give et pænt kort på sociale
// medier. Køres af .github/workflows/pages.yml lige før udgivelsen.
//
// Miljø: WORKER_URL, ADMIN_TOKEN (værktøjer med adgangskoden må læse API'et), SITE_URL, OUT (valgfri).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shareHtml } from '../src/share-html.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.ADMIN_TOKEN || '';
const SITE = (process.env.SITE_URL || 'https://havn.skifting.net/').replace(/\/*$/, '/');
const OUT = process.env.OUT || path.join(here, '..', 'public', 's');
if (!WORKER || !TOKEN) {
  console.error('WORKER_URL og ADMIN_TOKEN skal være sat');
  process.exit(1);
}
const auth = { authorization: `Bearer ${TOKEN}` };

async function getJson(p) {
  const res = await fetch(WORKER + p, { headers: auth });
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
  return res.json();
}

const all = [];
for (let before = null; ; ) {
  const qs = new URLSearchParams({ limit: '60', ...(before ? { before } : {}) });
  const data = await getJson(`/api/contributions?${qs}`);
  all.push(...data.contributions);
  if (!data.next) break;
  before = data.next;
}

// Har billedet sit eget forhåndsbillede (og.jpg, 1200×630), bruges det.
async function hasOg(itemId) {
  const res = await fetch(`${WORKER}/media/${itemId}/og.jpg`, { method: 'HEAD', headers: auth }).catch(() => null);
  return !!(res && res.ok);
}

let n = 0;
async function one(c) {
  const first = c.items.find((i) => i.kind === 'image' || i.kind === 'video');
  let image = `${SITE}og.jpg`;
  let video = null;
  if (first) {
    image = (await hasOg(first.id)) ? `${WORKER}/media/${first.id}/og.jpg` : first.poster || first.src;
    if (first.kind === 'video') video = first.src;
  }
  const html = shareHtml({
    title: c.title, story: c.story, credit: c.credit, kinds: c.items.map((i) => i.kind),
    image, video, target: `${SITE}#bidrag/${c.id}`, shareUrl: `${SITE}s/${c.id}/`,
  });
  const dir = path.join(OUT, c.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), html);
  n++;
}
const queue = [...all];
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) await one(queue.shift()); }));
console.log(`${n} delesider lagt i ${path.relative(process.cwd(), OUT) || OUT}`);

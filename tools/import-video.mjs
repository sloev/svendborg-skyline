#!/usr/bin/env node
// Udtrækker stillbilleder og klip af siloerne fra videoer (f.eks. fra YouTube) og lægger dem i arkivet
// som "afventer godkendelse" – med titel, beskrivelse, dato, kreditering og et link til det præcise
// sted i videoen. Hvad der udtrækkes, står i tools/udvalg-video.json (tidspunkter, beskæring og tekster).
//
// Selve videofilerne ligger ikke i repoet (ophavsret). Læg dem i VIDEO_DIR som <youtube-id>.<ext>.
//
// Datoen tages i rækkefølgen: titel → beskrivelse → upload-dato (står færdig i udvalget som "period").
// Ophavsretten er ikke afklaret, så licensen sættes til "Ophavsret ikke afklaret".
//
// Miljø: WORKER_URL, ADMIN_TOKEN, VIDEO_DIR, MANIFEST (valgfri), DRY_RUN=true (udtræk kun, ingen upload),
//        OUT_DIR (valgfri: behold de udtrukne filer her), ONLY=<id>[,<id>] (kun disse videoer)
//
// Kør kun nye videoer med ONLY: et bidrag, som en admin har slettet, ville ellers blive importeret igen.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRY = process.env.DRY_RUN === 'true';
const WORKER = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_TOKEN || '';
const VIDEO_DIR = must('VIDEO_DIR');
if (!DRY && (!WORKER || !ADMIN)) {
  console.error('WORKER_URL og ADMIN_TOKEN skal være sat (eller DRY_RUN=true)');
  process.exit(1);
}
const MANIFEST = process.env.MANIFEST || path.join(path.dirname(new URL(import.meta.url).pathname), 'udvalg-video.json');
const OUT = process.env.OUT_DIR || mkdtempSync(path.join(os.tmpdir(), 'silo-video-'));
mkdirSync(OUT, { recursive: true });
const LICENSE = 'Ophavsret ikke afklaret';

const { videos } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
let imported = 0;
let duplicates = 0;
let missing = 0;

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
for (const v of videos) {
  if (ONLY.length && !ONLY.includes(v.id)) continue;
  const src = readdirSync(VIDEO_DIR).find((f) => f.startsWith(`${v.id}.`) || f.includes(v.id));
  if (!src) {
    console.log(`– ${v.title}: videofilen mangler i ${VIDEO_DIR} (navngiv den ${v.id}.mp4/.mkv)`);
    missing += v.items.length;
    continue;
  }
  const input = path.join(VIDEO_DIR, src);
  console.log(`▶ ${v.title}`);
  for (const [n, it] of v.items.entries()) {
    const base = `${v.slug}-${n + 1}`;
    let file;
    let type;
    let seconds;
    if (it.type === 'still') {
      file = path.join(OUT, `${base}.jpg`);
      type = 'image/jpeg';
      seconds = Math.floor(it.t);
      // prettier-ignore
      ffmpeg(['-ss', String(it.t), '-i', input, '-frames:v', '1', ...(it.crop ? ['-vf', `crop=${it.crop}`] : []), '-q:v', '1', file]);
    } else {
      file = path.join(OUT, `${base}.mp4`);
      type = 'video/mp4';
      seconds = Math.floor(it.start);
      // prettier-ignore
      ffmpeg([
        '-ss', String(it.start), '-i', input, '-t', String(it.end - it.start),
        ...(it.crop || it.scale ? ['-vf', [it.crop && `crop=${it.crop}`, it.scale && `scale=${it.scale}`].filter(Boolean).join(',')] : []),
        '-c:v', 'libx264', '-crf', String(it.crf || 16), '-preset', 'slow', '-pix_fmt', 'yuv420p',
        ...(it.audio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), '-movflags', '+faststart', file,
      ]);
    }
    const size = statSync(file).size;
    console.log(`  • ${it.title} (${it.type === 'still' ? `${it.t} s` : `${it.start}–${it.end} s`}, ${(size / 1048576).toFixed(1)} MB)`);
    if (DRY) continue;

    const created = await admin('POST', '/api/admin/import', {
      title: it.title,
      story: `${it.story}\n\nFra videoen »${v.title}« af ${v.channel} på YouTube.`,
      period: it.period || v.period,
      place: it.place || '',
      perspective: it.perspective || '',
      credit: it.credit || v.credit,
      sourceUrl: `https://www.youtube.com/watch?v=${v.id}&t=${seconds}s`,
      license: LICENSE,
      licenseUrl: '',
      files: [{ name: path.basename(file), size, type }],
    });
    if (created.duplicate) {
      console.log('    allerede importeret');
      duplicates++;
      continue;
    }
    const put = () =>
      fetch(`${WORKER}/api/admin/import/${created.items[0].id}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': type },
        body: readFileSync(file),
      });
    const res = await put().catch(put);
    if (!res.ok) throw new Error(`upload fejlede (${res.status})`);
    imported++;
    console.log('    ✓ importeret – afventer godkendelse');
  }
}

console.log(`\n${DRY ? `Udtrukket til ${OUT}` : `Importeret: ${imported}. Allerede importeret: ${duplicates}.`} Mangler video: ${missing}.`);

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
}

async function admin(method, p, body) {
  // Et nyt forsøg, hvis serveren har lukket en hvilende forbindelse, mens ffmpeg arbejdede.
  const call = () =>
    fetch(`${WORKER}${p}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const res = await call().catch(call);
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

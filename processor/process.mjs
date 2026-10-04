#!/usr/bin/env node
// Converts uploaded originals into web-friendly files, keeps their metadata and
// archives the untouched originals in Google Drive (via rclone).
//
// Runs in GitHub Actions (.github/workflows/process.yml) but works anywhere with
// ffmpeg, exiftool, heif-convert, pdftoppm and (optionally) rclone installed.
//
// Environment:
//   WORKER_URL                       e.g. https://silo-arkiv.example.workers.dev
//   ADMIN_TOKEN                      same as the worker secret
//   RCLONE_REMOTE                    e.g. "gdrive:Siloerne på Østre Kaj" (optional – no Drive backup without it)
//   DELETE_ORIGINALS_AFTER_ARCHIVE   "true" to remove originals from R2 once they are safely in Drive
//   TIME_BUDGET_MINUTES              stop claiming new work after this long (default 50)

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, readFile, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const RCLONE_REMOTE = process.env.RCLONE_REMOTE || '';
const DELETE_ORIGINALS = process.env.DELETE_ORIGINALS_AFTER_ARCHIVE === 'true';
const BUDGET_MS = Number(process.env.TIME_BUDGET_MINUTES || 50) * 60_000;
const WORK = path.resolve(process.env.WORK_DIR || path.join(os.tmpdir(), 'silo-work'));
const PART = 64 * 1024 * 1024; // multipart size for large derivatives (worker limit is 100 MB per request)

const DISPLAY_PX = 2560;
const THUMB_PX = 800;
const VIDEO_PX = 1920;

if (!WORKER_URL || !ADMIN_TOKEN) {
  console.error('WORKER_URL and ADMIN_TOKEN must be set');
  process.exit(1);
}

const started = Date.now();
let processed = 0;
let failed = 0;

await mkdir(WORK, { recursive: true });
while (Date.now() - started < BUDGET_MS) {
  const { items } = await api('POST', '/api/admin/queue/claim', { limit: 1 });
  if (!items.length) break;
  for (const item of items) {
    const ok = await handle(item);
    ok ? processed++ : failed++;
  }
}
console.log(`Færdig: ${processed} behandlet, ${failed} fejlede.`);

if (RCLONE_REMOTE && (processed || failed || process.env.FORCE_EXPORT === 'true')) {
  try {
    const data = await api('GET', '/api/admin/export');
    const file = path.join(WORK, 'bidrag.json');
    await writeFile(file, JSON.stringify(data, null, 2));
    await run('rclone', ['copyto', file, `${RCLONE_REMOTE}/bidrag.json`]);
    await writeFile(path.join(WORK, 'historier.md'), storiesMarkdown(data));
    await run('rclone', ['copyto', path.join(WORK, 'historier.md'), `${RCLONE_REMOTE}/historier.md`]);
    console.log('Eksport gemt i Google Drive.');
  } catch (err) {
    console.error('Eksport til Google Drive fejlede:', err.message);
  }
}
process.exit(failed && !processed ? 1 : 0);

// ---------------------------------------------------------------- one item

async function handle(item) {
  const sub = item.submission || {};
  const dir = path.join(WORK, item.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const ext = path.extname(item.original_key).toLowerCase() || '.bin';
  const original = path.join(dir, `original${ext}`);
  let archivePath = item.archive_path || null;
  console.log(`→ ${item.id} (${item.kind}, ${item.original_name}, ${mb(item.original_size)} MB)`);

  try {
    await download(item.original_key, original);

    const meta = await exif(original);
    const facts = extractFacts(meta, item);

    // Archive the untouched original first – it is the most valuable thing we have.
    if (RCLONE_REMOTE && !archivePath) archivePath = await archiveOriginal(item, sub, original, meta, dir);

    const out = await convert(item, original, dir, !!sub.share_location, facts);

    const result = {
      ok: true,
      ...out,
      ...facts,
      lat: sub.share_location ? facts.lat : null,
      lon: sub.share_location ? facts.lon : null,
      metadata: meta,
      archivePath,
      originalDeleted: false,
    };
    // Prefer dimensions/duration of what we actually serve.
    if (out.width) result.width = out.width;
    if (out.height) result.height = out.height;
    if (out.duration) result.duration = out.duration;

    if (DELETE_ORIGINALS && archivePath) {
      await api('DELETE', `/api/admin/object/${item.original_key}`);
      result.originalDeleted = true;
    }
    await api('POST', `/api/admin/items/${item.id}/result`, result);
    console.log(`  ✓ klar${archivePath ? ` (arkiveret: ${archivePath})` : ''}`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${err.stack || err.message}`);
    await api('POST', `/api/admin/items/${item.id}/result`, { ok: false, error: String(err.message).slice(0, 1500), archivePath }).catch(
      (e) => console.error('  kunne ikke rapportere fejl:', e.message),
    );
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function convert(item, original, dir, shareLocation, facts) {
  const base = `media/${item.id}`;
  if (item.kind === 'image') {
    let source = original;
    if (/\.(heic|heif)$/i.test(original)) {
      source = path.join(dir, 'decoded.jpg');
      await run('heif-convert', ['-q', '95', original, source]);
    }
    const display = path.join(dir, 'display.jpg');
    const thumb = path.join(dir, 'thumb.jpg');
    const img = sharp(source, { failOn: 'none', limitInputPixels: false }).rotate();
    const info = await img
      .clone()
      .resize({ width: DISPLAY_PX, height: DISPLAY_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toFile(display);
    await img.clone().resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toFile(thumb);
    await copyMetadata(original, display, shareLocation);
    await upload(display, `${base}/display.jpg`, 'image/jpeg');
    await upload(thumb, `${base}/thumb.jpg`, 'image/jpeg');
    return { displayKey: `${base}/display.jpg`, thumbKey: `${base}/thumb.jpg`, width: info.width, height: info.height };
  }

  if (item.kind === 'video') {
    const video = path.join(dir, 'video.mp4');
    const poster = path.join(dir, 'poster.jpg');
    const thumb = path.join(dir, 'thumb.jpg');
    const hasAudio = (await probe(original)).streams.some((s) => s.codec_type === 'audio');
    // prettier-ignore
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', original,
      '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []),
      '-vf', `scale=w='min(${VIDEO_PX},iw)':h='min(${VIDEO_PX},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-maxrate', '8M', '-bufsize', '16M', '-profile:v', 'high',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : []),
      '-map_metadata', '0', '-movflags', '+faststart+use_metadata_tags',
      ...(shareLocation ? [] : ['-metadata', 'location=', '-metadata', 'location-eng=', '-metadata', 'com.apple.quicktime.location.ISO6709=']),
      video,
    ]);
    if (!shareLocation) await stripLocation(video);
    const info = await probe(video);
    const v = info.streams.find((s) => s.codec_type === 'video') || {};
    const duration = Number(info.format.duration) || 0;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(1, duration / 2)), '-i', video, '-frames:v', '1', '-q:v', '3', poster]);
    await sharp(poster).resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toFile(thumb);
    await upload(video, `${base}/video.mp4`, 'video/mp4');
    await upload(poster, `${base}/poster.jpg`, 'image/jpeg');
    await upload(thumb, `${base}/thumb.jpg`, 'image/jpeg');
    return {
      displayKey: `${base}/video.mp4`,
      posterKey: `${base}/poster.jpg`,
      thumbKey: `${base}/thumb.jpg`,
      width: v.width,
      height: v.height,
      duration,
    };
  }

  if (item.kind === 'audio') {
    const audio = path.join(dir, 'audio.m4a');
    // prettier-ignore
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', original, '-vn', '-c:a', 'aac', '-b:a', '160k',
      '-map_metadata', '0', '-movflags', '+faststart+use_metadata_tags',
      ...(shareLocation ? [] : ['-metadata', 'location=', '-metadata', 'com.apple.quicktime.location.ISO6709=']),
      audio,
    ]);
    if (!shareLocation) await stripLocation(audio);
    const info = await probe(audio);
    await upload(audio, `${base}/audio.m4a`, 'audio/mp4');
    return { displayKey: `${base}/audio.m4a`, duration: Number(info.format.duration) || facts.duration };
  }

  if (item.kind === 'document') {
    const pdf = path.join(dir, 'document.pdf');
    const thumbBase = path.join(dir, 'thumb');
    await run('cp', [original, pdf]);
    if (!shareLocation) await stripLocation(pdf);
    await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=75', '-f', '1', '-l', '1', '-scale-to', String(THUMB_PX), '-singlefile', original, thumbBase]);
    await upload(pdf, `${base}/document.pdf`, 'application/pdf');
    await upload(`${thumbBase}.jpg`, `${base}/thumb.jpg`, 'image/jpeg');
    return { displayKey: `${base}/document.pdf`, thumbKey: `${base}/thumb.jpg` };
  }

  throw new Error(`Ukendt type: ${item.kind}`);
}

// ---------------------------------------------------------------- metadata

async function exif(file) {
  try {
    const [full] = JSON.parse(await capture('exiftool', ['-json', '-G1', '-a', '-struct', '-api', 'LargeFileSupport=1', '-x', 'SourceFile', file]));
    const [n] = JSON.parse(
      await capture('exiftool', [
        '-json', '-n', '-api', 'LargeFileSupport=1',
        '-GPSLatitude', '-GPSLongitude', '-GPSPosition', '-DateTimeOriginal', '-CreateDate', '-MediaCreateDate', '-CreationDate',
        '-Make', '-Model', '-ImageWidth', '-ImageHeight', '-Duration', file,
      ]),
    );
    return { ...full, _numeric: n };
  } catch (err) {
    console.warn('  exiftool fejlede:', err.message);
    return {};
  }
}

function extractFacts(meta, item) {
  const n = meta._numeric || {};
  let lat = num(n.GPSLatitude);
  let lon = num(n.GPSLongitude);
  if ((lat === null || lon === null) && typeof n.GPSPosition === 'string') {
    const [a, b] = n.GPSPosition.split(/[ ,]+/).map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) [lat, lon] = [a, b];
  }
  if (lat === 0 && lon === 0) lat = lon = null;
  const date = [n.DateTimeOriginal, n.CreationDate, n.CreateDate, n.MediaCreateDate].map(parseExifDate).find(Boolean) || null;
  const camera = [n.Make, n.Model].filter(Boolean).join(' ').replace(/^(\w+) \1 /i, '$1 ').trim() || null;
  return {
    takenAt: date || null,
    camera,
    lat,
    lon,
    width: num(n.ImageWidth),
    height: num(n.ImageHeight),
    duration: num(n.Duration),
    fileModified: item.original_last_modified || null,
  };
}

function parseExifDate(v) {
  if (!v || typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === '0000' || Number(m[1]) < 1826) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

// Copy every tag from the original into the converted file (except orientation, which
// is already applied to the pixels, and embedded previews). GPS is removed unless the
// contributor agreed to share the location.
async function copyMetadata(from, to, shareLocation) {
  // prettier-ignore
  await run('exiftool', [
    '-overwrite_original', '-q', '-q', '-m', '-tagsFromFile', from, '-all:all', '-unsafe',
    '--Orientation', '--ThumbnailImage', '--PreviewImage', '--JpgFromRaw', '--MPImage*', '--ImageWidth', '--ImageHeight',
    '--ExifImageWidth', '--ExifImageHeight', '-Orientation=1', '-n', to,
  ]).catch((err) => console.warn('  kunne ikke kopiere metadata:', err.message));
  if (!shareLocation) await stripLocation(to);
}

async function stripLocation(file) {
  // prettier-ignore
  await run('exiftool', [
    '-overwrite_original', '-q', '-q', '-m', '-api', 'LargeFileSupport=1',
    '-gps:all=', '-xmp-exif:GPS*=', '-xmp:Location*=', '-xmp-photoshop:City=', '-xmp-iptcCore:Location=',
    '-Keys:GPSCoordinates=', '-UserData:GPSCoordinates=', '-Keys:LocationName=', '-Keys:LocationBody=',
    '-ItemList:GPSCoordinates=', file,
  ]).catch((err) => console.warn('  kunne ikke fjerne GPS:', err.message));
}

// ---------------------------------------------------------------- Google Drive

async function archiveOriginal(item, sub, original, meta, dir) {
  const day = (sub.created_at || new Date().toISOString()).slice(0, 10);
  const who = slug(sub.name || 'anonym');
  const folder = `${RCLONE_REMOTE}/originaler/${day}_${who}_${item.submission_id.slice(0, 8)}`;
  const safeName = `${String(item.position + 1).padStart(2, '0')}_${slug(item.original_name.replace(/\.[^.]+$/, ''))}${path.extname(item.original_key)}`;
  const sidecar = path.join(dir, 'info.json');
  await writeFile(
    sidecar,
    JSON.stringify(
      {
        bidrag: {
          id: sub.id,
          indsendt: sub.created_at,
          titel: sub.title,
          historie: sub.story,
          hvornaar: sub.period,
          hvor: sub.place,
          perspektiv: sub.perspective_label,
          tilknytning: sub.relation_label,
          navn: sub.name,
          email: sub.email,
          vis_navn: !!sub.show_name,
          del_placering: !!sub.share_location,
          maa_kontaktes: !!sub.contact_ok,
        },
        fil: {
          id: item.id,
          originalt_navn: item.original_name,
          type: item.original_type,
          stoerrelse: item.original_size,
          sidst_aendret: item.original_last_modified,
        },
        metadata: meta,
      },
      null,
      2,
    ),
  );
  await run('rclone', ['copyto', '--retries', '5', original, `${folder}/${safeName}`]);
  await run('rclone', ['copyto', '--retries', '5', sidecar, `${folder}/${safeName}.json`]);
  if (sub.story) {
    const story = path.join(dir, 'historie.txt');
    await writeFile(story, [sub.title, sub.period, sub.place, '', sub.story, '', sub.show_name ? `– ${sub.name}` : ''].filter((l) => l !== undefined).join('\n'));
    await run('rclone', ['copyto', story, `${folder}/historie.txt`]);
  }
  return `${folder}/${safeName}`;
}

function storiesMarkdown(data) {
  const lines = ['# Siloerne på Østre Kaj – historier', '', `Eksporteret ${data.exportedAt}`, ''];
  for (const s of data.submissions) {
    lines.push(`## ${s.title || '(uden titel)'}`, '');
    lines.push(`- Indsendt: ${s.created_at} (${s.status})`);
    if (s.name) lines.push(`- Navn: ${s.name}${s.email ? ` <${s.email}>` : ''}${s.show_name ? '' : ' (ikke offentligt)'}`);
    if (s.relation_label) lines.push(`- Tilknytning: ${s.relation_label}`);
    if (s.perspective_label) lines.push(`- Perspektiv: ${s.perspective_label}`);
    if (s.period) lines.push(`- Hvornår: ${s.period}`);
    if (s.place) lines.push(`- Hvor: ${s.place}`);
    lines.push(`- Filer: ${s.items.length}`, '');
    if (s.story) lines.push(s.story, '');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- worker API

async function api(method, p, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(WORKER_URL + p, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(`${method} ${p}: ${res.status} ${out.error || ''}`), { status: res.status });
      return out;
    } catch (err) {
      if (attempt >= 4 || (err.status && err.status < 500)) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

async function download(key, file) {
  const res = await fetch(`${WORKER_URL}/api/admin/object/${key}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  if (!res.ok) throw new Error(`Download af ${key} fejlede: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

async function upload(file, key, type) {
  const { size } = await stat(file);
  const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
  if (size <= PART) {
    const res = await fetch(`${WORKER_URL}/api/admin/object/${key}`, { method: 'PUT', headers: { ...auth, 'content-type': type }, body: await readFile(file) });
    if (!res.ok) throw new Error(`Upload af ${key} fejlede: ${res.status} ${await res.text()}`);
    return;
  }
  const q = (extra) => `key=${encodeURIComponent(key)}&type=${encodeURIComponent(type)}${extra}`;
  const { uploadId } = await api('POST', `/api/admin/mpu/create?${q('')}`);
  const parts = [];
  const fh = await open(file, 'r');
  try {
    for (let n = 1, off = 0; off < size; n++, off += PART) {
      const buf = Buffer.alloc(Math.min(PART, size - off));
      await fh.read(buf, 0, buf.length, off);
      const res = await fetch(`${WORKER_URL}/api/admin/mpu/part?${q(`&uploadId=${encodeURIComponent(uploadId)}&part=${n}`)}`, {
        method: 'PUT',
        headers: auth,
        body: buf,
      });
      if (!res.ok) throw new Error(`Upload af del ${n} af ${key} fejlede: ${res.status}`);
      parts.push(await res.json());
    }
  } finally {
    await fh.close();
  }
  await api('POST', `/api/admin/mpu/complete?${q(`&uploadId=${encodeURIComponent(uploadId)}`)}`, { parts });
}

// ---------------------------------------------------------------- utils

async function probe(file) {
  return JSON.parse(await capture('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
}

function run(cmd, args) {
  return capture(cmd, args).then(() => undefined);
}

function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} fejlede (${code}): ${err.trim().slice(-800)}`))));
  });
}

function slug(s) {
  return (
    String(s)
      .replace(/[æÆ]/g, 'ae')
      .replace(/[øØ]/g, 'oe')
      .replace(/[åÅ]/g, 'aa')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'fil'
  );
}

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

function mb(b) {
  return (b / 1024 / 1024).toFixed(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

#!/usr/bin/env node
// Re-encodes uploads into one archive format per media type and strips ALL embedded metadata
// (EXIF, XMP, IPTC, GPS, camera serial numbers, PDF author/title, video/audio tags, chapters …).
// Only the few facts the site shows (date, camera model, GPS position, size) are read from the
// original and sent to the worker; the files themselves carry nothing but the colour profile and,
// if the uploader allowed it, the public credit. The worker deletes the originals once the results are stored.
//
//   photos    → JPEG (mozjpeg q90, 4:2:0, sRGB), max A3 @ 300 dpi = 3508 × 4961 px
//               + 2048 px screen version and 640 px thumbnail (also JPEG)
//   video     → MP4: H.264 High (CRF 21, preset medium, ≤ 1080p, ≤ 60 fps, HDR tone-mapped to SDR)
//               + AAC-LC 128 kb/s, faststart; poster + thumbnail JPEG
//   sound     → M4A: AAC-LC 128 kb/s
//   documents → PDF rewritten by Ghostscript (/printer: images at 300 dpi) + thumbnail JPEG
//
// See README.md ("Formater og kvalitet") for how these settings were chosen.
//
// Runs in GitHub Actions (.github/workflows/process.yml) but works anywhere with
// ffmpeg, exiftool, heif-convert, ghostscript and pdftoppm installed.
//
// The repository is public, so Action logs are public: never log names, stories or file names.
//
// Environment:
//   WORKER_URL            e.g. https://silo-arkiv.example.workers.dev
//   ADMIN_TOKEN           same as the worker secret
//   TIME_BUDGET_MINUTES   stop claiming new work after this long (default 50)

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readFile, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const BUDGET_MS = Number(process.env.TIME_BUDGET_MINUTES || 50) * 60_000;
const WORK = path.resolve(process.env.WORK_DIR || path.join(os.tmpdir(), 'silo-work'));
const PART = 64 * 1024 * 1024; // multipart size for large files (worker limit is 100 MB per request)

// A3 (297 × 420 mm) at 300 dpi.
const PRINT_SHORT = 3508;
const PRINT_LONG = 4961;
const PHOTO = { quality: 90, mozjpeg: true, chromaSubsampling: '4:2:0' };
const WEB_PX = 2048;
const WEB = { quality: 82, mozjpeg: true, chromaSubsampling: '4:2:0' };
const THUMB_PX = 640;
const THUMB = { quality: 75, mozjpeg: true, chromaSubsampling: '4:2:0' };
// 1080p: long side ≤ 1920, short side ≤ 1080 (works for portrait video too).
const VIDEO_LONG = 1920;
const VIDEO_SHORT = 1080;
const VIDEO_CRF = '21';
const AUDIO_BITRATE = '128k';

if (!WORKER_URL || !ADMIN_TOKEN) {
  console.error('WORKER_URL og ADMIN_TOKEN skal være sat');
  process.exit(1);
}

const started = Date.now();
let processed = 0;
let failed = 0;
let storedBytes = 0; // bytes uploaded for the current item (reported to the worker's storage guard)

await mkdir(WORK, { recursive: true });
if (process.env.STRIP_EXISTING === '1') {
  console.log(`Metadata fjernet fra ${await stripExisting()} gemte filer.`);
  process.exit(0);
}
while (Date.now() - started < BUDGET_MS) {
  const { items } = await api('POST', '/api/admin/queue/claim', { limit: 1 });
  if (!items.length) break;
  for (const item of items) {
    const ok = await handle(item);
    ok ? processed++ : failed++;
  }
}
console.log(`Færdig: ${processed} behandlet, ${failed} fejlede.`);

process.exit(failed && !processed ? 1 : 0);

// ---------------------------------------------------------------- one item

async function handle(item) {
  const dir = path.join(WORK, item.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const ext = path.extname(item.original_key).toLowerCase() || '.bin';
  const original = path.join(dir, `original${ext}`);
  console.log(`→ ${item.id} (${item.kind}, ${mb(item.original_size)} MB)`);

  try {
    await download(item.original_key, original);
    const meta = await exif(original);
    const facts = extractFacts(meta, item);
    storedBytes = 0;
    const out = await convert(item, original, dir);

    // The full metadata dump is not stored anywhere – only the extracted facts.
    const result = { ok: true, ...facts, ...out, storedBytes };
    // Prefer dimensions/duration of what we actually store.
    for (const k of ['width', 'height', 'duration']) result[k] = out[k] || facts[k];

    // The worker deletes the original from R2 when it receives the result.
    await api('POST', `/api/admin/items/${item.id}/result`, result);
    console.log('  ✓ klar');
    return true;
  } catch (err) {
    console.error(`  ✗ ${err.stack || err.message}`);
    await api('POST', `/api/admin/items/${item.id}/result`, { ok: false, error: String(err.message).slice(0, 1500) }).catch((e) =>
      console.error('  kunne ikke rapportere fejl:', e.message),
    );
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function convert(item, original, dir) {
  const base = `media/${item.id}`;
  if (item.kind === 'image') {
    let source = original;
    if (/\.(heic|heif)$/i.test(original)) {
      // Decode at (near) lossless quality; the real encode happens below.
      source = path.join(dir, 'decoded.png');
      await run('heif-convert', [original, source]);
    }
    const photo = path.join(dir, 'photo.jpg');
    const web = path.join(dir, 'web.jpg');
    const thumb = path.join(dir, 'thumb.jpg');
    // .rotate() applies the EXIF orientation; everything is converted to sRGB with an embedded profile.
    const img = sharp(source, { failOn: 'none', limitInputPixels: false }).rotate().withIccProfile('srgb');
    const meta = await sharp(source, { failOn: 'none', limitInputPixels: false }).metadata();
    const swap = (meta.orientation || 1) >= 5;
    const w = swap ? meta.height : meta.width;
    const h = swap ? meta.width : meta.height;
    const landscape = w >= h;
    const info = await img
      .clone()
      .resize({ width: landscape ? PRINT_LONG : PRINT_SHORT, height: landscape ? PRINT_SHORT : PRINT_LONG, fit: 'inside', withoutEnlargement: true })
      .jpeg(PHOTO)
      .toFile(photo);
    await img.clone().resize({ width: WEB_PX, height: WEB_PX, fit: 'inside', withoutEnlargement: true }).jpeg(WEB).toFile(web);
    await img.clone().resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true }).jpeg(THUMB).toFile(thumb);
    await makeShareImage(img.clone(), dir, base);
    await cleanMetadata(photo, item.credit);
    await cleanMetadata(web, item.credit);
    await cleanMetadata(thumb, '');
    await upload(photo, `${base}/photo.jpg`, 'image/jpeg');
    await upload(web, `${base}/web.jpg`, 'image/jpeg');
    await upload(thumb, `${base}/thumb.jpg`, 'image/jpeg');
    return {
      fullKey: `${base}/photo.jpg`,
      displayKey: `${base}/web.jpg`,
      thumbKey: `${base}/thumb.jpg`,
      width: info.width,
      height: info.height,
    };
  }

  if (item.kind === 'video') {
    const video = path.join(dir, 'video.mp4');
    const poster = path.join(dir, 'poster.jpg');
    const thumb = path.join(dir, 'thumb.jpg');
    const src = await probe(original);
    const vs = src.streams.find((s) => s.codec_type === 'video') || {};
    const hasAudio = src.streams.some((s) => s.codec_type === 'audio');
    // iPhones and many Androids record HDR (HLG / PQ). Tone-map to SDR BT.709 so it looks right everywhere.
    const hdr = ['arib-std-b67', 'smpte2084'].includes(vs.color_transfer);
    const tonemap = hdr ? 'zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,' : '';
    // ffmpeg auto-rotates before the filters, so iw/ih are the displayed width/height here.
    const scale =
      `scale=w='if(gte(iw,ih),min(${VIDEO_LONG},iw),min(${VIDEO_SHORT},iw))':h='if(gte(iw,ih),min(${VIDEO_SHORT},ih),min(${VIDEO_LONG},ih))'` +
      ':force_original_aspect_ratio=decrease:force_divisible_by=2';
    // prettier-ignore
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', original,
      '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []),
      '-vf', `${tonemap}${scale},format=yuv420p`, '-fpsmax', '60',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', VIDEO_CRF, '-maxrate', '12M', '-bufsize', '24M',
      '-profile:v', 'high', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '2'] : []),
      ...stripAv(), ...creditArgs(item.credit),
      video,
    ]);
    const info = await probe(video);
    const v = info.streams.find((s) => s.codec_type === 'video') || {};
    const duration = Number(info.format.duration) || 0;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(1, duration / 2)), '-i', video, '-map_metadata', '-1', '-frames:v', '1', '-q:v', '3', poster]);
    await sharp(poster).resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true }).jpeg(THUMB).toFile(thumb);
    await makeShareImage(sharp(poster), dir, base);
    await upload(video, `${base}/video.mp4`, 'video/mp4');
    await upload(poster, `${base}/poster.jpg`, 'image/jpeg');
    await upload(thumb, `${base}/thumb.jpg`, 'image/jpeg');
    return {
      fullKey: `${base}/video.mp4`,
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
    const channels = Math.min(2, (await probe(original)).streams.find((s) => s.codec_type === 'audio')?.channels || 2);
    // prettier-ignore
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', original, '-vn',
      '-c:a', 'aac', '-b:a', channels === 1 ? '96k' : AUDIO_BITRATE, '-ac', String(channels),
      ...stripAv(), ...creditArgs(item.credit), audio,
    ]);
    const info = await probe(audio);
    await upload(audio, `${base}/audio.m4a`, 'audio/mp4');
    return { fullKey: `${base}/audio.m4a`, displayKey: `${base}/audio.m4a`, duration: Number(info.format.duration) || null };
  }

  if (item.kind === 'document') {
    const pdf = path.join(dir, 'document.pdf');
    const thumbBase = path.join(dir, 'thumb');
    await rewritePdf(original, pdf);
    await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=75', '-f', '1', '-l', '1', '-scale-to', String(THUMB_PX), '-singlefile', pdf, thumbBase]);
    await upload(pdf, `${base}/document.pdf`, 'application/pdf');
    await upload(`${thumbBase}.jpg`, `${base}/thumb.jpg`, 'image/jpeg');
    return { fullKey: `${base}/document.pdf`, displayKey: `${base}/document.pdf`, thumbKey: `${base}/thumb.jpg` };
  }

  throw new Error(`Ukendt type: ${item.kind}`);
}

// Forhåndsbillede til sociale medier (Open Graph): 1200 × 630, beskåret om det mest interessante
// område. Uden metadata (ingen GPS), da det deles bredt.
async function makeShareImage(pipeline, dir, base) {
  const og = path.join(dir, 'og.jpg');
  await pipeline.resize({ width: 1200, height: 630, fit: 'cover', position: sharp.strategy.attention }).jpeg({ quality: 82, mozjpeg: true }).toFile(og);
  await upload(og, `${base}/og.jpg`, 'image/jpeg');
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

// Ghostscript rewrites the PDF without metadata: no XMP, document id, dates, comments (with author
// names) or embedded files. Annotations are drawn onto the page, so their content is still visible.
async function rewritePdf(input, output) {
  // prettier-ignore
  await run('gs', [
    '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.7',
    '-dPDFSETTINGS=/printer', '-dDetectDuplicateImages=true',
    '-dOmitXMP', '-dOmitInfoDate', '-dOmitID', '-dPreserveAnnots=false', '-dPreserveEmbeddedFiles=false', '-dPreserveMarkedContent=false',
    `-sOutputFile=${output}`, input,
    // … and empty the document info (title, author, subject, keywords, program), which is otherwise copied.
    '-c', '[ /Title () /Author () /Subject () /Keywords () /Creator () /DOCINFO pdfmark',
  ]);
}

// One-off: strip metadata from files stored before metadata was removed during encoding.
// Downloads every stored file, cleans it without re-encoding (except PDFs) and puts it back under the same key.
async function stripExisting() {
  const data = await api('GET', '/api/admin/export');
  let files = 0;
  for (const sub of data.submissions) {
    const credit = sub.show_credit ? sub.credit || '' : '';
    for (const item of sub.items) {
      if (item.status !== 'ready') continue;
      const keys = [...new Set([item.full_key, item.display_key, item.thumb_key, item.poster_key].filter(Boolean))];
      const dir = path.join(WORK, `strip-${item.id}`);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      try {
        for (const key of keys) {
          const ext = path.extname(key).toLowerCase();
          const file = path.join(dir, `in${ext}`);
          const out = path.join(dir, `out${ext}`);
          await download(key, file);
          let type;
          if (ext === '.jpg') {
            await cleanMetadata(file, /thumb|poster/.test(key) ? '' : credit);
            await rm(out, { force: true });
            await run('cp', [file, out]);
            type = 'image/jpeg';
          } else if (ext === '.mp4' || ext === '.m4a') {
            await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy', ...stripAv(), ...creditArgs(credit), out]);
            type = ext === '.mp4' ? 'video/mp4' : 'audio/mp4';
          } else if (ext === '.pdf') {
            await rewritePdf(file, out);
            type = 'application/pdf';
          } else continue;
          await upload(out, key, type);
          files++;
        }
      } catch (err) {
        console.error(`  ✗ ${item.id}: ${err.message}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  return files;
}

// ffmpeg: drop all global, stream and chapter metadata (creation time, GPS/location, device,
// handler names, encoder strings …). Rotation is already applied to the pixels by the auto-rotate.
function stripAv() {
  return [
  '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
  '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart+use_metadata_tags',
  ];
}

// Kreditering: skrives ind som ophavsret, hvis uploaderen har valgt at den må vises offentligt.
// Ellers står der intet om personer i filen.
function creditArgs(credit) {
  return credit ? ['-metadata', `copyright=${credit}`, '-metadata', `artist=${credit}`] : [];
}

function creditTags(credit) {
  return credit
    ? [`-Copyright=${credit}`, `-Artist=${credit}`, `-XMP-dc:Rights=${credit}`, `-XMP-dc:Creator=${credit}`, `-XMP-photoshop:Credit=${credit}`, `-IPTC:CopyrightNotice=${credit}`]
    : [];
}

// sharp writes JPEGs without EXIF/XMP/IPTC already; this makes sure, keeping only the sRGB profile
// (needed for correct colours, contains nothing personal) and the public credit, if any.
async function cleanMetadata(file, credit) {
  // prettier-ignore
  await run('exiftool', [
    '-overwrite_original', '-q', '-q', '-m', '-all=', '--ICC_Profile:all',
    ...(credit ? ['-charset', 'iptc=UTF8', '-codedcharacterset=utf8', ...creditTags(credit)] : []), file,
  ]);
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
  storedBytes += size;
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

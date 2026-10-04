// Siloerne på Østre Kaj – API worker.
//
// Public:
//   GET  /api/config                         settings the front-end needs
//   GET  /api/stats                          counters for the front page
//   GET  /api/contributions                  published contributions (paginated, filterable)
//   GET  /api/contributions/:id              one published contribution
//   GET  /api/map                            published media with a GPS location
//   POST /api/contributions/:id/report       flag a contribution
//   POST /api/submissions                    start a contribution (Turnstile protected)
//   PUT  /api/upload/:itemId/:part           upload one chunk of a file (R2 multipart)
//   POST /api/upload/:itemId/complete        finish a file
//   POST /api/submissions/:id/complete       finish the contribution
//   GET  /media/<item>/<file>                converted media from R2 (supports Range)
//
// Admin (Authorization: Bearer ADMIN_TOKEN) – used by /admin.html and processor/process.mjs:
//   GET    /api/admin/submissions            everything, including e-mail addresses
//   PATCH  /api/admin/submissions/:id        { status }
//   DELETE /api/admin/submissions/:id        delete contribution and all its files
//   POST   /api/admin/items/:id/retry        re-queue a failed file
//   GET    /api/admin/queue-size             number of files waiting for processing
//   POST   /api/admin/queue/claim            claim files for processing
//   POST   /api/admin/items/:id/result       report processing result
//   GET|PUT|DELETE /api/admin/object/<key>   raw R2 access
//   POST   /api/admin/mpu/create|part|complete  multipart upload of large derivatives
//   GET    /api/admin/export                 full JSON export (for the Google Drive backup)

const CHUNK_SIZE = 16 * 1024 * 1024; // R2 multipart part size (min 5 MiB, max ~95 MiB on Workers)

const RELATIONS = {
  beboer: 'Bor i Svendborg',
  sejler: 'Sejler / på vandet',
  ansat: 'Har arbejdet i eller ved siloerne',
  havn: 'Arbejder eller har arbejdet på havnen',
  fotograf: 'Fotograf',
  besoegende: 'Turist / besøgende',
  andet: 'Andet',
};
const PERSPECTIVES = {
  vandet: 'Fra vandet',
  kajen: 'Fra kajen og havnen',
  byen: 'Fra byen',
  afstand: 'På lang afstand',
  indefra: 'Indefra bygningerne',
  luften: 'Fra luften',
  andet: 'Andet',
};

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'raf', 'rw2'];
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'amr', 'wma'];
const DOC_EXT = ['pdf'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Media URLs in API responses are absolute, so a site hosted elsewhere (GitHub Pages) can use them.
    env = { ...env, PUBLIC_ORIGIN: url.origin };
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
      const cors = corsHeaders(request, env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const res = await handle(request, env, ctx, url);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }
    return env.ASSETS.fetch(request);
  },

  // Daily (see [triggers] in wrangler.toml): clean up uploads that were started but never finished,
  // so their parts stop taking up (billable) space.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(abandonUploads(env, `created_at < ?`, [isoAgo(48 * 3600)], 'submissions'));
  },
};

// ---------------------------------------------------------------- spending guard
//
// Cloudflare has no hard spending cap, so the worker enforces one. On the Free plan, Workers, D1
// and Turnstile cannot cost anything (they stop at their limits). R2 is the only usage-billed part:
//   storage  $0.015 / GB-month above 10 GB   → capped by STORAGE_LIMIT_GB
//   Class A  $4.50 / million above 1M/month  → capped by CLASS_A_MONTHLY_LIMIT (default: inside the free 1M)
//   Class B  $0.36 / million above 10M/month → every read goes through this worker, which the Free
//                                              plan limits to 100k requests/day (≈3M/month), so it stays free
// With the defaults the worst case is (250 − 10) GB × $0.015 ≈ $3.60/month.

const GB = 1024 ** 3;

async function storageUsed(env) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(stored_bytes), 0) + COALESCE(SUM(CASE WHEN original_deleted = 0 THEN original_size ELSE 0 END), 0) AS bytes FROM items`,
  ).first();
  return row.bytes;
}

async function checkStorage(env, incoming) {
  const limit = Number(env.STORAGE_LIMIT_GB || 9) * GB;
  if ((await storageUsed(env)) + incoming > limit) {
    throw new HttpError(507, 'Arkivet er desværre fyldt op lige nu. Skriv til os, så finder vi en løsning.');
  }
}

function month() {
  return new Date().toISOString().slice(0, 7);
}

// Counts n Class A operations against this month's budget (or only checks, with dryRun).
async function chargeClassA(env, n, dryRun = false) {
  const limit = Number(env.CLASS_A_MONTHLY_LIMIT || 900000);
  if (dryRun) {
    const row = await env.DB.prepare(`SELECT class_a FROM usage WHERE month = ?`).bind(month()).first();
    if ((row ? row.class_a : 0) + n > limit) throw budgetError();
    return;
  }
  const row = await env.DB.prepare(
    `INSERT INTO usage (month, class_a) VALUES (?, ?)
     ON CONFLICT (month) DO UPDATE SET class_a = class_a + excluded.class_a
     RETURNING class_a`,
  )
    .bind(month(), n)
    .first();
  if (row.class_a > limit) throw budgetError();
}

function budgetError() {
  return new HttpError(503, 'Arkivet har nået sin grænse for uploads denne måned. Prøv igen fra den 1. i næste måned.');
}

async function abandonUploads(env, where, params, scope = 'items') {
  const cond = scope === 'submissions' ? `submission_id IN (SELECT id FROM submissions WHERE ${where})` : where;
  const { results } = await env.DB.prepare(`SELECT id, original_key, upload_id FROM items WHERE status = 'uploading' AND ${cond}`)
    .bind(...params)
    .all();
  for (const it of results) {
    if (it.upload_id) await env.BUCKET.resumeMultipartUpload(it.original_key, it.upload_id).abort().catch(() => {});
    await env.BUCKET.delete(it.original_key).catch(() => {});
    await env.DB.prepare(
      `UPDATE items SET status = 'failed', error = 'upload ikke fuldført', upload_id = NULL, original_deleted = 1 WHERE id = ?`,
    )
      .bind(it.id)
      .run();
  }
}

async function handle(request, env, ctx, url) {
  try {
    if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
    return await serveMedia(request, env, url);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err && err.stack ? err.stack : err);
    return json({ error: 'Der skete en fejl på serveren. Prøv igen om lidt.' }, 500);
  }
}

// ALLOWED_ORIGINS: comma separated list of sites allowed to call the API, e.g. "https://sloev.github.io".
function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!origin || !(allowed.includes(origin) || allowed.includes('*'))) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-upload-token, range',
    'access-control-expose-headers': 'content-length, content-range',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

// ---------------------------------------------------------------- routing

async function api(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  let m;

  if (path.startsWith('/api/admin/')) {
    requireAdmin(request, env);
    return adminApi(request, env, url, path, method);
  }

  if (path === '/api/config' && method === 'GET') return getConfig(env);
  if (path === '/api/stats' && method === 'GET') return getStats(env);
  if (path === '/api/contributions' && method === 'GET') return listContributions(env, url);
  if (path === '/api/map' && method === 'GET') return getMap(env);
  if ((m = path.match(/^\/api\/contributions\/([\w-]+)$/)) && method === 'GET') return getContribution(env, m[1]);
  if ((m = path.match(/^\/api\/contributions\/([\w-]+)\/report$/)) && method === 'POST') return reportContribution(request, env, m[1]);
  if (path === '/api/submissions' && method === 'POST') return createSubmission(request, env);
  if ((m = path.match(/^\/api\/upload\/([\w-]+)\/(\d+)$/)) && method === 'PUT') return uploadPart(request, env, m[1], Number(m[2]));
  if ((m = path.match(/^\/api\/upload\/([\w-]+)\/complete$/)) && method === 'POST') return completeUpload(request, env, m[1]);
  if ((m = path.match(/^\/api\/submissions\/([\w-]+)\/complete$/)) && method === 'POST') return completeSubmission(request, env, ctx, m[1]);

  throw new HttpError(404, 'Ikke fundet');
}

async function adminApi(request, env, url, path, method) {
  let m;
  if (path === '/api/admin/submissions' && method === 'GET') return adminList(env, url);
  if ((m = path.match(/^\/api\/admin\/submissions\/([\w-]+)$/))) {
    if (method === 'PATCH') return adminSetStatus(request, env, m[1]);
    if (method === 'DELETE') return adminDelete(env, m[1]);
  }
  if ((m = path.match(/^\/api\/admin\/items\/([\w-]+)\/retry$/)) && method === 'POST') return adminRetry(env, m[1]);
  if ((m = path.match(/^\/api\/admin\/items\/([\w-]+)\/result$/)) && method === 'POST') return adminResult(request, env, m[1]);
  if (path === '/api/admin/queue-size' && method === 'GET') return adminQueueSize(env);
  if (path === '/api/admin/queue/claim' && method === 'POST') return adminClaim(request, env);
  if (path === '/api/admin/export' && method === 'GET') return adminExport(env);
  if ((m = url.pathname.match(/^\/api\/admin\/object\/(.+)$/))) return adminObject(request, env, decodeURIComponent(m[1]), method);
  if (path === '/api/admin/mpu/create' && method === 'POST') {
    const key = requireKey(url.searchParams.get('key'));
    await chargeClassA(env, 1);
    const mpu = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: url.searchParams.get('type') || 'application/octet-stream' } });
    return json({ uploadId: mpu.uploadId });
  }
  if (path === '/api/admin/mpu/part' && method === 'PUT') {
    const key = requireKey(url.searchParams.get('key'));
    await chargeClassA(env, 1);
    const mpu = env.BUCKET.resumeMultipartUpload(key, url.searchParams.get('uploadId'));
    const part = await mpu.uploadPart(Number(url.searchParams.get('part')), request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }
  if (path === '/api/admin/mpu/complete' && method === 'POST') {
    const key = requireKey(url.searchParams.get('key'));
    const body = await request.json();
    await chargeClassA(env, 1);
    const mpu = env.BUCKET.resumeMultipartUpload(key, url.searchParams.get('uploadId'));
    const obj = await mpu.complete(body.parts);
    return json({ key, size: obj.size });
  }
  throw new HttpError(404, 'Ikke fundet');
}

// ---------------------------------------------------------------- public: read

function getConfig(env) {
  return json(
    {
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
      maxFileMb: Number(env.MAX_FILE_MB || 2048),
      maxFiles: Number(env.MAX_FILES || 40),
      chunkSize: CHUNK_SIZE,
      moderation: env.MODERATION === 'pre' ? 'pre' : 'post',
      contactEmail: env.CONTACT_EMAIL || '',
      relations: RELATIONS,
      perspectives: PERSPECTIVES,
    },
    200,
    { 'cache-control': 'public, max-age=300' },
  );
}

async function getStats(env) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM submissions WHERE status = 'published') AS contributions,
       COUNT(CASE WHEN i.kind = 'image' THEN 1 END) AS images,
       COUNT(CASE WHEN i.kind = 'video' THEN 1 END) AS videos,
       COUNT(CASE WHEN i.kind = 'audio' THEN 1 END) AS audio,
       COUNT(CASE WHEN i.kind = 'document' THEN 1 END) AS documents
     FROM items i JOIN submissions s ON s.id = i.submission_id
     WHERE s.status = 'published' AND i.status = 'ready'`,
  ).first();
  return json(row, 200, { 'cache-control': 'public, max-age=60' });
}

async function listContributions(env, url) {
  const limit = clamp(Number(url.searchParams.get('limit')) || 24, 1, 60);
  const before = url.searchParams.get('before');
  const kind = url.searchParams.get('kind') || '';
  const relation = url.searchParams.get('relation') || '';
  const perspective = url.searchParams.get('perspective') || '';

  const where = [`s.status = 'published'`];
  const params = [];
  if (before) {
    where.push('s.published_at < ?');
    params.push(before);
  }
  if (relation && RELATIONS[relation]) {
    where.push('s.relation = ?');
    params.push(relation);
  }
  if (perspective && PERSPECTIVES[perspective]) {
    where.push('s.perspective = ?');
    params.push(perspective);
  }
  if (['image', 'video', 'audio', 'document'].includes(kind)) {
    where.push(`EXISTS (SELECT 1 FROM items i WHERE i.submission_id = s.id AND i.kind = ? AND i.status = 'ready')`);
    params.push(kind);
  } else if (kind === 'story') {
    where.push(`length(s.story) >= 80`);
  }

  const { results } = await env.DB.prepare(
    `SELECT * FROM submissions s WHERE ${where.join(' AND ')} ORDER BY s.published_at DESC LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all();
  const more = results.length > limit;
  const subs = results.slice(0, limit);
  const out = await withItems(env, subs);
  return json(
    { contributions: out, next: more ? subs[subs.length - 1].published_at : null },
    200,
    { 'cache-control': 'public, max-age=30' },
  );
}

async function getContribution(env, id) {
  const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ? AND status = 'published'`).bind(id).first();
  if (!sub) throw new HttpError(404, 'Bidraget findes ikke (længere).');
  const [out] = await withItems(env, [sub]);
  return json(out, 200, { 'cache-control': 'public, max-age=30' });
}

async function getMap(env) {
  const { results } = await env.DB.prepare(
    `SELECT i.*, s.title AS s_title FROM items i JOIN submissions s ON s.id = i.submission_id
     WHERE s.status = 'published' AND i.status = 'ready'
       AND i.lat IS NOT NULL AND i.lon IS NOT NULL
     ORDER BY s.published_at DESC LIMIT 2000`,
  ).all();
  return json(
    {
      points: results.map((i) => ({
        submissionId: i.submission_id,
        itemId: i.id,
        kind: i.kind,
        lat: i.lat,
        lon: i.lon,
        title: i.s_title,
        thumb: mediaUrl(env, i.thumb_key),
      })),
    },
    200,
    { 'cache-control': 'public, max-age=60' },
  );
}

async function withItems(env, subs) {
  if (!subs.length) return [];
  const ids = subs.map((s) => s.id);
  const { results } = await env.DB.prepare(
    `SELECT * FROM items WHERE submission_id IN (${ids.map(() => '?').join(',')}) ORDER BY position`,
  )
    .bind(...ids)
    .all();
  return subs.map((s) => {
    const items = results.filter((i) => i.submission_id === s.id);
    return publicSubmission(env, s, items);
  });
}

function publicSubmission(env, s, items) {
  return {
    id: s.id,
    publishedAt: s.published_at,
    title: s.title,
    story: s.story,
    period: s.period,
    place: s.place,
    perspective: s.perspective,
    perspectiveLabel: PERSPECTIVES[s.perspective] || '',
    relation: s.relation,
    relationLabel: RELATIONS[s.relation] || '',
    name: s.show_name ? s.name : '',
    items: items.filter((i) => i.status === 'ready').map((i) => publicItem(env, i)),
    processing: items.filter((i) => ['pending', 'processing'].includes(i.status)).length,
  };
}

function publicItem(env, i) {
  return {
    id: i.id,
    kind: i.kind,
    src: mediaUrl(env, i.display_key),
    full: mediaUrl(env, i.full_key || i.display_key),
    thumb: mediaUrl(env, i.thumb_key),
    poster: mediaUrl(env, i.poster_key),
    width: i.width,
    height: i.height,
    duration: i.duration,
    takenAt: i.taken_at,
    camera: i.camera,
    lat: i.lat,
    lon: i.lon,
  };
}

function mediaUrl(env, key) {
  if (!key) return null;
  const base = (env.MEDIA_BASE_URL || env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  return `${base}/${key}`; // keys start with media/
}

// ---------------------------------------------------------------- public: write

async function createSubmission(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const body = await readJson(request, 200_000);

  // --- cheap spam checks first
  if (body.website) throw new HttpError(400, 'Indsendelsen blev afvist.'); // honeypot
  if (typeof body.elapsedMs === 'number' && body.elapsedMs < 4000) throw new HttpError(400, 'Det gik lidt for hurtigt – prøv igen.');

  await verifyTurnstile(env, body.turnstileToken, ip);

  const ipHash = await sha256(`${env.IP_SALT || ''}:${ip}`);
  const recent = await env.DB.prepare(
    `SELECT
       COUNT(CASE WHEN created_at > ? THEN 1 END) AS hour,
       COUNT(*) AS day
     FROM submissions WHERE ip_hash = ? AND created_at > ?`,
  )
    .bind(isoAgo(3600), ipHash, isoAgo(86400))
    .first();
  if (recent.hour >= 10 || recent.day >= 40) {
    throw new HttpError(429, 'Du har sendt mange bidrag på kort tid. Prøv igen senere – eller skriv til os, hvis du har meget materiale.');
  }

  // --- validate fields
  const title = text(body.title, 150);
  const story = text(body.story, 20000, true);
  const period = text(body.period, 100);
  const place = text(body.place, 200);
  const name = text(body.name, 100);
  const email = text(body.email, 200);
  const relation = RELATIONS[body.relation] ? body.relation : '';
  const perspective = PERSPECTIVES[body.perspective] ? body.perspective : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-mailadressen ser ikke rigtig ud.');
  if (!body.consent) throw new HttpError(400, 'Du skal give tilladelse til at vi må vise og gemme dit bidrag.');
  const links = (`${title} ${story} ${place}`.match(/https?:\/\/|www\./gi) || []).length;
  if (links > 3) throw new HttpError(400, 'Dit bidrag indeholder for mange links.');

  const maxFiles = Number(env.MAX_FILES || 40);
  const maxBytes = Number(env.MAX_FILE_MB || 2048) * 1024 * 1024;
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > maxFiles) throw new HttpError(400, `Du kan højst sende ${maxFiles} filer ad gangen.`);
  if (!files.length && story.length < 20) throw new HttpError(400, 'Vedhæft mindst én fil eller skriv en historie.');

  const subId = crypto.randomUUID();
  const now = new Date().toISOString();
  const uploadToken = randomHex(24);

  const items = [];
  for (const [idx, f] of files.entries()) {
    const fname = text(f && f.name, 255) || 'fil';
    const size = Number(f && f.size);
    const type = text(f && f.type, 100);
    if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, `Filen "${fname}" er tom.`);
    if (size > maxBytes) throw new HttpError(400, `Filen "${fname}" er for stor (max ${env.MAX_FILE_MB || 2048} MB).`);
    const kind = kindOf(fname, type);
    if (!kind) throw new HttpError(400, `Filtypen for "${fname}" understøttes ikke. Send billeder, video, lyd eller PDF.`);
    const id = crypto.randomUUID();
    const ext = extOf(fname) || 'bin';
    items.push({
      id,
      kind,
      position: idx,
      name: fname,
      type,
      size,
      lastModified: Number.isFinite(f.lastModified) ? new Date(f.lastModified).toISOString() : '',
      key: `originals/${subId}/${id}.${ext}`,
    });
  }

  // Spending guard: refuse before anything is written if the archive is full or the month's
  // write budget is used up. Every upload costs ~1 Class A operation per 16 MB plus 2.
  const incoming = items.reduce((n, it) => n + it.size, 0);
  await checkStorage(env, incoming);
  if (items.length) {
    await chargeClassA(env, items.reduce((n, it) => n + Math.ceil(it.size / CHUNK_SIZE) + 2, 0), true);
    await chargeClassA(env, items.length);
  }

  for (const it of items) {
    const mpu = await env.BUCKET.createMultipartUpload(it.key, {
      httpMetadata: { contentType: it.type || 'application/octet-stream' },
      customMetadata: { submission: subId, originalName: encodeURIComponent(it.name) },
    });
    it.uploadId = mpu.uploadId;
  }

  const stmts = [
    env.DB.prepare(
      `INSERT INTO submissions (id, created_at, status, title, story, period, place, perspective, relation, name, email,
         show_name, share_location, contact_ok, upload_token, ip_hash, user_agent)
       VALUES (?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      subId, now, title, story, period, place, perspective, relation, name, email,
      body.showName && name ? 1 : 0, 1 /* GPS location is always shown */, body.contactOk && email ? 1 : 0,
      uploadToken, ipHash, text(request.headers.get('user-agent'), 300),
    ),
    ...items.map((it) =>
      env.DB.prepare(
        `INSERT INTO items (id, submission_id, position, kind, original_key, original_name, original_type, original_size,
           original_last_modified, upload_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
      ).bind(it.id, subId, it.position, it.kind, it.key, it.name, it.type, it.size, it.lastModified, it.uploadId),
    ),
  ];
  await env.DB.batch(stmts);

  return json({
    id: subId,
    uploadToken,
    chunkSize: CHUNK_SIZE,
    items: items.map((it) => ({ id: it.id, position: it.position })),
  });
}

async function loadUploadItem(request, env, itemId) {
  const row = await env.DB.prepare(
    `SELECT i.*, s.upload_token, s.created_at AS s_created FROM items i JOIN submissions s ON s.id = i.submission_id WHERE i.id = ?`,
  )
    .bind(itemId)
    .first();
  if (!row || !safeEqual(row.upload_token, request.headers.get('x-upload-token') || '')) throw new HttpError(403, 'Ugyldig upload.');
  if (row.status !== 'uploading') throw new HttpError(409, 'Filen er allerede modtaget.');
  if (Date.parse(row.s_created) < Date.now() - 48 * 3600 * 1000) throw new HttpError(410, 'Uploaden er udløbet. Start forfra.');
  return row;
}

async function uploadPart(request, env, itemId, partNumber) {
  const item = await loadUploadItem(request, env, itemId);
  const parts = Math.ceil(item.original_size / CHUNK_SIZE);
  if (partNumber < 1 || partNumber > parts) throw new HttpError(400, 'Ugyldig del.');
  const expected = Math.min(CHUNK_SIZE, item.original_size - (partNumber - 1) * CHUNK_SIZE);
  const length = Number(request.headers.get('content-length'));
  if (length !== expected) throw new HttpError(400, 'Forkert størrelse på fildel.');
  await chargeClassA(env, 1);
  const mpu = env.BUCKET.resumeMultipartUpload(item.original_key, item.upload_id);
  const part = await mpu.uploadPart(partNumber, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function completeUpload(request, env, itemId) {
  const item = await loadUploadItem(request, env, itemId);
  const body = await readJson(request, 100_000);
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (parts.length !== Math.ceil(item.original_size / CHUNK_SIZE)) throw new HttpError(400, 'Filen mangler dele.');
  await chargeClassA(env, 1);
  const mpu = env.BUCKET.resumeMultipartUpload(item.original_key, item.upload_id);
  const obj = await mpu.complete(
    parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })).sort((a, b) => a.partNumber - b.partNumber),
  );
  if (obj.size !== item.original_size) {
    await env.BUCKET.delete(item.original_key);
    await env.DB.prepare(`UPDATE items SET status = 'failed', error = 'size mismatch' WHERE id = ?`).bind(itemId).run();
    throw new HttpError(400, 'Filen kom ikke korrekt igennem. Prøv igen.');
  }
  await env.DB.prepare(`UPDATE items SET status = 'pending', upload_id = NULL WHERE id = ?`).bind(itemId).run();
  return json({ ok: true });
}

async function completeSubmission(request, env, ctx, subId) {
  const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(subId).first();
  if (!sub || !safeEqual(sub.upload_token, request.headers.get('x-upload-token') || '')) throw new HttpError(403, 'Ugyldig upload.');
  if (sub.status !== 'uploading') return json({ ok: true, status: sub.status });

  await abandonUploads(env, `submission_id = ?`, [subId]);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending FROM items WHERE submission_id = ?`,
  )
    .bind(subId)
    .first();
  if (counts.total > 0 && counts.pending === 0 && sub.story.length < 20) {
    await env.DB.prepare(`UPDATE submissions SET status = 'hidden' WHERE id = ?`).bind(subId).run();
    throw new HttpError(400, 'Ingen af filerne kom igennem. Prøv igen.');
  }

  const status = env.MODERATION === 'pre' ? 'review' : 'published';
  await env.DB.prepare(`UPDATE submissions SET status = ?, published_at = ? WHERE id = ?`)
    .bind(status, new Date().toISOString(), subId)
    .run();

  // Ask GitHub Actions to process the files now (and refresh the Drive backup).
  ctx.waitUntil(triggerProcessing(env));
  return json({ ok: true, status, pending: counts.pending });
}

async function reportContribution(request, env, subId) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const ipHash = await sha256(`${env.IP_SALT || ''}:${ip}`);
  const body = await readJson(request, 10_000).catch(() => ({}));
  const sub = await env.DB.prepare(`SELECT id, status FROM submissions WHERE id = ?`).bind(subId).first();
  if (!sub) throw new HttpError(404, 'Ikke fundet');
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO reports (submission_id, ip_hash, reason, created_at) VALUES (?, ?, ?, ?)`)
    .bind(subId, ipHash, text(body.reason, 500), new Date().toISOString())
    .run();
  if (res.meta.changes) {
    // Three independent reports take the contribution offline until an admin has looked at it.
    await env.DB.prepare(
      `UPDATE submissions SET reports = reports + 1,
         status = CASE WHEN reports + 1 >= 3 AND status = 'published' THEN 'review' ELSE status END
       WHERE id = ?`,
    )
      .bind(subId)
      .run();
  }
  return json({ ok: true });
}

async function triggerProcessing(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'silo-arkiv-worker',
    },
    body: JSON.stringify({ event_type: 'process-media' }),
  });
  if (!res.ok) console.error('GitHub dispatch failed', res.status, await res.text());
}

async function verifyTurnstile(env, token, ip) {
  if (env.TURNSTILE_SECRET === 'disabled') return; // local development only
  if (!env.TURNSTILE_SECRET) throw new HttpError(500, 'Spam-beskyttelsen er ikke sat op (TURNSTILE_SECRET mangler).');
  if (!token) throw new HttpError(400, 'Bekræft venligst at du er et menneske.');
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const out = await res.json();
  if (!out.success) throw new HttpError(400, 'Spam-tjekket fejlede. Genindlæs siden og prøv igen.');
}

// ---------------------------------------------------------------- media

async function serveMedia(request, env, url) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Metode ikke tilladt');
  const key = decodeURIComponent(url.pathname.slice(1)); // /media/<item>/<file> → R2 key media/<item>/<file>
  if (!/^media\/[\w-]+\/[\w.-]+$/.test(key)) throw new HttpError(404, 'Ikke fundet');
  const obj = await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) throw new HttpError(404, 'Ikke fundet');

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (!('body' in obj)) return new Response(null, { status: 304, headers });

  let status = 200;
  if (request.headers.has('range') && obj.range) {
    const r = obj.range;
    let start, end;
    if ('suffix' in r && r.suffix !== undefined) {
      start = Math.max(0, obj.size - r.suffix);
      end = obj.size - 1;
    } else {
      start = r.offset || 0;
      end = r.length !== undefined ? start + r.length - 1 : obj.size - 1;
    }
    headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('content-length', String(end - start + 1));
    status = 206;
  } else {
    headers.set('content-length', String(obj.size));
  }
  return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
}

// ---------------------------------------------------------------- admin

function requireAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN) throw new HttpError(500, 'ADMIN_TOKEN er ikke sat op.');
  if (!safeEqual(token, env.ADMIN_TOKEN)) throw new HttpError(401, 'Forkert adgangskode.');
}

async function adminList(env, url) {
  const status = url.searchParams.get('status');
  const limit = clamp(Number(url.searchParams.get('limit')) || 50, 1, 200);
  const before = url.searchParams.get('before');
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (before) {
    where.push('created_at < ?');
    params.push(before);
  }
  const { results: subs } = await env.DB.prepare(
    `SELECT * FROM submissions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all();
  const more = subs.length > limit;
  const page = subs.slice(0, limit);
  let items = [];
  if (page.length) {
    ({ results: items } = await env.DB.prepare(
      `SELECT id, submission_id, position, kind, original_name, original_type, original_size, status, attempts, error,
              full_key, display_key, thumb_key, poster_key, taken_at, camera, lat, lon, archive_path, original_deleted
       FROM items WHERE submission_id IN (${page.map(() => '?').join(',')}) ORDER BY position`,
    )
      .bind(...page.map((s) => s.id))
      .all());
  }
  const counts = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM submissions GROUP BY status`).all();
  const usage = await env.DB.prepare(`SELECT class_a FROM usage WHERE month = ?`).bind(month()).first();
  return json({
    usage: {
      storedGb: Math.round(((await storageUsed(env)) / GB) * 100) / 100,
      storageLimitGb: Number(env.STORAGE_LIMIT_GB || 9),
      classA: usage ? usage.class_a : 0,
      classALimit: Number(env.CLASS_A_MONTHLY_LIMIT || 900000),
    },
    counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
    next: more ? page[page.length - 1].created_at : null,
    submissions: page.map(({ upload_token, ip_hash, ...s }) => ({
      ...s,
      items: items
        .filter((i) => i.submission_id === s.id)
        .map((i) => ({ ...i, thumb: mediaUrl(env, i.thumb_key), src: mediaUrl(env, i.display_key) })),
    })),
  });
}

async function adminSetStatus(request, env, id) {
  const { status } = await request.json();
  if (!['published', 'hidden', 'review'].includes(status)) throw new HttpError(400, 'Ugyldig status');
  await env.DB.prepare(
    `UPDATE submissions SET status = ?, published_at = COALESCE(published_at, ?),
       reports = CASE WHEN ? = 'published' THEN 0 ELSE reports END
     WHERE id = ?`,
  )
    .bind(status, new Date().toISOString(), status, id)
    .run();
  if (status === 'published') await env.DB.prepare(`DELETE FROM reports WHERE submission_id = ?`).bind(id).run();
  return json({ ok: true });
}

async function adminDelete(env, id) {
  const { results: items } = await env.DB.prepare(`SELECT * FROM items WHERE submission_id = ?`).bind(id).all();
  const keys = [];
  for (const i of items) {
    if (i.upload_id) await env.BUCKET.resumeMultipartUpload(i.original_key, i.upload_id).abort().catch(() => {});
    keys.push(i.original_key, i.full_key, i.display_key, i.thumb_key, i.poster_key);
  }
  const existing = keys.filter(Boolean);
  for (let n = 0; n < existing.length; n += 1000) await env.BUCKET.delete(existing.slice(n, n + 1000));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM items WHERE submission_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM reports WHERE submission_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM submissions WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true, note: 'Kopier i Google Drive skal slettes manuelt der.' });
}

async function adminRetry(env, id) {
  const res = await env.DB.prepare(
    `UPDATE items SET status = 'pending', attempts = 0, error = '' WHERE id = ? AND status IN ('failed', 'processing') AND original_deleted = 0`,
  )
    .bind(id)
    .run();
  if (!res.meta.changes) throw new HttpError(409, 'Originalen er slettet, så filen kan ikke behandles igen.');
  return json({ ok: true });
}

// Originals are never kept: they are deleted as soon as the re-encoded files exist,
// or when processing has failed for good.
async function deleteOriginal(env, id) {
  const item = await env.DB.prepare(`SELECT original_key FROM items WHERE id = ?`).bind(id).first();
  if (!item) return;
  await env.BUCKET.delete(item.original_key);
  await env.DB.prepare(`UPDATE items SET original_deleted = 1 WHERE id = ?`).bind(id).run();
}

const CLAIMABLE = `(status = 'pending' OR (status = 'processing' AND claimed_at < ?)) AND attempts < 3`;

async function adminQueueSize(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${CLAIMABLE}`).bind(isoAgo(3 * 3600)).first();
  return json({ pending: row.n });
}

async function adminClaim(request, env) {
  const body = await request.json().catch(() => ({}));
  const limit = clamp(Number(body.limit) || 1, 1, 20);
  const { results } = await env.DB.prepare(
    `UPDATE items SET status = 'processing', claimed_at = ?, attempts = attempts + 1
     WHERE id IN (SELECT id FROM items WHERE ${CLAIMABLE} ORDER BY rowid LIMIT ?)
     RETURNING *`,
  )
    .bind(new Date().toISOString(), isoAgo(3 * 3600), limit)
    .all();
  const out = [];
  for (const it of results) {
    const s = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(it.submission_id).first();
    out.push({ ...it, metadata: undefined, submission: s ? exportSubmission(s) : null });
  }
  return json({ items: out });
}

async function adminResult(request, env, id) {
  const b = await request.json();
  if (!b.ok) {
    const row = await env.DB.prepare(
      `UPDATE items SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, error = ? WHERE id = ? RETURNING status`,
    )
      .bind(text(b.error, 2000), id)
      .first();
    if (row && row.status === 'failed') await deleteOriginal(env, id);
    return json({ ok: true });
  }
  await env.DB.prepare(
    `UPDATE items SET status = 'ready', error = '', stored_bytes = ?, full_key = ?, display_key = ?, thumb_key = ?, poster_key = ?, width = ?, height = ?,
       duration = ?, taken_at = ?, camera = ?, lat = ?, lon = ?, metadata = ?, archive_path = COALESCE(?, archive_path),
       processed_at = ?
     WHERE id = ?`,
  )
    .bind(
      Math.max(0, Math.round(num(b.storedBytes) || 0)), b.fullKey || null, b.displayKey || null, b.thumbKey || null, b.posterKey || null, num(b.width), num(b.height), num(b.duration),
      b.takenAt || null, text(b.camera, 200) || null, num(b.lat), num(b.lon),
      b.metadata ? JSON.stringify(b.metadata) : null, b.archivePath || null,
      new Date().toISOString(), id,
    )
    .run();
  await deleteOriginal(env, id);
  return json({ ok: true });
}

async function adminExport(env) {
  const { results: subs } = await env.DB.prepare(`SELECT * FROM submissions WHERE status != 'uploading' ORDER BY created_at`).all();
  const { results: items } = await env.DB.prepare(`SELECT * FROM items ORDER BY submission_id, position`).all();
  return json({
    exportedAt: new Date().toISOString(),
    submissions: subs.map((s) => ({
      ...exportSubmission(s),
      items: items
        .filter((i) => i.submission_id === s.id)
        .map(({ upload_id, metadata, ...i }) => ({ ...i, metadata: metadata ? JSON.parse(metadata) : null })),
    })),
  });
}

function exportSubmission(s) {
  const { upload_token, ip_hash, ...rest } = s;
  return { ...rest, relation_label: RELATIONS[s.relation] || '', perspective_label: PERSPECTIVES[s.perspective] || '' };
}

async function adminObject(request, env, key, method) {
  requireKey(key);
  if (method === 'GET') {
    const obj = await env.BUCKET.get(key);
    if (!obj) throw new HttpError(404, 'Ikke fundet');
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('content-length', String(obj.size));
    return new Response(obj.body, { headers });
  }
  if (method === 'PUT') {
    await chargeClassA(env, 1);
    const obj = await env.BUCKET.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' },
    });
    return json({ key, size: obj.size });
  }
  if (method === 'DELETE') {
    await env.BUCKET.delete(key);
    return json({ ok: true });
  }
  throw new HttpError(405, 'Metode ikke tilladt');
}

function requireKey(key) {
  if (!key || !/^(originals|media)\/[\w-]+\/[\w.-]+$/.test(key)) throw new HttpError(400, 'Ugyldig nøgle');
  return key;
}

// ---------------------------------------------------------------- helpers

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function readJson(request, maxBytes) {
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(413, 'For meget data.');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'Ugyldige data.');
  }
}

function text(v, max, multiline = false) {
  if (v === undefined || v === null) return '';
  let s = String(v).normalize('NFC');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function kindOf(name, type) {
  const ext = extOf(name);
  type = (type || '').toLowerCase();
  if (type.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image';
  if (type.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  if (type.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio';
  if (type === 'application/pdf' || DOC_EXT.includes(ext)) return 'document';
  return null;
}

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function isoAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Siloerne på Østre Kaj – API worker.
//
// Public:
//   GET  /api/config                         settings the front-end needs
//   GET  /api/stats                          counters for the front page
//   GET  /api/contributions                  published contributions (paginated, filterable)
//   GET  /api/contributions/:id              one published contribution
//   GET  /api/map                            published media with a GPS location
//   POST /api/contributions/:id/report       flag a contribution
//   GET  /api/contributions/:id/comments     approved comments on a contribution
//   GET  /api/comments/ticket?submission=ID  signed, IP-bound ticket + proof-of-work difficulty
//   POST /api/contributions/:id/comments     add a comment (ticket + proof of work + Turnstile)
//   POST /api/comments/:id/report            flag a comment
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
//   GET    /api/admin/comments               comments (filter by status)
//   PATCH  /api/admin/comments/:id           { status }
//   DELETE /api/admin/comments/:id           delete a comment

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

// Max længde på alle tekstfelter (tegn). Sendes også til siden via /api/config.
const LIMITS = { title: 120, story: 8000, period: 60, place: 120, credit: 120, email: 254, reason: 500, fileName: 200, commentName: 60, comment: 300 };
const FIELD_NAMES = { title: 'Overskrift', story: 'Historie', period: 'Hvornår', place: 'Hvor fra', credit: 'Kreditering', email: 'E-mail', commentName: 'Navn', comment: 'Kommentar' };

// Grove spam-ord. Rammer de, afvises bidraget (siden handler om siloerne i Svendborg).
const SPAM_WORDS =
  /\b(viagra|cialis|casino|kasino|betting|bitcoin|crypto|krypto|forex|porn|porno|xxx|escort|loan|lån uden|seo services?|backlinks?|click here|klik her|free money|gratis penge|onlyfans|telegram me|whatsapp me)\b/i;

// Fejl sendes som { code, params, error }. Siden oversætter ud fra code; error er den danske tekst
// (bruges af admin-siden og som reserve).
const ERRORS = {
  admin_not_configured: 'ADMIN_TOKEN er ikke sat op (mindst 32 tegn).',
  comment_links: 'Links, e-mailadresser og telefonnumre er ikke tilladt i kommentarer.',
  comment_pow: 'Spam-tjekket blev ikke færdigt. Prøv igen.',
  comment_rate: 'Du har skrevet mange kommentarer på kort tid. Prøv igen senere.',
  comment_short: 'Kommentaren er for kort.',
  comment_ticket: 'Formularen er udløbet. Prøv igen.',
  comments_busy: 'Der kommer usædvanligt mange kommentarer lige nu. Prøv igen senere.',
  comments_closed: 'Der er lukket for kommentarer.',
  duplicate_comment: 'Den kommentar er allerede skrevet.',
  name_missing: 'Skriv dit navn.',
  archive_full: 'Arkivet er desværre fyldt op lige nu. Skriv til os, så finder vi en løsning.',
  consent_missing: 'Du skal give tilladelse til at vi må vise og gemme dit bidrag.',
  contribution_gone: 'Bidraget findes ikke (længere).',
  credit_missing: 'Skriv hvem der skal krediteres for materialet (f.eks. dit navn eller fotografens navn).',
  daily_bytes: 'Du har sendt meget materiale i dag. Prøv igen i morgen – eller skriv til os.',
  duplicate: 'Den historie er allerede sendt ind. Tak!',
  email_invalid: 'E-mailadressen ser ikke rigtig ud.',
  field_too_long: '{fieldName} er for lang (max {max} tegn).',
  file_corrupt: 'Filen kom ikke korrekt igennem. Prøv igen.',
  file_empty: 'Filen "{name}" er tom.',
  file_missing_parts: 'Filen mangler dele.',
  file_not_media: 'Filen ser ikke ud til at være et billede, en video, lyd eller PDF.',
  file_too_big: 'Filen "{name}" er for stor (max {mb} MB).',
  file_type: 'Filtypen for "{name}" understøttes ikke. Send billeder, video, lyd eller PDF.',
  invalid_data: 'Ugyldige data.',
  invalid_key: 'Ugyldig nøgle',
  invalid_status: 'Ugyldig status',
  method: 'Metode ikke tilladt',
  monthly_limit: 'Arkivet har nået sin grænse for uploads denne måned. Prøv igen fra den 1. i næste måned.',
  none_through: 'Ingen af filerne kom igennem. Prøv igen.',
  not_found: 'Ikke fundet',
  nothing: 'Vedhæft mindst én fil eller skriv en historie.',
  origin: 'Indsendelser skal komme fra hjemmesiden.',
  original_deleted: 'Originalen er slettet, så filen kan ikke behandles igen.',
  part_invalid: 'Ugyldig del.',
  part_size: 'Forkert størrelse på fildel.',
  rate_limited: 'Du har sendt mange bidrag på kort tid. Prøv igen senere – eller skriv til os, hvis du har meget materiale.',
  rejected: 'Indsendelsen blev afvist.',
  report_limit: 'Du har anmeldt mange bidrag i dag. Skriv til os, hvis noget er galt.',
  server: 'Der skete en fejl på serveren. Prøv igen om lidt.',
  spam_links: 'Dit bidrag indeholder for mange links.',
  spam_repeat: 'Dit bidrag indeholder for mange gentagne tegn.',
  spam_script: 'Skriv venligst på dansk (eller et andet sprog med latinske bogstaver).',
  spam_words: 'Dit bidrag blev fanget af spamfilteret. Skriv til os, hvis det er en fejl.',
  submission_too_big: 'Et bidrag må højst fylde {gb} GB. Del det gerne op i flere.',
  too_fast: 'Det gik lidt for hurtigt – prøv igen om et øjeblik.',
  too_many_attempts: 'For mange forkerte forsøg. Prøv igen om en time.',
  too_many_files: 'Du kan højst sende {max} filer ad gangen.',
  too_much_data: 'For meget data.',
  turnstile_failed: 'Spam-tjekket fejlede. Genindlæs siden og prøv igen.',
  turnstile_missing: 'Bekræft venligst at du er et menneske.',
  turnstile_not_configured: 'Spam-beskyttelsen er ikke sat op (TURNSTILE_SECRET mangler).',
  turnstile_wrong_site: 'Spam-tjekket fejlede (forkert side).',
  upload_expired: 'Uploaden er udløbet. Start forfra.',
  upload_invalid: 'Ugyldig upload.',
  upload_received: 'Filen er allerede modtaget.',
  wrong_password: 'Forkert adgangskode.',
};

class HttpError extends Error {
  constructor(status, code, params = {}) {
    const vars = { ...params, fieldName: params.field ? FIELD_NAMES[params.field] : '' };
    super((ERRORS[code] || code).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)));
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Media URLs in API responses are absolute, so a site hosted elsewhere (GitHub Pages) can use them.
    env = { ...env, PUBLIC_ORIGIN: url.origin };
    env.IS_TEST = await isTestRequest(request, env);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
      const cors = corsHeaders(request, env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const res = await handle(request, env, ctx, url);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors })) if (!out.headers.has(k) || k in cors) out.headers.set(k, v);
      return out;
    }
    const share = url.pathname.match(/^\/s\/([\w-]{36})\/?$/);
    if (share && ['GET', 'HEAD'].includes(request.method)) return sharePage(env, share[1]);
    // Workeren viser ikke selv hjemmesiden: alt andet sendes videre til den rigtige side.
    return Response.redirect(siteUrl(env), 301);
  },

  // Daily (see [triggers] in wrangler.toml): clean up uploads that were started but never finished,
  // so their parts stop taking up (billable) space.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(abandonUploads(env, `created_at < ?`, [isoAgo(48 * 3600)], 'submissions'));
    // Kommentarer: den hashede IP-adresse bruges kun mod spam og ryddes efter 30 dage.
    ctx.waitUntil(env.DB.prepare(`UPDATE comments SET ip_hash = '' WHERE ip_hash != '' AND created_at < ?`).bind(isoAgo(30 * 86400)).run());
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
    throw new HttpError(507, 'archive_full');
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
  return new HttpError(503, 'monthly_limit');
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
    if (err instanceof HttpError) return json({ error: err.message, code: err.code, params: err.params }, err.status);
    console.error(err && err.stack ? err.stack : err);
    return json({ error: ERRORS.server, code: 'server' }, 500);
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'cross-origin',
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// Ændringer fra browseren skal komme fra vores egen side (eller workerens eget domæne).
// Ændringer skal komme fra en browser på den rigtige hjemmeside. Origin og Sec-Fetch-* kan
// forfalskes af scripts, men bidrag kræver desuden et Turnstile-token, der kun udstedes til en
// browser på hjemmesiden, og alle uploads kræver det upload-token, som det bidrag gav.
function requireOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).includes(origin)) throw new HttpError(403, 'origin');
  const mode = request.headers.get('sec-fetch-mode');
  const site = request.headers.get('sec-fetch-site');
  if ((mode && mode !== 'cors') || site === 'none') throw new HttpError(403, 'origin');
}

function siteUrl(env) {
  return env.SITE_URL || `${allowedOrigins(env)[0] || ''}/`;
}

// Den automatiske test (GitHub Actions) sender et token afledt af ADMIN_TOKEN. Så springes
// Turnstile over, og bidraget markeres som test (vises aldrig offentligt).
async function isTestRequest(request, env) {
  const token = request.headers.get('x-e2e-token');
  if (!token || !env.ADMIN_TOKEN) return false;
  return safeEqual(token, await sha256(`e2e:${env.ADMIN_TOKEN}`));
}

// ALLOWED_ORIGINS: comma separated list of sites allowed to call the API, e.g. "https://sloev.github.io".
function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins(env);
  if (!origin || !(allowed.includes(origin) || allowed.includes('*'))) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-upload-token, x-e2e-token, range',
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
    await requireAdmin(request, env);
    return adminApi(request, env, url, path, method, ctx);
  }

  if (path === '/api/config' && method === 'GET') return getConfig(env);
  if (path === '/api/stats' && method === 'GET') return getStats(env);
  if (path === '/api/contributions' && method === 'GET') return listContributions(env, url);
  if (path === '/api/map' && method === 'GET') return getMap(env);
  if (path === '/api/archive' && method === 'GET') return getArchive(env);
  if ((m = path.match(/^\/api\/contributions\/([\w-]+)$/)) && method === 'GET') return getContribution(env, m[1]);
  if ((m = path.match(/^\/api\/contributions\/([\w-]+)\/comments$/)) && method === 'GET') return listComments(env, m[1]);
  if (path === '/api/comments/ticket' && method === 'GET') return commentTicket(request, env, url);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) requireOrigin(request, env);
  if ((m = path.match(/^\/api\/contributions\/([\w-]+)\/report$/)) && method === 'POST') return reportContribution(request, env, m[1]);
  if ((m = path.match(/^\/api\/contributions\/([\w-]+)\/comments$/)) && method === 'POST') return createComment(request, env, m[1]);
  if ((m = path.match(/^\/api\/comments\/([\w-]+)\/report$/)) && method === 'POST') return reportComment(request, env, m[1]);
  if (path === '/api/submissions' && method === 'POST') return createSubmission(request, env);
  if ((m = path.match(/^\/api\/upload\/([\w-]+)\/(\d+)$/)) && method === 'PUT') return uploadPart(request, env, m[1], Number(m[2]));
  if ((m = path.match(/^\/api\/upload\/([\w-]+)\/complete$/)) && method === 'POST') return completeUpload(request, env, m[1]);
  if ((m = path.match(/^\/api\/submissions\/([\w-]+)\/complete$/)) && method === 'POST') return completeSubmission(request, env, ctx, m[1]);

  throw new HttpError(404, 'not_found');
}

async function adminApi(request, env, url, path, method, ctx) {
  let m;
  if (path === '/api/admin/submissions' && method === 'GET') return adminList(env, url);
  if ((m = path.match(/^\/api\/admin\/submissions\/([\w-]+)$/))) {
    if (method === 'PATCH') return adminSetStatus(request, env, m[1]);
    if (method === 'PUT') return adminEdit(request, env, m[1]);
    if (method === 'DELETE') return adminDelete(env, m[1]);
  }
  if ((m = path.match(/^\/api\/admin\/items\/([\w-]+)\/retry$/)) && method === 'POST') return adminRetry(env, m[1]);
  if ((m = path.match(/^\/api\/admin\/items\/([\w-]+)\/result$/)) && method === 'POST') return adminResult(request, env, m[1]);
  if (path === '/api/admin/queue-size' && method === 'GET') return adminQueueSize(env);
  if (path === '/api/admin/queue/claim' && method === 'POST') return adminClaim(request, env);
  if (path === '/api/admin/export' && method === 'GET') return adminExport(env);
  if (path === '/api/admin/comments' && method === 'GET') return adminComments(env, url);
  if ((m = path.match(/^\/api\/admin\/comments\/([\w-]+)$/))) {
    if (method === 'PATCH') return adminCommentStatus(request, env, m[1]);
    if (method === 'DELETE') return adminCommentDelete(env, m[1]);
  }
  if (path === '/api/admin/import' && method === 'POST') return adminImport(request, env);
  if ((m = path.match(/^\/api\/admin\/import\/([\w-]+)$/)) && method === 'PUT') return adminImportFile(request, env, ctx, m[1]);
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
  throw new HttpError(404, 'not_found');
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
      comments: commentsOpen(env) ? (env.COMMENT_MODERATION === 'auto' ? 'auto' : 'pre') : 'closed',
      contactEmail: env.CONTACT_EMAIL || '',
      relations: RELATIONS,
      perspectives: PERSPECTIVES,
      limits: LIMITS,
      shareBase: `${env.PUBLIC_ORIGIN}/s/`,
    },
    200,
    { 'cache-control': 'public, max-age=300' },
  );
}

async function getStats(env) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM submissions WHERE status = 'published' AND is_test = 0) AS contributions,
       COUNT(CASE WHEN i.kind = 'image' THEN 1 END) AS images,
       COUNT(CASE WHEN i.kind = 'video' THEN 1 END) AS videos,
       COUNT(CASE WHEN i.kind = 'audio' THEN 1 END) AS audio,
       COUNT(CASE WHEN i.kind = 'document' THEN 1 END) AS documents
     FROM items i JOIN submissions s ON s.id = i.submission_id
     WHERE s.status = 'published' AND s.is_test = 0 AND i.status = 'ready'`,
  ).first();
  return json(row, 200, { 'cache-control': 'public, max-age=60' });
}

async function listContributions(env, url) {
  const limit = clamp(Number(url.searchParams.get('limit')) || 24, 1, 60);
  const before = url.searchParams.get('before');
  const kind = url.searchParams.get('kind') || '';
  const relation = url.searchParams.get('relation') || '';
  const perspective = url.searchParams.get('perspective') || '';

  const where = [`s.status = 'published'`, env.IS_TEST ? '1 = 1' : 's.is_test = 0'];
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
  const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ? AND status = 'published' AND (is_test = 0 OR ?)`)
    .bind(id, env.IS_TEST ? 1 : 0)
    .first();
  if (!sub) throw new HttpError(404, 'contribution_gone');
  const [out] = await withItems(env, [sub]);
  return json(out, 200, { 'cache-control': 'public, max-age=30' });
}

async function getMap(env) {
  const { results } = await env.DB.prepare(
    `SELECT i.*, s.title AS s_title FROM items i JOIN submissions s ON s.id = i.submission_id
     WHERE s.status = 'published' AND s.is_test = 0 AND i.status = 'ready'
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

// Hele arkivet som én PDF. Bygges dagligt af GitHub Actions (.github/workflows/pdf.yml), kun når der
// er sket noget siden sidst, og lægges i R2 under media/arkiv/ sammen med info.json.
const ARCHIVE_PDF = 'media/arkiv/siloerne.pdf';
const ARCHIVE_INFO = 'media/arkiv/info.json';

async function getArchive(env) {
  const obj = await env.BUCKET.get(ARCHIVE_INFO);
  const info = obj ? await obj.json().catch(() => null) : null;
  const out = info
    ? { available: true, url: mediaUrl(env, ARCHIVE_PDF), generatedAt: info.generatedAt, count: info.count, bytes: info.bytes, fingerprint: info.fingerprint }
    : { available: false };
  return json(out, 200, { 'cache-control': 'public, max-age=300' });
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
    credit: s.show_credit ? s.credit : '',
    source: s.source_url ? { url: s.source_url, license: s.license, licenseUrl: s.license_url } : null,
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

  // --- billige spam-tjek først
  if (body.website || body.url || body.phone) throw new HttpError(400, 'rejected'); // honeypots
  if (typeof body.elapsedMs !== 'number' || body.elapsedMs < 5000) throw new HttpError(400, 'too_fast');

  if (!env.IS_TEST) await verifyTurnstile(env, body.turnstileToken, ip, request);

  const ipHash = await sha256(`${env.IP_SALT || ''}:${ip}`);
  const recent = await env.DB.prepare(
    `SELECT
       COUNT(CASE WHEN created_at > ? THEN 1 END) AS hour,
       COUNT(*) AS day
     FROM submissions WHERE ip_hash = ? AND created_at > ?`,
  )
    .bind(isoAgo(3600), ipHash, isoAgo(86400))
    .first();
  // Ét bidrag pr. fil, så grænserne er sat til mange billeder i træk (pladsen er begrænset af IP_DAILY_GB).
  if (recent.hour >= 40 || recent.day >= 200) {
    throw new HttpError(429, 'rate_limited');
  }

  // --- rens og tjek alle felter
  const title = field(body.title, 'title');
  const story = field(body.story, 'story', true);
  const period = field(body.period, 'period');
  const place = field(body.place, 'place');
  const credit = field(body.credit, 'credit');
  const email = field(body.email, 'email').toLowerCase();
  const relation = Object.hasOwn(RELATIONS, body.relation) ? body.relation : '';
  const perspective = Object.hasOwn(PERSPECTIVES, body.perspective) ? body.perspective : '';
  if (credit.length < 2) throw new HttpError(400, 'credit_missing');
  if (email && !/^[^\s@<>()",;:]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) throw new HttpError(400, 'email_invalid');
  if (body.consent !== true) throw new HttpError(400, 'consent_missing');
  checkSpam([title, story, period, place, credit].join('\n'));

  // Den samme historie uden filer må ikke sendes igen (typisk spam-mønster). Samme beskrivelse på
  // flere billeder er fint.
  const hasFiles = Array.isArray(body.files) && body.files.length > 0;
  const textHash = story.length >= 40 && !hasFiles && !env.IS_TEST ? await sha256(story.toLowerCase().replace(/\s+/g, ' ')) : '';
  if (textHash) {
    const dup = await env.DB.prepare(`SELECT 1 FROM submissions WHERE text_hash = ? AND created_at > ? LIMIT 1`)
      .bind(textHash, isoAgo(30 * 86400))
      .first();
    if (dup) throw new HttpError(409, 'duplicate');
  }

  const maxFiles = Number(env.MAX_FILES || 40);
  const maxBytes = Number(env.MAX_FILE_MB || 2048) * 1024 * 1024;
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > maxFiles) throw new HttpError(400, 'too_many_files', { max: maxFiles });
  if (!files.length && story.length < 20) throw new HttpError(400, 'nothing');

  const subId = crypto.randomUUID();
  const now = new Date().toISOString();
  const uploadToken = randomHex(24);

  const items = [];
  for (const [idx, f] of files.entries()) {
    const fname = clean(f && f.name, LIMITS.fileName).replace(/[\\/:*?"<>|]/g, '_') || 'fil';
    const size = Number(f && f.size);
    const type = /^[a-z]+\/[\w.+-]{1,80}$/i.test(String((f && f.type) || '')) ? String(f.type).toLowerCase() : '';
    if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'file_empty', { name: fname });
    if (size > maxBytes) throw new HttpError(400, 'file_too_big', { name: fname, mb: Number(env.MAX_FILE_MB || 2048) });
    const kind = kindOf(fname, type);
    if (!kind) throw new HttpError(400, 'file_type', { name: fname });
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
  const maxSubmission = Number(env.MAX_SUBMISSION_GB || 10) * GB;
  if (incoming > maxSubmission) throw new HttpError(400, 'submission_too_big', { gb: Number(env.MAX_SUBMISSION_GB || 10) });
  // Ingen enkelt afsender må fylde arkivet op: højst IP_DAILY_GB pr. døgn.
  if (incoming) {
    const day = await env.DB.prepare(
      `SELECT COALESCE(SUM(i.original_size), 0) AS bytes FROM items i JOIN submissions s ON s.id = i.submission_id
       WHERE s.ip_hash = ? AND s.created_at > ?`,
    )
      .bind(ipHash, isoAgo(86400))
      .first();
    if (day.bytes + incoming > Number(env.IP_DAILY_GB || 20) * GB) {
      throw new HttpError(429, 'daily_bytes');
    }
  }
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
      `INSERT INTO submissions (id, created_at, status, title, story, period, place, perspective, relation, credit, show_credit,
         email, share_location, contact_ok, upload_token, ip_hash, user_agent, text_hash, is_test)
       VALUES (?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      subId, now, title, story, period, place, perspective, relation, credit, body.showCredit === true ? 1 : 0,
      email, 1 /* GPS vises altid */, body.contactOk === true && email ? 1 : 0,
      uploadToken, ipHash, clean(request.headers.get('user-agent'), 300), textHash, env.IS_TEST ? 1 : 0,
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
    `SELECT i.*, s.upload_token, s.created_at AS s_created, s.user_agent AS s_ua FROM items i JOIN submissions s ON s.id = i.submission_id WHERE i.id = ?`,
  )
    .bind(itemId)
    .first();
  if (!row || !safeEqual(row.upload_token, request.headers.get('x-upload-token') || '')) throw new HttpError(403, 'upload_invalid');
  // Upload-tokenet hører til den browser, der startede bidraget.
  if (row.s_ua !== clean(request.headers.get('user-agent'), 300)) throw new HttpError(403, 'upload_invalid');
  if (row.status !== 'uploading') throw new HttpError(409, 'upload_received');
  if (Date.parse(row.s_created) < Date.now() - 48 * 3600 * 1000) throw new HttpError(410, 'upload_expired');
  return row;
}

async function uploadPart(request, env, itemId, partNumber) {
  const item = await loadUploadItem(request, env, itemId);
  const parts = Math.ceil(item.original_size / CHUNK_SIZE);
  if (partNumber < 1 || partNumber > parts) throw new HttpError(400, 'part_invalid');
  const expected = Math.min(CHUNK_SIZE, item.original_size - (partNumber - 1) * CHUNK_SIZE);
  const length = Number(request.headers.get('content-length'));
  if (length !== expected) throw new HttpError(400, 'part_size');
  await chargeClassA(env, 1);
  let body = request.body;
  if (partNumber === 1) {
    // Tjek filens første bytes: er det virkelig et billede/video/lyd/PDF som påstået?
    body = await request.arrayBuffer();
    if (body.byteLength !== expected) throw new HttpError(400, 'part_size');
    if (!sniffOk(new Uint8Array(body, 0, Math.min(64, body.byteLength)), item.kind)) {
      await rejectUpload(env, item, 'filindholdet passer ikke til filtypen');
      throw new HttpError(415, 'file_not_media');
    }
  }
  const mpu = env.BUCKET.resumeMultipartUpload(item.original_key, item.upload_id);
  const part = await mpu.uploadPart(partNumber, body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function completeUpload(request, env, itemId) {
  const item = await loadUploadItem(request, env, itemId);
  const body = await readJson(request, 100_000);
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (parts.length !== Math.ceil(item.original_size / CHUNK_SIZE)) throw new HttpError(400, 'file_missing_parts');
  await chargeClassA(env, 1);
  const mpu = env.BUCKET.resumeMultipartUpload(item.original_key, item.upload_id);
  const obj = await mpu.complete(
    parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })).sort((a, b) => a.partNumber - b.partNumber),
  );
  if (obj.size !== item.original_size) {
    await env.BUCKET.delete(item.original_key);
    await env.DB.prepare(`UPDATE items SET status = 'failed', error = 'size mismatch' WHERE id = ?`).bind(itemId).run();
    throw new HttpError(400, 'file_corrupt');
  }
  await env.DB.prepare(`UPDATE items SET status = 'pending', upload_id = NULL WHERE id = ?`).bind(itemId).run();
  return json({ ok: true });
}

async function completeSubmission(request, env, ctx, subId) {
  const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(subId).first();
  if (!sub || !safeEqual(sub.upload_token, request.headers.get('x-upload-token') || '')) throw new HttpError(403, 'upload_invalid');
  if (sub.status !== 'uploading') return json({ ok: true, status: sub.status });

  await abandonUploads(env, `submission_id = ?`, [subId]);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending FROM items WHERE submission_id = ?`,
  )
    .bind(subId)
    .first();
  if (counts.total > 0 && counts.pending === 0 && sub.story.length < 20) {
    await env.DB.prepare(`UPDATE submissions SET status = 'hidden' WHERE id = ?`).bind(subId).run();
    throw new HttpError(400, 'none_through');
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
  if (!sub) throw new HttpError(404, 'not_found');
  const today = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at > ?`)
    .bind(ipHash, isoAgo(86400))
    .first();
  if (today.n >= 20) throw new HttpError(429, 'report_limit');
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO reports (submission_id, ip_hash, reason, created_at) VALUES (?, ?, ?, ?)`)
    .bind(subId, ipHash, clean(body.reason, LIMITS.reason, true), new Date().toISOString())
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

// ---------------------------------------------------------------- comments
//
// Hård spambeskyttelse i lag – billigste tjek først:
//   1. kun fra hjemmesiden (Origin + Sec-Fetch, som alle indsendelser)
//   2. honeypot-felter
//   3. billet: hentes, når man begynder at skrive; signeret (HMAC), bundet til IP-adresse og bidrag,
//      skal være mindst MIN_AGE gammel og højst 2 timer, og kan kun bruges én gang
//   4. proof of work: browseren skal finde et tal, så sha256(billet:tal) starter med POW_ZEROS nuller
//      (laves i baggrunden, mens man skriver – dyrt for spambots, gratis for mennesker)
//   5. Cloudflare Turnstile (action "kommentar")
//   6. grænser pr. IP, pr. bidrag og for hele siden
//   7. indhold: ingen links/e-mails/telefonnumre, spamord, gentagelser, ikke-latinsk skrift, dubletter
//   8. forhåndsgodkendelse: alt venter på en admin (COMMENT_MODERATION = "auto" viser rene kommentarer
//      med det samme), og tre anmeldelser skjuler en kommentar igen

const COMMENT = {
  MIN_AGE_MS: 6000,
  MAX_AGE_MS: 2 * 3600 * 1000,
  POW_ZEROS: 4, // hex-nuller = 16 bit ≈ 65.000 forsøg
  PER_IP_10MIN: 3,
  PER_IP_DAY: 10,
  PER_SUBMISSION_HOUR: 20,
  SITE_DAY: 300,
  PER_SUBMISSION_MAX: 300,
};

// Links (også uden http), e-mails og telefonnumre. Kun kendte domæneendelser, så "siloen.Det" uden
// mellemrum ikke rammes; årstal som "1898-1900" er ikke telefonnumre.
const COMMENT_LINK =
  /https?:|www\.|\b[a-z0-9-]{2,}\s?(?:\.|\[\.\]|\(dot\))\s?(?:com|net|org|dk|de|se|no|eu|info|biz|io|xyz|ru|cn|top|shop|online|site|ly|co|me|app|link|click|uk|nl|fr|it|pl|us|tk|gg|to|cc|tv|ai|live|store|club|vip|win|bid|loan|work|space|fun|icu|cyou|monster|buzz|rest|bar|lol|sbs|cfd|xxx|porn|sex|cam|dating|bet|casino)\b/i;
const COMMENT_PHONE = /\+\d{2}[\s-]?\d|\b\d{8}\b|\b\d{2}(?:[ .-]\d{2}){3}\b/;

function commentsOpen(env) {
  return env.COMMENTS !== 'off';
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`comment-ticket:${env.ADMIN_TOKEN || ''}:${env.IP_SALT || ''}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function ipHashOf(request, env) {
  return sha256(`${env.IP_SALT || ''}:${request.headers.get('cf-connecting-ip') || '0.0.0.0'}`);
}

async function publishedSubmission(env, id) {
  return env.DB.prepare(`SELECT id FROM submissions WHERE id = ? AND status = 'published' AND (is_test = 0 OR ?)`)
    .bind(id, env.IS_TEST ? 1 : 0)
    .first();
}

async function listComments(env, subId) {
  if (!(await publishedSubmission(env, subId))) throw new HttpError(404, 'contribution_gone');
  const { results } = await env.DB.prepare(
    `SELECT id, name, body, created_at FROM comments
     WHERE submission_id = ? AND status = 'published' AND (is_test = 0 OR ?)
     ORDER BY created_at LIMIT 500`,
  )
    .bind(subId, env.IS_TEST ? 1 : 0)
    .all();
  return json(
    { comments: results.map((c) => ({ id: c.id, name: c.name, body: c.body, createdAt: c.created_at })) },
    200,
    { 'cache-control': 'public, max-age=30' },
  );
}

async function commentTicket(request, env, url) {
  if (!commentsOpen(env)) throw new HttpError(403, 'comments_closed');
  const subId = String(url.searchParams.get('submission') || '');
  if (!/^[\w-]{36}$/.test(subId) || !(await publishedSubmission(env, subId))) throw new HttpError(404, 'contribution_gone');
  const ts = Date.now();
  const sig = await hmac(env, `${subId}.${ts}.${await ipHashOf(request, env)}`);
  return json({ ticket: `${subId}.${ts}.${sig}`, zeros: COMMENT.POW_ZEROS, minAgeMs: COMMENT.MIN_AGE_MS }, 200, { 'cache-control': 'no-store' });
}

async function createComment(request, env, subId) {
  if (!commentsOpen(env)) throw new HttpError(403, 'comments_closed');
  const body = await readJson(request, 20_000);
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const ipHash = await ipHashOf(request, env);

  // 2. honeypots
  if (body.website || body.url || body.phone || body.email) throw new HttpError(400, 'rejected');

  // 3. billet
  const ticket = String(body.ticket || '');
  const [tSub, tTs, tSig] = ticket.split('.');
  if (tSub !== subId || !/^\d{13}$/.test(tTs || '') || !tSig) throw new HttpError(400, 'comment_ticket');
  if (!safeEqual(tSig, await hmac(env, `${tSub}.${tTs}.${ipHash}`))) throw new HttpError(400, 'comment_ticket');
  const age = Date.now() - Number(tTs);
  if (age < COMMENT.MIN_AGE_MS) throw new HttpError(400, 'too_fast');
  if (age > COMMENT.MAX_AGE_MS) throw new HttpError(400, 'comment_ticket');

  // 4. proof of work
  const nonce = String(body.nonce ?? '');
  if (!/^\d{1,12}$/.test(nonce) || !(await sha256(`${ticket}:${nonce}`)).startsWith('0'.repeat(COMMENT.POW_ZEROS))) {
    throw new HttpError(400, 'comment_pow');
  }

  // 5. Turnstile
  if (!env.IS_TEST) await verifyTurnstile(env, body.turnstileToken, ip, request, 'kommentar');

  // 6. grænser
  const sub = await publishedSubmission(env, subId);
  if (!sub) throw new HttpError(404, 'contribution_gone');
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM comments WHERE ip_hash = ? AND created_at > ?) AS ip10,
       (SELECT COUNT(*) FROM comments WHERE ip_hash = ? AND created_at > ?) AS ipDay,
       (SELECT COUNT(*) FROM comments WHERE submission_id = ? AND created_at > ?) AS subHour,
       (SELECT COUNT(*) FROM comments WHERE submission_id = ?) AS subAll,
       (SELECT COUNT(*) FROM comments WHERE created_at > ?) AS siteDay,
       (SELECT COUNT(*) FROM comments WHERE ticket = ?) AS used`,
  )
    .bind(ipHash, isoAgo(600), ipHash, isoAgo(86400), subId, isoAgo(3600), subId, isoAgo(86400), ticket)
    .first();
  if (counts.used) throw new HttpError(400, 'comment_ticket');
  if (!env.IS_TEST && (counts.ip10 >= COMMENT.PER_IP_10MIN || counts.ipDay >= COMMENT.PER_IP_DAY)) throw new HttpError(429, 'comment_rate');
  if (counts.subHour >= COMMENT.PER_SUBMISSION_HOUR || counts.siteDay >= COMMENT.SITE_DAY || counts.subAll >= COMMENT.PER_SUBMISSION_MAX) {
    throw new HttpError(429, 'comments_busy');
  }

  // 7. indhold
  const name = field(body.name, 'commentName');
  const text = field(body.body, 'comment', true);
  if (name.length < 2) throw new HttpError(400, 'name_missing');
  if (text.replace(/\s/g, '').length < 3) throw new HttpError(400, 'comment_short');
  const all = `${name}\n${text}`;
  if (COMMENT_LINK.test(all) || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(all) || COMMENT_PHONE.test(all)) {
    throw new HttpError(400, 'comment_links');
  }
  checkSpam(all);
  if (/(.)\1{9,}/u.test(all)) throw new HttpError(400, 'spam_repeat');
  const textHash = await sha256(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  const dup = await env.DB.prepare(`SELECT 1 FROM comments WHERE text_hash = ? AND created_at > ? LIMIT 1`)
    .bind(textHash, isoAgo(30 * 86400))
    .first();
  if (dup && !env.IS_TEST) throw new HttpError(409, 'duplicate_comment');

  // Bløde tegn på spam: kommentaren venter altid på godkendelse, også med COMMENT_MODERATION = "auto".
  const reasons = [];
  const letters = text.match(/\p{L}/gu) || [];
  const upper = text.match(/\p{Lu}/gu) || [];
  if (letters.length > 20 && upper.length / letters.length > 0.6) reasons.push('versaler');
  if ((text.match(/[!?]/g) || []).length > 8) reasons.push('udråbstegn');
  if (counts.ipDay >= 3) reasons.push('mange fra samme IP');
  if (age < 10_000 && text.length > 150) reasons.push('skrevet meget hurtigt');
  if (/(.{12,})[\s\S]*\1[\s\S]*\1/u.test(text)) reasons.push('gentagelser');
  const status = env.COMMENT_MODERATION === 'auto' && !reasons.length ? 'published' : 'pending';

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO comments (id, submission_id, created_at, status, name, body, ip_hash, text_hash, ticket, spam_score, spam_reasons, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, subId, new Date().toISOString(), status, name, text, ipHash, textHash, ticket, reasons.length, reasons.join(', '), env.IS_TEST ? 1 : 0)
    .run();
  return json({ ok: true, id, status });
}

async function reportComment(request, env, id) {
  const ipHash = await ipHashOf(request, env);
  const c = await env.DB.prepare(`SELECT id FROM comments WHERE id = ? AND status = 'published'`).bind(id).first();
  if (!c) throw new HttpError(404, 'not_found');
  const today = await env.DB.prepare(`SELECT COUNT(*) AS n FROM comment_reports WHERE ip_hash = ? AND created_at > ?`)
    .bind(ipHash, isoAgo(86400))
    .first();
  if (today.n >= 20) throw new HttpError(429, 'report_limit');
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO comment_reports (comment_id, ip_hash, created_at) VALUES (?, ?, ?)`)
    .bind(id, ipHash, new Date().toISOString())
    .run();
  if (res.meta.changes) {
    await env.DB.prepare(
      `UPDATE comments SET reports = reports + 1,
         status = CASE WHEN reports + 1 >= 3 AND status = 'published' THEN 'pending' ELSE status END
       WHERE id = ?`,
    )
      .bind(id)
      .run();
  }
  return json({ ok: true });
}

async function adminComments(env, url) {
  const status = url.searchParams.get('status') || '';
  const before = url.searchParams.get('before');
  const where = [];
  const params = [];
  if (['pending', 'published', 'hidden'].includes(status)) {
    where.push('c.status = ?');
    params.push(status);
  }
  if (before) {
    where.push('c.created_at < ?');
    params.push(before);
  }
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.submission_id, c.created_at, c.status, c.name, c.body, c.spam_score, c.spam_reasons, c.reports, c.is_test,
            s.title AS submission_title
     FROM comments c JOIN submissions s ON s.id = c.submission_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.created_at DESC LIMIT 51`,
  )
    .bind(...params)
    .all();
  const { results: counts } = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM comments GROUP BY status`).all();
  return json({
    comments: results.slice(0, 50),
    next: results.length > 50 ? results[49].created_at : null,
    counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
  });
}

async function adminCommentStatus(request, env, id) {
  const { status } = await readJson(request, 1000);
  if (!['pending', 'published', 'hidden'].includes(status)) throw new HttpError(400, 'invalid_status');
  const res = await env.DB.prepare(`UPDATE comments SET status = ?, reports = CASE WHEN ? = 'published' THEN 0 ELSE reports END WHERE id = ?`)
    .bind(status, status, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, 'not_found');
  if (status === 'published') await env.DB.prepare(`DELETE FROM comment_reports WHERE comment_id = ?`).bind(id).run();
  return json({ ok: true });
}

async function adminCommentDelete(env, id) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM comment_reports WHERE comment_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(id),
  ]);
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

async function verifyTurnstile(env, token, ip, request, action = 'bidrag') {
  if (env.TURNSTILE_SECRET === 'disabled') return; // local development only
  if (!env.TURNSTILE_SECRET) throw new HttpError(500, 'turnstile_not_configured');
  if (typeof token !== 'string' || !token || token.length > 2048) throw new HttpError(400, 'turnstile_missing');
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const out = await res.json();
  if (!out.success) throw new HttpError(400, 'turnstile_failed');
  // Tokenet skal være udstedt til vores egen side og til netop denne formular.
  const hosts = allowedOrigins(env).map((o) => new URL(o).hostname);
  if (!out.hostname || !hosts.includes(out.hostname)) throw new HttpError(400, 'turnstile_wrong_site');
  if (out.action !== action) throw new HttpError(400, 'turnstile_failed');
}

// ---------------------------------------------------------------- delelinks med forhåndsvisning

// /s/<id>: en lille side med Open Graph- og Twitter-tags, så links til et bidrag får et pænt
// kort på Facebook, Messenger, X, LinkedIn, Slack osv. Mennesker sendes videre til hjemmesiden.
async function sharePage(env, id) {
  const site = siteUrl(env);
  const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ? AND status = 'published' AND (is_test = 0 OR ?)`)
    .bind(id, env.IS_TEST ? 1 : 0)
    .first();
  if (!sub) return Response.redirect(site, 302);
  const { results: items } = await env.DB.prepare(`SELECT * FROM items WHERE submission_id = ? AND status = 'ready' ORDER BY position`).bind(id).all();
  const target = `${site}#bidrag/${id}`;
  const shareUrl = `${env.PUBLIC_ORIGIN}/s/${id}`;

  let image = `${site}og.jpg`;
  let video = null;
  const first = items.find((i) => i.kind === 'image' || i.kind === 'video');
  if (first) {
    const og = `media/${first.id}/og.jpg`;
    const has = await env.BUCKET.head(og);
    image = mediaUrl(env, has ? og : first.poster_key || first.display_key);
    if (first.kind === 'video') video = mediaUrl(env, first.display_key);
  }
  const counts = items.reduce((m, i) => ((m[i.kind] = (m[i.kind] || 0) + 1), m), {});
  const what = [
    counts.image && `${counts.image} ${counts.image === 1 ? 'billede' : 'billeder'}`,
    counts.video && `${counts.video} ${counts.video === 1 ? 'video' : 'videoer'}`,
    counts.audio && `${counts.audio} lydoptagelse${counts.audio === 1 ? '' : 'r'}`,
  ].filter(Boolean).join(', ');
  const story = plainText(sub.story);
  const title = sub.title || (story ? truncate(story, 70) : 'Et bidrag om siloerne');
  const desc = truncate(
    [story, what && `(${what})`, sub.show_credit && sub.credit ? `– ${sub.credit}` : ''].filter(Boolean).join(' ') ||
      'Billeder, videoer og historier om siloerne på Østre Kaj i Svendborg.',
    200,
  );
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} – Siloerne på Østre Kaj</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="${e(target)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Siloerne på Østre Kaj">
<meta property="og:locale" content="da_DK">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:url" content="${e(shareUrl)}">
<meta property="og:image" content="${e(image)}">
<meta property="og:image:alt" content="${e(title)}">
${video ? `<meta property="og:video" content="${e(video)}">\n<meta property="og:video:type" content="video/mp4">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(desc)}">
<meta name="twitter:image" content="${e(image)}">
<meta http-equiv="refresh" content="0; url=${e(target)}">
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f5f1ea;color:#14324a;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}a{color:#1d8a74}</style>
</head>
<body><p><a href="${e(target)}">Se bidraget om siloerne på Østre Kaj →</a></p></body>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https:; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}

// Historier gemmes som simpel Markdown (fed, kursiv, overskrifter, lister, links). Uden tegnene:
function plainText(md) {
  return String(md || '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(?!\s)(.+?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^([-*•]|\d+[.)])\s+/gm, '');
}

function truncate(str, max) {
  str = String(str || '').replace(/\s+/g, ' ').trim();
  return str.length > max ? `${str.slice(0, max - 1).trimEnd()}…` : str;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------- media

async function serveMedia(request, env, url) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'method');
  const key = decodeURIComponent(url.pathname.slice(1)); // /media/<item>/<file> → R2 key media/<item>/<file>
  if (!/^media\/[\w-]+\/[\w.-]+$/.test(key)) throw new HttpError(404, 'not_found');
  const obj = await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) throw new HttpError(404, 'not_found');

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (key.startsWith('media/arkiv/')) {
    // Overskrives dagligt, så kun kort cache.
    headers.set('cache-control', 'public, max-age=300');
    if (key === ARCHIVE_PDF) headers.set('content-disposition', `attachment; filename="siloerne-paa-oestre-kaj-${obj.uploaded.toISOString().slice(0, 10)}.pdf"`);
  } else {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    if (key.endsWith('.pdf')) headers.set('content-disposition', 'attachment; filename="dokument.pdf"');
  }
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

async function requireAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new HttpError(500, 'admin_not_configured');
  const ipHash = await sha256(`${env.IP_SALT || ''}:${request.headers.get('cf-connecting-ip') || '0.0.0.0'}`);
  const fails = await env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_failures WHERE ip_hash = ? AND at > ?`)
    .bind(ipHash, isoAgo(3600))
    .first();
  if (fails.n >= 10) throw new HttpError(429, 'too_many_attempts');
  if (!safeEqual(token, env.ADMIN_TOKEN)) {
    await env.DB.prepare(`INSERT INTO auth_failures (ip_hash, at) VALUES (?, ?)`).bind(ipHash, new Date().toISOString()).run();
    throw new HttpError(401, 'wrong_password');
  }
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

// Redigér alle felter på et bidrag (og dato/kamera/placering på dets filer).
async function adminEdit(request, env, id) {
  const b = await readJson(request, 100_000);
  const sub = await env.DB.prepare(`SELECT id FROM submissions WHERE id = ?`).bind(id).first();
  if (!sub) throw new HttpError(404, 'not_found');
  const url = (v) => (/^https?:\/\//.test(String(v || '')) ? clean(v, 500) : '');
  await env.DB.prepare(
    `UPDATE submissions SET title = ?, story = ?, period = ?, place = ?, perspective = ?, relation = ?, credit = ?,
       show_credit = ?, email = ?, contact_ok = ?, source_url = ?, license = ?, license_url = ?
     WHERE id = ?`,
  )
    .bind(
      clean(b.title, LIMITS.title), clean(b.story, LIMITS.story, true), clean(b.period, LIMITS.period), clean(b.place, LIMITS.place),
      Object.hasOwn(PERSPECTIVES, b.perspective) ? b.perspective : '', Object.hasOwn(RELATIONS, b.relation) ? b.relation : '',
      clean(b.credit, LIMITS.credit), b.show_credit ? 1 : 0, clean(b.email, LIMITS.email).toLowerCase(), b.contact_ok ? 1 : 0,
      url(b.source_url), clean(b.license, 80), url(b.license_url), id,
    )
    .run();
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 50) : []) {
    const taken = clean(it.taken_at, 25);
    if (taken && !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(taken)) throw new HttpError(400, 'invalid_data');
    const lat = num(it.lat);
    const lon = num(it.lon);
    if ((lat !== null && Math.abs(lat) > 90) || (lon !== null && Math.abs(lon) > 180)) throw new HttpError(400, 'invalid_data');
    await env.DB.prepare(`UPDATE items SET taken_at = ?, camera = ?, lat = ?, lon = ? WHERE id = ? AND submission_id = ?`)
      .bind(taken ? taken.replace(' ', 'T') : null, clean(it.camera, 200) || null, lat, lon, String(it.id || ''), id)
      .run();
  }
  return json({ ok: true });
}

async function adminSetStatus(request, env, id) {
  const { status } = await request.json();
  if (!['published', 'hidden', 'review'].includes(status)) throw new HttpError(400, 'invalid_status');
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
    keys.push(i.original_key, i.full_key, i.display_key, i.thumb_key, i.poster_key, `media/${i.id}/og.jpg`);
  }
  const existing = keys.filter(Boolean);
  for (let n = 0; n < existing.length; n += 1000) await env.BUCKET.delete(existing.slice(n, n + 1000));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM items WHERE submission_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM reports WHERE submission_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE submission_id = ?)`).bind(id),
    env.DB.prepare(`DELETE FROM comments WHERE submission_id = ?`).bind(id),
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
  if (!res.meta.changes) throw new HttpError(409, 'original_deleted');
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
  // Kun det processoren skal bruge. Krediteringen kun hvis den må vises offentligt (den skrives ind i filerne).
  const creditOf = new Map();
  for (const sid of new Set(results.map((it) => it.submission_id))) {
    const row = await env.DB.prepare(`SELECT credit, show_credit FROM submissions WHERE id = ?`).bind(sid).first();
    if (row && row.show_credit) creditOf.set(sid, row.credit);
  }
  return json({
    items: results.map((it) => ({
      id: it.id,
      kind: it.kind,
      original_key: it.original_key,
      original_size: it.original_size,
      original_last_modified: it.original_last_modified,
      credit: creditOf.get(it.submission_id) || '',
    })),
  });
}

async function adminResult(request, env, id) {
  const b = await request.json();
  if (!b.ok) {
    const row = await env.DB.prepare(
      `UPDATE items SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, error = ? WHERE id = ? RETURNING status`,
    )
      .bind(clean(b.error, 2000), id)
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
      b.takenAt || null, clean(b.camera, 200) || null, num(b.lat), num(b.lon),
      b.metadata ? JSON.stringify(b.metadata) : null, b.archivePath || null,
      new Date().toISOString(), id,
    )
    .run();
  await deleteOriginal(env, id);
  return json({ ok: true });
}

// Import af åbent licenseret materiale (f.eks. Wikimedia Commons). Bidraget oprettes altid som
// "afventer godkendelse", så det først bliver offentligt, når en administrator har godkendt det.
async function adminImport(request, env) {
  const b = await readJson(request, 100_000);
  const sourceUrl = clean(b.sourceUrl, 500);
  if (!/^https:\/\//.test(sourceUrl)) throw new HttpError(400, 'invalid_data');
  const license = clean(b.license, 80);
  const licenseUrl = /^https?:\/\//.test(String(b.licenseUrl || '')) ? clean(b.licenseUrl, 300) : '';
  if (!license) throw new HttpError(400, 'invalid_data');
  const files = Array.isArray(b.files) ? b.files.slice(0, 10) : [];
  const dup = await env.DB.prepare(`SELECT id FROM submissions WHERE source_url = ? LIMIT 1`).bind(sourceUrl).first();
  if (dup) {
    // En tidligere import, hvor filen aldrig nåede frem: lad værktøjet uploade den igen.
    const { results: waiting } = await env.DB.prepare(
      `SELECT id, position, original_name FROM items WHERE submission_id = ? AND status = 'uploading' ORDER BY position`,
    )
      .bind(dup.id)
      .all();
    if (!waiting.length) return json({ duplicate: true, id: dup.id });
    for (const w of waiting) {
      const size = Number(files[w.position] && files[w.position].size);
      if (Number.isInteger(size) && size > 0 && size <= 95 * 1024 * 1024) {
        await env.DB.prepare(`UPDATE items SET original_size = ? WHERE id = ?`).bind(size, w.id).run();
      }
    }
    return json({ id: dup.id, resumed: true, items: waiting.map((w) => ({ id: w.id, name: w.original_name })) });
  }
  if (!files.length) throw new HttpError(400, 'nothing');
  const subId = crypto.randomUUID();
  const now = new Date().toISOString();
  const items = files.map((f, idx) => {
    const name = clean(f.name, LIMITS.fileName).replace(/[\\/:*?"<>|]/g, '_') || 'fil';
    const kind = kindOf(name, f.type);
    const size = Number(f.size);
    if (!kind || !Number.isInteger(size) || size <= 0 || size > 95 * 1024 * 1024) throw new HttpError(400, 'file_type', { name });
    const id = crypto.randomUUID();
    return { id, idx, name, kind, size, type: String(f.type || ''), key: `originals/${subId}/${id}.${extOf(name) || 'bin'}` };
  });
  await checkStorage(env, items.reduce((n, it) => n + it.size, 0));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO submissions (id, created_at, status, title, story, period, place, perspective, relation, credit, show_credit,
         email, share_location, contact_ok, upload_token, ip_hash, user_agent, text_hash, is_test, source_url, license, license_url)
       VALUES (?, ?, 'review', ?, ?, ?, ?, ?, '', ?, 1, '', 1, 0, ?, 'import', 'import', '', 0, ?, ?, ?)`,
    ).bind(
      subId, now, clean(b.title, LIMITS.title), clean(b.story, LIMITS.story, true), clean(b.period, LIMITS.period),
      clean(b.place, LIMITS.place), Object.hasOwn(PERSPECTIVES, b.perspective) ? b.perspective : '',
      clean(b.credit, LIMITS.credit) || 'Ukendt', randomHex(24), sourceUrl, license, licenseUrl,
    ),
    ...items.map((it) =>
      env.DB.prepare(
        `INSERT INTO items (id, submission_id, position, kind, original_key, original_name, original_type, original_size, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
      ).bind(it.id, subId, it.idx, it.kind, it.key, it.name, it.type, it.size),
    ),
  ]);
  return json({ id: subId, items: items.map((it) => ({ id: it.id, name: it.name })) });
}

async function adminImportFile(request, env, ctx, itemId) {
  const item = await env.DB.prepare(`SELECT * FROM items WHERE id = ? AND status = 'uploading'`).bind(itemId).first();
  if (!item) throw new HttpError(404, 'not_found');
  const data = await request.arrayBuffer();
  if (data.byteLength !== item.original_size) throw new HttpError(400, 'part_size');
  if (!sniffOk(new Uint8Array(data, 0, Math.min(64, data.byteLength)), item.kind)) throw new HttpError(415, 'file_not_media');
  await chargeClassA(env, 1);
  await env.BUCKET.put(item.original_key, data, { httpMetadata: { contentType: item.original_type || 'application/octet-stream' } });
  await env.DB.prepare(`UPDATE items SET status = 'pending' WHERE id = ?`).bind(itemId).run();
  ctx.waitUntil(triggerProcessing(env));
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
    if (!obj) throw new HttpError(404, 'not_found');
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
  throw new HttpError(405, 'method');
}

function requireKey(key) {
  if (!key || !/^(originals|media)\/[\w-]+\/[\w.-]+$/.test(key)) throw new HttpError(400, 'invalid_key');
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
  if (raw.length > maxBytes) throw new HttpError(413, 'too_much_data');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'invalid_data');
  }
}

// Renser tekst: Unicode-normalisering, ingen kontroltegn, usynlige tegn eller retnings-tricks,
// ingen HTML-tags, sammenklappede mellemrum. Afkorter til max tegn.
function clean(v, max, multiline = false) {
  if (v === undefined || v === null || typeof v === 'object') return '';
  let s = String(v).normalize('NFKC');
  s = s.replace(/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g, '');
  s = s.replace(/\r\n?/g, '\n').replace(/<\/?[a-z!][^>]*>/gi, '');
  if (multiline) {
    s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '').replace(/[ \t\u00A0]+/g, ' ');
    s = s.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ');
  }
  s = s.trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

// Som clean(), men afviser for lange felter i stedet for at afkorte dem.
function field(v, name, multiline = false) {
  const max = LIMITS[name];
  if (typeof v === 'string' && v.length > max * 2 + 100) throw new HttpError(400, 'field_too_long', { field: name, max });
  const s = clean(v, max * 2, multiline);
  if (s.length > max) throw new HttpError(400, 'field_too_long', { field: name, max });
  return s;
}

function checkSpam(all) {
  const links = (all.match(/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|ru|cn|xyz|top|info|biz|io|shop|online|site)\b/gi) || []).length;
  if (links > 2) throw new HttpError(400, 'spam_links');
  if (SPAM_WORDS.test(all)) throw new HttpError(400, 'spam_words');
  if (/(.)\1{24,}/u.test(all)) throw new HttpError(400, 'spam_repeat');
  const letters = all.match(/\p{L}/gu) || [];
  const latin = all.match(/\p{Script=Latin}/gu) || [];
  if (letters.length > 40 && latin.length / letters.length < 0.6) {
    throw new HttpError(400, 'spam_script');
  }
}

// Filsignaturer ("magic bytes") for de typer vi tager imod.
function sniffOk(b, kind) {
  const at = (off, ...bytes) => bytes.every((x, i) => b[off + i] === x);
  const ascii = (off, str) => [...str].every((c, i) => b[off + i] === c.charCodeAt(0));
  const ftyp = ascii(4, 'ftyp');
  const riff = ascii(0, 'RIFF');
  const tiff = at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a) || ascii(0, 'IIRO') || ascii(0, 'IIU') || ascii(0, 'FUJIFILM');
  if (kind === 'image') {
    return at(0, 0xff, 0xd8, 0xff) || at(0, 0x89, 0x50, 0x4e, 0x47) || ascii(0, 'GIF8') || (riff && ascii(8, 'WEBP')) || ftyp || tiff || ascii(0, 'BM');
  }
  if (kind === 'video') {
    return (
      ftyp || ['moov', 'mdat', 'wide', 'free', 'skip'].some((a) => ascii(4, a)) || (riff && ascii(8, 'AVI ')) ||
      at(0, 0x1a, 0x45, 0xdf, 0xa3) || b[0] === 0x47 || b[4] === 0x47 || at(0, 0x00, 0x00, 0x01, 0xba) || at(0, 0x30, 0x26, 0xb2, 0x75)
    );
  }
  if (kind === 'audio') {
    return (
      ascii(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || (riff && ascii(8, 'WAVE')) || ascii(0, 'OggS') ||
      ascii(0, 'fLaC') || ftyp || ascii(0, '#!AMR') || at(0, 0x30, 0x26, 0xb2, 0x75) || ascii(0, 'FORM')
    );
  }
  if (kind === 'document') return ascii(0, '%PDF');
  return false;
}

async function rejectUpload(env, item, reason) {
  await env.BUCKET.resumeMultipartUpload(item.original_key, item.upload_id).abort().catch(() => {});
  await env.DB.prepare(`UPDATE items SET status = 'failed', error = ?, upload_id = NULL, original_deleted = 1 WHERE id = ?`)
    .bind(reason, item.id)
    .run();
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

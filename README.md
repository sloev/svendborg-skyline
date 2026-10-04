# Siloerne på Østre Kaj

A Danish community site for collecting photos, videos, sound recordings, documents and stories
about the grain silos on Østre Kaj in Svendborg before they are demolished.
Context: [Svendborg Kommune – open call om fremtiden for siloerne](https://www.svendborg.dk/nyheder/open-call-om-fremtiden-for-siloerne-paa-oestre-kaj/).

Everything runs on free tiers:

| Part | Service | Free tier |
|---|---|---|
| Website | GitHub Pages (`public/`, `.github/workflows/pages.yml`) | free |
| API, uploads, media | Cloudflare Workers (`src/worker.js`) | 100k requests/day |
| Database | Cloudflare D1 | 5 GB |
| Uploads + web versions | Cloudflare R2 | 10 GB storage, free egress |
| Spam protection | Cloudflare Turnstile | free |
| Conversion (ffmpeg/exiftool) | GitHub Actions (`.github/workflows/process.yml`) | unlimited on public repos, 2,000 min/month on private ones |

## How it works

```
 Browser ──(1) form + Turnstile──▶ Worker ──▶ D1 (contribution, status "uploading")
    │                                │
    └─(2) files in 16 MB chunks ────▶ Worker ──▶ R2  originals/<id>/…   (temporary, R2 multipart upload)
                                     │
                     (3) "done" ─────┴──▶ GitHub repository_dispatch
                                               │
 GitHub Action: processor/process.mjs  ◀───────┘   (also runs every hour as a fallback)
    • exiftool reads ALL metadata          → stored in D1 and in a .json sidecar file
    • re-encodes to ONE format per media type (see "Formats and quality" below), copying the metadata
      (date, camera, GPS, …) into the new file
    • the worker deletes the original as soon as the result is in, or when processing has failed 3 times
```

**Originals are never kept.** Only the re-encoded files exist after processing.

**GPS is always kept and shown.** The position in photos and videos is stored in the files and shown
on the public map. The form says so in a highlighted notice and in the required consent checkbox.
It also marks each picked file that contains a position ("📍 GPS") before anything is sent, so
uploaders can remove it first if they want to.

Contributions appear on the site right away (`MODERATION = "post"`). Files show up as soon as they
have been converted, usually a few minutes later. Set `MODERATION = "pre"` if every contribution
should be approved in `/admin.html` first.

### Spam protection
- Cloudflare Turnstile on the form (verified on the server)
- Hidden honeypot field and a minimum time to fill in the form
- Rate limit per IP: 10 contributions per hour and 40 per day (only a salted hash of the IP is stored)
- At most 3 links per text, plus file type, file size and file count limits
- Every file chunk must carry a secret upload token, and its exact size is checked
- A "Anmeld" (report) button: 3 reports from different people hide a contribution until an admin looks at it
- `/admin.html` to hide, show or delete contributions, or to re-run processing

## Secrets

The repository is public. Every secret lives in **GitHub Actions secrets** or in the worker's
encrypted Cloudflare secrets. Nothing secret is committed, and the workflows never print secrets or
personal data: Action logs on a public repo are public.

GitHub Actions secrets used by the workflows:

| Secret | Used for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | looking up the worker's address (Pages + processing) |
| `CLOUDFLARE_ACCOUNT_ID` | the same |
| `ADMIN_TOKEN` | the processor talking to the worker; also the password for `/admin.html` |
| `TURNSTILE_SECRET`, `DISPATCH_TOKEN` | kept so the worker's secrets can be set again |

Worker secrets on Cloudflare: `ADMIN_TOKEN`, `TURNSTILE_SECRET`, `IP_SALT`, `GITHUB_TOKEN`
(= `DISPATCH_TOKEN`).

## Setup (done)

Cloudflare was set up once, with a temporary workflow that has since been removed from the
repository. It registered the `sloev.workers.dev` subdomain, created the D1 database and the R2
bucket `silo-arkiv`, ran the migrations, deployed the worker to https://silo-arkiv.sloev.workers.dev,
set the worker secrets and enabled the daily cron.

The website is published to GitHub Pages by `pages.yml` on every push to `master` that touches
`public/`.

### Updating the worker later

Pushes do **not** deploy the worker. To deploy a change to `src/`, `migrations/` or `wrangler.toml`,
run this on your own machine:

```sh
npm install
npx wrangler login
npx wrangler d1 list                      # copy the id of silo-arkiv into database_id in wrangler.toml (don't commit it)
npx wrangler d1 migrations apply silo-arkiv --remote
npx wrangler deploy
git checkout wrangler.toml                # put the placeholder back
```

To change a worker secret, run `npx wrangler secret put NAME`.

## Costs: hard limit of $5/month

Cloudflare has no setting that caps spending. Its [budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)
only send an e-mail. So the limit is built into the worker:

- **Workers, D1, Turnstile and Pages are free.** On the Free plan they stop at their limits instead
  of billing. Never subscribe to *Workers Paid*.
- **R2 is the only usage-billed part.** Free: 10 GB storage, 1M Class A (write) and 10M Class B
  (read) operations per month. Beyond that: $0.015/GB-month, $4.50 per million writes, $0.36 per
  million reads.
  - **Storage:** uploads are refused when the archive would exceed `STORAGE_LIMIT_GB` (250 GB).
    Worst case: (250 − 10) × $0.015 ≈ **$3.60/month**. Originals waiting for processing count too,
    and unfinished uploads are cleaned up daily.
  - **Writes:** the worker counts every R2 write and stops uploads at `CLASS_A_MONTHLY_LIMIT`
    (900,000), which stays inside the free million.
  - **Reads:** all media goes through the worker, which the Free plan caps at 100k requests a day
    (about 3M a month), so reads stay inside the free 10M. Keep `MEDIA_BASE_URL` empty for this to hold.
- `/admin.html` shows storage used and writes this month.
- Optional extra safety net: add a budget alert of $1 under *Manage Account → Billing → Billable Usage*.

Change the limits in `wrangler.toml`. Remember: storage costs $0.015 per GB-month above 10 GB.

### Backup

R2 holds the only copy of the re-encoded files. Download a JSON export of all contributions
(with metadata) from `/admin.html` now and then.

## Formats and quality

One format per media type, chosen for compatibility (opens anywhere, prints anywhere, plays in every
browser) and for the best quality per byte within that format.

| Type | Stored as | Limits | Settings |
|---|---|---|---|
| Photo | JPEG (mozjpeg), sRGB | A3 @ 300 dpi: max 3508 × 4961 px (portrait or landscape) | quality 90, 4:2:0, progressive. Also a 2048 px screen copy (q82) and a 640 px thumbnail (q75), both JPEG |
| Video | MP4: H.264 High + AAC-LC | max 1080p (1920 × 1080, or 1080 × 1920 for portrait), max 60 fps | CRF 21, preset medium, peaks capped at 12 Mb/s, audio 128 kb/s, faststart. HDR (HLG/PQ from phones) is tone-mapped to SDR BT.709 |
| Sound | M4A: AAC-LC | | 128 kb/s stereo, 96 kb/s mono |
| PDF | PDF 1.7 via Ghostscript | images at 300 dpi | `-dPDFSETTINGS=/printer` |

Nothing is ever upscaled. Metadata (EXIF/XMP/QuickTime: date, camera, GPS, …) is copied into the
new files. The orientation is applied to the pixels.

**How the settings were chosen.** Measured with SSIM against the lossless source:

*Photos.* Mean over 7 real photos (scikit-image sample set), mozjpeg via sharp:

| quality | 4:2:0 bits/pixel | 4:2:0 SSIM dB | 4:4:4 bits/pixel | 4:4:4 SSIM dB |
|---|---|---|---|---|
| 80 | 1.51 | 12.85 | 1.82 | 13.57 |
| 85 | 1.77 | 13.65 | 2.15 | 14.51 |
| 88 | 2.01 | 14.31 | 2.46 | 15.29 |
| **90** | **2.22** | **14.91** | 2.76 | 16.04 |
| 92 | 2.46 | 15.55 | 3.06 | 16.86 |
| 95 | 3.03 | 16.70 | 3.85 | 18.47 |

- 4:2:0 gives the same or better quality per byte than 4:4:4, and halved colour resolution is not
  visible in a 300 dpi print.
- From quality 90 upwards, every step costs about 10% more bytes per +0.6 dB, and 95 costs +37%
  over 90.
- Quality 90 is the usual "visually lossless for print" point, so the archive copy uses q90.

*Video.* x264 on the sample clips from scikit-video (Big Buck Bunny 720p and "bikes"):

| CRF | bikes kb/s | bikes SSIM dB | BBB kb/s | BBB SSIM dB |
|---|---|---|---|---|
| 18 | 528 | 22.86 | 2923 | 21.30 |
| 20 | 468 | 22.30 | 2292 | 20.45 |
| **21** | **438** | **22.06** | **2038** | **20.03** |
| 22 | 410 | 21.81 | 1809 | 19.61 |
| 23 | 384 | 21.44 | 1602 | 19.18 |
| 24 | 354 | 20.49 | 1418 | 18.75 |
| 26 | 293 | 18.77 | 1114 | 17.77 |

- Quality drops sharply after CRF 23 (bikes: −0.95 dB for only 8% fewer bytes). CRF 21 sits safely
  before that point, which leaves headroom for noisy phone footage.
- `-preset slow` saved only 1–2% at the same quality for about twice the encode time, so `medium` is used.
- H.264 was chosen over HEVC/AV1, even though those are 30–50% smaller, because H.264 is the only
  codec that plays in every browser and on every device without exceptions.

The test clips are small (≤ 720p), so the absolute numbers are indicative. The shape of the curves
is what drove the choices.

### Local development

```sh
cp .dev.vars.example .dev.vars        # set TURNSTILE_SECRET=disabled and add TURNSTILE_SITE_KEY= to skip Turnstile
npm run db:migrate:local
npm run dev                           # http://localhost:8787, admin: /admin.html (token from .dev.vars)

# process uploads locally (needs ffmpeg, exiftool, heif-convert, ghostscript, pdftoppm)
cd processor && npm install
WORKER_URL=http://localhost:8787 ADMIN_TOKEN=dev-admin-token node process.mjs
```


## Files

```
wrangler.toml                 Cloudflare config (D1, R2, settings)
migrations/0001_init.sql      database schema
src/worker.js                 API, uploads, media serving, admin API
public/                       the website (no build step): index.html, app.js, style.css, admin.html, admin.js
public/config.js              API address (generated by the Pages workflow)
processor/process.mjs         conversion + metadata (runs in GitHub Actions)
.github/workflows/process.yml runs the processor
.github/workflows/pages.yml   publishes public/ to GitHub Pages
migrations/0003_…             spending guard counters
```

The photos in `public/img/` are the ones shared when the project started. Make sure you are
allowed to use them, or replace them with photos from the contributions.

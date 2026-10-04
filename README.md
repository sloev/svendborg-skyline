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
| Backup of the re-encoded files | Your Google Drive (via rclone) | your quota |

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
    • re-encoded file + sidecar JSON + story → Google Drive  (arkiv/<dato>_<navn>_<id>/)
    • bidrag.json + historier.md (full export of all contributions) → Google Drive
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

## Setup

Everything on Cloudflare is set up and deployed by the workflow **Opsæt og udgiv Cloudflare**
(`.github/workflows/deploy.yml`). You only create a few keys and paste them into GitHub.

1. **Cloudflare API token**: go to https://dash.cloudflare.com/profile/api-tokens and choose
   *Create Token* → *Create Custom Token*. Give it these permissions, with *Account Resources*
   set to your account:
   - Account · Workers Scripts · Edit
   - Account · D1 · Edit
   - Account · Workers R2 Storage · Edit
   - Account · Account Settings · Read
2. **Account ID**: shown on the right of https://dash.cloudflare.com/?to=/:account/workers-and-pages
   (it is also the long id in the dashboard URL).
3. **Turnstile**: create a widget at https://dash.cloudflare.com/?to=/:account/turnstile with
   hostname `sloev.github.io`. The site key goes in `wrangler.toml` (already done); the secret key
   goes in GitHub (step 5).
4. **GitHub token for "process right after upload"** (optional; without it, processing runs every
   hour): https://github.com/settings/personal-access-tokens/new. Choose *Only select repositories* →
   this repo, and *Contents: Read and write*.
5. **GitHub secrets**: add these at https://github.com/sloev/svendborg-skyline/settings/secrets/actions

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | from step 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | from step 2 |
   | `ADMIN_TOKEN` | a long random string (`openssl rand -hex 32`); also the password for `/admin.html` |
   | `TURNSTILE_SECRET` | from step 3 |
   | `DISPATCH_TOKEN` | from step 4 |

6. **GitHub settings**:
   - Default branch = `master` (https://github.com/sloev/svendborg-skyline/settings). Scheduled and
     dispatched workflows only run from the default branch.
   - Pages source = *GitHub Actions* (https://github.com/sloev/svendborg-skyline/settings/pages).
7. **Run** *Opsæt og udgiv Cloudflare* at https://github.com/sloev/svendborg-skyline/actions/workflows/deploy.yml.
   It does the following:
   - registers a workers.dev subdomain if needed
   - creates the D1 database and the R2 bucket
   - runs the migrations
   - deploys the worker and sets its secrets
   - publishes the website

   The run summary shows the links. After that, every push to `master` redeploys whatever changed.

The website is at https://sloev.github.io/svendborg-skyline/ and the admin page at `/admin.html`.
The processing workflow finds the worker by itself through the same Cloudflare secrets, so
`WORKER_URL` only needs to be set if you move the worker to a custom domain.

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

### Google Drive backup (optional)

1. Install [rclone](https://rclone.org/install/) on your own computer and run `rclone config`.
   Create a new remote called `gdrive` of type `drive`, with scope `drive.file`.
   For reliability, use [your own Google client ID](https://rclone.org/drive/#making-your-own-client-id)
   and publish the OAuth app ("In production"); otherwise Google may expire the login after 7 days.
2. Copy the contents of `~/.config/rclone/rclone.conf` into the GitHub secret `RCLONE_CONFIG`.
3. Set the GitHub variable `RCLONE_REMOTE` to the folder you want, e.g. `gdrive:Siloerne på Østre Kaj`.

Drive then gets a copy of every re-encoded file (not the originals, which are deleted). Without
Drive, R2 is the only copy. You can also download a JSON export of everything from `/admin.html`.

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
WORKER_URL=http://localhost:8787 ADMIN_TOKEN=dev-admin-token RCLONE_REMOTE=/tmp/drive node process.mjs
```

`RCLONE_REMOTE` can be a plain local folder, which is handy for testing.

## Files

```
wrangler.toml                 Cloudflare config (D1, R2, settings)
migrations/0001_init.sql      database schema
src/worker.js                 API, uploads, media serving, admin API
public/                       the website (no build step): index.html, app.js, style.css, admin.html, admin.js
public/config.js              API address (generated by the Pages workflow)
processor/process.mjs         conversion + metadata + Google Drive archive (runs in GitHub Actions)
.github/workflows/process.yml runs the processor
.github/workflows/pages.yml   publishes public/ to GitHub Pages
.github/workflows/deploy.yml  sets up Cloudflare (D1, R2, secrets) and deploys the worker
migrations/0003_…             spending guard counters
```

The photos in `public/img/` are the ones shared when the project started. Make sure you are
allowed to use them, or replace them with photos from the contributions.

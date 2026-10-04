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

You need a Cloudflare account (free), this GitHub repo and Node 20+.

### 1. Cloudflare

```sh
npm install
npx wrangler login
npx wrangler d1 create silo-arkiv          # put the database_id into wrangler.toml
npx wrangler r2 bucket create silo-arkiv
npm run db:migrate                         # creates the tables in D1
```

Create a Turnstile widget in the Cloudflare dashboard (Turnstile → Add widget, add your domain).
Put the **site key** in `wrangler.toml` (`TURNSTILE_SITE_KEY`). Then set the secrets:

```sh
npx wrangler secret put TURNSTILE_SECRET    # Turnstile secret key
npx wrangler secret put ADMIN_TOKEN         # long random string, e.g. `openssl rand -hex 32`
npx wrangler secret put IP_SALT             # another random string
npx wrangler secret put GITHUB_TOKEN        # optional, see step 2
npm run deploy
```

Also set `CONTACT_EMAIL` in `wrangler.toml`. It is shown in the privacy section so people can ask
for their contribution to be removed. If you want, add a custom domain to the worker
(Workers → silo-arkiv → Settings → Domains) and update `WORKER_URL` to match.

### 2. GitHub Pages (the website)

The website in `public/` is plain HTML/JS and is published to GitHub Pages. It talks to the worker for
everything dynamic (API, uploads and media).

1. **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: set `WORKER_URL` to your worker's
   address, e.g. `https://silo-arkiv.<account>.workers.dev`. The processor uses it too.
3. In `wrangler.toml`, `ALLOWED_ORIGINS` must contain the Pages address (`https://sloev.github.io`
   by default, or your custom domain), so the browser may call the API. Run `npm run deploy` after changing it.
4. Add the Pages hostname (`sloev.github.io` or your custom domain) to the Turnstile widget's hostnames.
5. Push to `main`, or run the workflow **Udgiv hjemmeside (GitHub Pages)** by hand. The site is then at
   `https://sloev.github.io/svendborg-skyline/`.

The workflow writes `public/config.js` with the worker address. Locally, and if you would rather let
the worker serve the site itself, `config.js` is empty and everything runs on one origin.

### 3. GitHub Actions (conversion)

In the repo, go to **Settings → Secrets and variables → Actions**:

- Variable `WORKER_URL`: e.g. `https://silo-arkiv.<account>.workers.dev`
- Secret `ADMIN_TOKEN`: the same value as the worker secret

To start processing right after each upload instead of waiting for the hourly run, create a
[fine-grained token](https://github.com/settings/personal-access-tokens/new) for this repository only,
with **Contents: Read and write**. Save it as the worker secret `GITHUB_TOKEN`.

### 4. Google Drive (backup)

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
```

The photos in `public/img/` are the ones shared when the project started. Make sure you are
allowed to use them, or replace them with photos from the contributions.

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
| Archive of originals | Your Google Drive (via rclone) | your quota |

## How it works

```
 Browser ──(1) form + Turnstile──▶ Worker ──▶ D1 (contribution, status "uploading")
    │                                │
    └─(2) files in 16 MB chunks ────▶ Worker ──▶ R2  originals/<id>/…   (R2 multipart upload)
                                     │
                     (3) "done" ─────┴──▶ GitHub repository_dispatch
                                               │
 GitHub Action: processor/process.mjs  ◀───────┘   (also runs every hour as a fallback)
    • exiftool reads ALL metadata          → stored in D1 (private) and in a .json sidecar file
    • photos (incl. HEIC)  → JPEG 2560 px + 800 px thumbnail, metadata copied over, rotation applied
    • video (MOV, MP4, …)  → MP4 H.264/AAC ≤1920 px with faststart + poster frame, metadata kept
    • sound                → M4A (AAC), metadata kept
    • PDF                  → kept as is + thumbnail of page 1
    • GPS is removed from the public copies unless the contributor ticked "vis på kortet"
    • the untouched original + sidecar JSON + story → Google Drive  (originaler/<dato>_<navn>_<id>/)
    • optionally deletes the original from R2 once it is safe in Drive (keeps R2 under 10 GB)
    • bidrag.json + historier.md (full export of all contributions) → Google Drive
```

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

### 4. Google Drive (archive of the originals)

1. Install [rclone](https://rclone.org/install/) on your own computer and run `rclone config`.
   Create a new remote called `gdrive` of type `drive`, with scope `drive.file`.
   For reliability, use [your own Google client ID](https://rclone.org/drive/#making-your-own-client-id)
   and publish the OAuth app ("In production"); otherwise Google may expire the login after 7 days.
2. Copy the contents of `~/.config/rclone/rclone.conf` into the GitHub secret `RCLONE_CONFIG`.
3. Set the GitHub variable `RCLONE_REMOTE` to the folder you want, e.g. `gdrive:Siloerne på Østre Kaj`.
4. Optional: set the variable `DELETE_ORIGINALS_AFTER_ARCHIVE` to `true`. Originals are then removed
   from R2 once they are safely in Drive, so R2 only holds the smaller web versions.

Without Drive, the originals simply stay in R2. You can also download a JSON export of everything
from `/admin.html`.

### Local development

```sh
cp .dev.vars.example .dev.vars        # set TURNSTILE_SECRET=disabled and add TURNSTILE_SITE_KEY= to skip Turnstile
npm run db:migrate:local
npm run dev                           # http://localhost:8787, admin: /admin.html (token from .dev.vars)

# process uploads locally (needs ffmpeg, exiftool, heif-convert, pdftoppm)
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

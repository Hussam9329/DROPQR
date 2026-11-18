# DropQR

Share files with a link + QR code that expires by time **and** by number of downloads. No sign-up.

Live: https://dropqr-mu.vercel.app

## Stack

- **Vercel** — Express app (`server.js`) runs as a Vercel Function; `public/` is served by the CDN.
- **Vercel Blob (private store)** — the file bytes. The browser uploads straight to Blob, so there is no 4.5 MB request limit.
- **Neon Postgres** — file records and download counters.

## How it works

1. `POST /api/uploads` reserves an id and a storage path for each file (up to 20 files per link, `MAX_FILE_MB` in total; table `items`).
2. The browser uploads each file directly to Blob (`public/uploader.js`), with a token from `POST /api/uploads/:id/token` limited to that exact path and size. Files over 8 MB go in 8 MB parts; every finished part is saved in the browser, so after a reload or a dropped connection the upload continues from the next part (`POST /api/uploads/:id/status` reports which files already arrived). Unfinished uploads are kept 24 hours.
3. `POST /api/uploads/:id/complete` checks the file arrived, starts its timer and returns the link + QR code.
4. `POST /api/files/:id/download` (sent by a Download button) uses up one download (atomic SQL update) and returns 15-minute signed storage links for every file in the link, so the file downloads straight from storage and can resume.
   Opening the share page `/f/:id` (built by the server, with link-preview tags) does **not** use a download.
   A protected file needs its password for `/unlock` and `/download`; wrong guesses are capped per visitor.
5. Expired / used-up files are deleted from Blob and the database: alongside normal traffic (at most once a minute) and by a daily Vercel Cron job as a safety net.

## HTML links (`/html.html`)

Upload one HTML file (up to 10 MB) and get a link to the page at `/p/<uuid>`. The uploader picks how long it lives, from the same choices as shared files (5 minutes to 7 days); after that `/p/<uuid>` answers 410 and the file is deleted by the next cleanup.
`POST /api/html` (with `expiry`) reserves the page and returns an upload token (the same `uploadId` always returns the same page, so retries are safe), the browser uploads the file straight to Blob, and `POST /api/html/:id/complete` makes it live.
`/p/:id` serves the page under `Content-Security-Policy: sandbox`, so its scripts run in their own blank origin and can't reach DropQR's API, cookies or storage. Pages count toward `STORAGE_CAP_GB` and `DAILY_UPLOAD_MB`.

## Secret texts (`/text`)

Write a text (up to 10,000 characters), give it a password and a lifetime (5 minutes to 7 days), and get a link, QR code and short code at `/t/<code>`.
The browser encrypts the text (`public/text.js`: PBKDF2-SHA-256, then AES-256-GCM). The server stores only the ciphertext and a scrypt hash of a verifier derived from the password, so it can't read a text, and a forgotten password can't be recovered.
With "delete after opening", the right password starts a 60-second window at most, and the browser ends it with `POST /api/texts/:code/burn` once it has the text. Ten wrong passwords delete the text. Expired texts are refused at once and removed by the next cleanup.

Expiry: 5m, 10m, 30m, 1h, 6h, 12h, 1d, 3d, 7d. Download limit: 1–100.

## Run locally

```bash
npm install
vercel env pull .env.local
npm run dev
```

Open http://localhost:3000. Local runs use the same Neon database and Blob store as production.

If you change `client/blob-upload.js` or upgrade `@vercel/blob`, rebuild the browser bundle:

```bash
npm run bundle
```

## Environment variables

| Variable | Set by | Meaning |
|---|---|---|
| `DATABASE_URL` | Neon integration | Postgres connection |
| `BLOB_READ_WRITE_TOKEN` | Blob store | Needed to issue browser upload tokens |
| `CRON_SECRET` | You | Protects `/api/cron/cleanup` |
| `MAX_FILE_MB` | Optional | Max upload size (default 100) |
| `STORAGE_CAP_GB` | Optional | Whole-site storage ceiling; new uploads are refused above it (default 5) |
| `DAILY_UPLOAD_MB` | Optional | Upload quota per visitor per day (default 1024) |
| `ABUSE_EMAIL` | Optional | Abuse contact shown in the footer and legal pages |
| `ADMIN_SECRET` | Optional | Password for the admin page at `/admin.html` (off when empty) |
| `REPORT_THRESHOLD` | Optional | Reports from different people before a file is hidden (default 3) |
| `BASE_URL` | Optional | Force the address used in links/QR |

Deployment steps (Arabic): see [DEPLOY.md](DEPLOY.md).

## Interface languages

All page text lives in `public/i18n.js` (English and Arabic, right-to-left). The visitor's choice is remembered in the browser; otherwise the browser language decides. Server errors carry a `code` so the page shows them in the visitor's language. Terms, Privacy and Admin pages are English only.

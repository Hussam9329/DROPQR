# DropQR

Share files with a link + QR code that expires by time **and** by number of downloads. No sign-up.

Live: https://dropqr-mu.vercel.app

## Stack

- **Vercel** — Express app (`server.js`) runs as a Vercel Function; `public/` is served by the CDN.
- **Vercel Blob (private store)** — the file bytes. The browser uploads straight to Blob, so there is no 4.5 MB request limit.
- **Neon Postgres** — file records and download counters.

## How it works

1. `POST /api/uploads` reserves an id and storage path.
2. The browser uploads directly to Blob (`/api/blob-upload` hands out a one-time token for that exact path only).
3. `POST /api/uploads/:id/complete` checks the file arrived, starts its timer and returns the link + QR code.
4. `POST /api/files/:id/download` (sent by the Download button) uses up one download (atomic SQL update) and returns a 15-minute signed storage link, so the file downloads straight from storage and can resume.
   Opening the share page `/f/:id` (built by the server, with link-preview tags) does **not** use a download.
   A protected file needs its password for `/unlock` and `/download`; wrong guesses are capped per visitor.
5. Expired / used-up files are deleted from Blob and the database: alongside normal traffic (at most once a minute) and by a daily Vercel Cron job as a safety net.

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

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
4. `GET /d/:id` uses up one download (atomic SQL update) and streams the file with its original name.
   Opening the share page `/f/:id` does **not** use a download.
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
| `BASE_URL` | Optional | Force the address used in links/QR |

Deployment steps (Arabic): see [DEPLOY.md](DEPLOY.md).

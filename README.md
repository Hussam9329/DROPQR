# DropQR

Share files with a link + QR code that expires by time **and** by number of downloads. No sign-up.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000. Phones on the same Wi-Fi can scan the QR (the link uses your LAN IP automatically).

## Settings (environment variables)

| Variable      | Default  | Meaning                                              |
|---------------|----------|------------------------------------------------------|
| `PORT`        | `3000`   | Port to listen on                                    |
| `BASE_URL`    | auto     | Public address used in links/QR, e.g. `https://drop.example.com` |
| `MAX_FILE_MB` | `500`    | Max upload size                                      |
| `DATA_DIR`    | `./data` | Where files and the SQLite database are stored       |

## How it works

- Expiry: 5m, 10m, 30m, 1h, 6h, 12h, 1d, 3d, 7d. Download limit: 1–100.
- Opening the share page does **not** use a download — only clicking *Download* does.
- When the time runs out or the last download finishes, the file is deleted from disk (checked every 30 seconds).
- The uploader gets a private delete token (kept in their browser) to remove the file early.
- Online deployment (Railway / VPS): see [DEPLOY.md](DEPLOY.md)

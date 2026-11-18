# Hostinger production deployment

## Target setup

- Hosting: Hostinger Business Web, managed through hPanel
- App hostname: `inbox.elitegoldsignal.com`, set up as its own Node.js web app. Do not replace the main site, and do not change MX records (Business Email must keep working).
- Database: Hostinger MySQL
- WhatsApp: the new number connected directly to Meta Cloud API
- Access: one administrator account

## Status

The code has passed its end-to-end test suite against a local MariaDB 10.11 database with a mocked Meta API (`npm test`). It has **not** yet been deployed, or tested against the real Meta API, a real number or Hostinger's database.

## 1. Hostinger (you)

1. **MySQL:** in hPanel → Databases, create a database and a user with full privileges on it. Note the name, user and password; you'll enter them only into hPanel in step 3.
2. **Subdomain app:** in hPanel, add a Node.js web app for `inbox.elitegoldsignal.com`:
   - Node.js version 22.x or newer.
   - Upload `relaydesk-hostinger.zip`.
   - Set the start command to `npm start`; Hostinger runs `npm install` from `package.json` and `package-lock.json`.
3. **Environment variables:** enter these in the app settings (never in files or chat):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `TRUST_PROXY` | `true` |
   | `COOKIE_SECURE` | `true` |
   | `ADMIN_EMAIL` | your admin email |
   | `ADMIN_PASSWORD` | unique, 16+ characters |
   | `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` |
   | `DB_NAME` / `DB_USER` / `DB_PASSWORD` | from step 1 |
   | `WA_VERIFY_TOKEN` | a new long random string you invent |
   | `META_APP_SECRET` | Meta App Dashboard → App settings → Basic |
   | `WA_BUSINESS_ACCOUNT_ID` | WABA ID (WhatsApp Manager / API Setup) |
   | `WA_ACCESS_TOKEN` | **System User** token (permanent), with `whatsapp_business_messaging` and `whatsapp_business_management` |
   | `WA_GRAPH_API_VERSION` | e.g. `v23.0`. Use the version shown in your Meta app. |
   | `BACKUP_DIR` | a folder **outside** the app folder, e.g. `/home/<user>/relaydesk-backups` |

4. **Check health:** enable SSL for the subdomain. Then open `https://inbox.elitegoldsignal.com/health`. You should see `"database":"ok"`, `"whatsapp_configured":true` and `"webhook_configured":true`.

## 2. Meta (you)

1. In WhatsApp Manager, add the new number to the WABA, verify it with the code, and register it for Cloud API.
2. Create a System User (Business Settings → Users → System users) and give it the WhatsApp app and WABA assets. Generate a token with the two permissions above. Don't use the 24-hour test token.
3. In App Dashboard → WhatsApp → Configuration, set:
   - Callback URL: `https://inbox.elitegoldsignal.com/webhooks/whatsapp`
   - Verify token: the same `WA_VERIFY_TOKEN`

   Click **Verify and save**, then subscribe the **messages** field.
4. Make sure the app is subscribed to the WABA. In WhatsApp Manager this usually happens automatically. Otherwise, call `POST /{WABA_ID}/subscribed_apps` once with the system-user token.
5. Create at least one template (e.g. a simple greeting) and wait for approval. You need one to start conversations.

## 3. Go-live checks (together)

1. Sign in → Numbers → **Sync numbers from Meta**. Confirm the new number appears with Phone Number ID `1148479081159296`.
2. From a personal phone, message the business number. It should appear in the inbox within about 8 seconds.
3. Reply from the inbox and watch the status go from ✓ sent to ✓✓ delivered to ✓✓ read.
4. Send a photo from the phone and confirm it displays.
5. Start a new conversation with the approved template to a second test phone.
6. Run a backup over SSH (`npm run backup`) and check the file in `BACKUP_DIR`.
7. Check the app logs in hPanel for errors.

## Backups and retention

- Hostinger's own backups of the database are a safety net only. Also run the app's backup.
- If hPanel → Advanced → Cron Jobs is available, add a daily job:
  `cd <app folder> && node scripts/backup.mjs && node scripts/maintenance.mjs`
  Use the full `node` path if cron can't find it (`which node` over SSH).
- To restore: `node scripts/restore.mjs <file> --yes`. Restore runs in a single transaction and rolls back fully if the file is truncated or invalid.
- `MESSAGE_RETENTION_DAYS` (optional) deletes older messages during maintenance.

## Constraints

- Hostinger managed Node.js has no WebSockets or background workers. The inbox polls, and webhooks are stored before the 200 response, so Meta retries on any failure and duplicate deliveries are ignored.
- Requests are stopped after 120 seconds. Graph calls time out sooner: 20 s, and 60 s for media.
- Throughput at 100+ numbers is unproven on this plan. Watch CPU and entry-process limits in hPanel once traffic starts.

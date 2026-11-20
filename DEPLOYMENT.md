# Production deployment: your own server + MongoDB Atlas

## Target setup

- **App:** Relaydesk on your own server (Node.js 22+), reachable at `https://inbox.elitegoldsignal.com`
- **Database:** MongoDB Atlas
- **WhatsApp:** the number connected directly to Meta Cloud API, never WhatsApp Web
- **Access:** one administrator account
- **Email:** Business Email keeps working. Do not change the MX records for elitegoldsignal.com.

## Status

The code passes its end-to-end test suite (`npm test`, 29 steps) against MongoDB 8 running as a one-node replica set, with the Meta API mocked. It has **not** yet been tested against Atlas itself, the real Meta API, a real number or your server.

## 1. MongoDB Atlas (you)

1. Create a project and a cluster. M0 (free) works to start. M10 or higher adds Atlas's automatic backups, which M0 doesn't have.
2. **Database Access:** add a database user with a long password and the **readWrite** role on the `relaydesk` database. Don't use an admin role.
3. **Network Access:** add your server's **public IP address**. Avoid `0.0.0.0/0` (anywhere).
4. **Connect → Drivers:** copy the `mongodb+srv://...` connection string and put the user's password into it. This value is a secret: enter it only on the server, never in chat or in git.

## 2. Server (you)

1. Install Node.js 22 LTS or newer.
2. Copy `relaydesk.zip` to the server, unzip it into a folder (e.g. `/opt/relaydesk`) and run `npm install --omit=dev` there.
3. Create `.env` in that folder, starting from `.env.example`, then run `chmod 600 .env` so only the app's user can read it:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `HOST` / `PORT` | `127.0.0.1` / `8787` (only the reverse proxy or tunnel talks to it) |
   | `TRUST_PROXY` | `true` |
   | `COOKIE_SECURE` | `true` |
   | `MONGODB_URI` | the Atlas connection string from step 1 |
   | `MONGODB_DB` | `relaydesk` |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | your admin email; a unique password of 16+ characters |
   | `WA_VERIFY_TOKEN` | a long random string you invent |
   | `META_APP_SECRET` | Meta App Dashboard → App settings → Basic |
   | `WA_BUSINESS_ACCOUNT_ID` | your WABA ID |
   | `WA_ACCESS_TOKEN` | **System User** token with `whatsapp_business_messaging` and `whatsapp_business_management` |
   | `WA_GRAPH_API_VERSION` | e.g. `v23.0`. Use the version shown in your Meta app. |
   | `BACKUP_DIR` | a folder outside the app folder, e.g. `/var/backups/relaydesk` |

4. Keep it running as a service, so it restarts after crashes and reboots. With systemd, create `/etc/systemd/system/relaydesk.service`:

   ```ini
   [Unit]
   Description=Relaydesk
   After=network-online.target

   [Service]
   WorkingDirectory=/opt/relaydesk
   ExecStart=/usr/bin/node app.mjs
   Restart=always
   User=relaydesk

   [Install]
   WantedBy=multi-user.target
   ```

   Then run `systemctl enable --now relaydesk`.

5. **Public HTTPS:** Meta only sends webhooks to a public `https://` address with a valid certificate. Use one of these:
   - **Cloudflare Tunnel:** needs no open ports or public IP. Route `inbox.elitegoldsignal.com` to `http://127.0.0.1:8787`. This needs the domain's DNS on Cloudflare, or a CNAME for `inbox` to the tunnel.
   - **Public IP with a reverse proxy:** add an `A` record for `inbox` pointing to your server's IP, wherever elitegoldsignal.com's DNS is managed. Then run Caddy (automatic HTTPS) or Nginx with Let's Encrypt, proxying to `127.0.0.1:8787`. Open only ports 80 and 443.

6. **Check health:** open `https://inbox.elitegoldsignal.com/health`. You should see `"database":"ok"`, `"whatsapp_configured":true` and `"webhook_configured":true`. If `database` fails, check the server's IP is on Atlas's Network Access list.

## 3. Meta (you)

1. In WhatsApp Manager, add the number to the WABA, verify it and register it for Cloud API.
2. Create a System User and give it the app and WABA. Generate a permanent token with the two permissions above. Don't use the 24-hour test token.
3. In App Dashboard → WhatsApp → Configuration, set:
   - Callback URL: `https://inbox.elitegoldsignal.com/webhooks/whatsapp`
   - Verify token: the same `WA_VERIFY_TOKEN`

   Click **Verify and save**, then subscribe the **messages** field.
4. Make sure the app is subscribed to the WABA. Otherwise, call `POST /{WABA_ID}/subscribed_apps` once with the system-user token.
5. Create one simple template and wait for approval. You need one to start conversations.

## 4. Go-live checks (together)

1. Sign in → Numbers → **Sync numbers from Meta**. The number appears with its Phone Number ID.
2. Message the business number from a personal phone. It appears in the inbox within about 8 seconds.
3. Reply and watch the status go from ✓ sent to ✓✓ delivered to ✓✓ read.
4. Send a photo from the phone and confirm it displays.
5. Start a new conversation with the approved template.
6. Run `npm run backup` and check the file in `BACKUP_DIR`.
7. Check the logs with `journalctl -u relaydesk`.

## Backups and retention

- Atlas M0 has no automatic backups, so the app's own backup is essential. Add a daily cron job on the server:
  `cd /opt/relaydesk && node scripts/backup.mjs && node scripts/maintenance.mjs`
- Copy backups off the server regularly. A backup on the same disk as the app doesn't protect against losing that disk.
- To restore, run `node scripts/restore.mjs <file> --yes`. The file loads into temporary collections and is checked first. The live data is only replaced after the whole file loaded correctly, so a truncated or invalid file changes nothing.
- Expired sign-in sessions are also removed automatically by a MongoDB TTL index.
- `MESSAGE_RETENTION_DAYS` (optional) deletes older messages during maintenance.

## Constraints

- The inbox polls every 8 seconds; there are no WebSockets. Webhooks are stored before the 200 response, so Meta retries on any failure and duplicate deliveries are ignored.
- Graph calls time out after 20 s, or 60 s for media.
- Throughput at 100+ numbers is unproven. Watch Atlas metrics: M0 has connection and throughput limits, so move to M10 or higher before real volume.

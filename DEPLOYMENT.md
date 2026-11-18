# Hostinger production deployment

## Target setup

- Hosting: Hostinger Business Web / hPanel
- App hostname: `inbox.elitegoldsignal.com` (recommended)
- Database: Hostinger MySQL, kept outside deployment files
- WhatsApp: the new number connected directly to Meta Cloud API
- Access: one administrator account for the initial release

Keep the existing apex website and Business Email service. Add the app as its own subdomain site, enable HTTPS, and leave existing MX records unchanged.

## What is already prepared

- Node.js app with one administrator login, secure session cookies, webhook signature validation, idempotent inbound message storage, text replies, conversation state, and paginated WABA phone sync.
- MySQL storage for app records and sessions. Tables are created at startup.
- Production environment template in `.env.example`.

The app has not been deployed. It is a controlled pilot candidate after the checklist below. It is not a full Periskope feature replacement and does not yet include approved template messages, media handling, multi-admin roles, conversation assignment, automated database backups/retention, or a job queue.

## Hostinger prerequisites

1. In hPanel, create a MySQL database and database user. Grant that user access to the database with privileges to create tables and indexes. Keep the database password private.
2. Create `inbox.elitegoldsignal.com` as a separate Node.js web app. Do not replace the apex site.
3. Choose Node.js 22.x or 24.x and upload the contents of `relaydesk-integration` as a ZIP. Keep `.env` and any real credentials out of the ZIP.
4. Set the start command to `npm start`. Hostinger installs dependencies from `package.json` during deployment.
5. Add these environment variables in the Hostinger app settings:

   - `NODE_ENV=production`
   - `COOKIE_SECURE=true`
   - `ADMIN_EMAIL=<your admin email>`
   - `ADMIN_PASSWORD=<unique password, 16+ characters>`
   - `DB_HOST=127.0.0.1`
   - `DB_PORT=3306`
   - `DB_NAME=<database name>`
   - `DB_USER=<database username>`
   - `DB_PASSWORD=<database password>`
   - `WA_VERIFY_TOKEN=<new random secret created for this webhook>`
   - `META_APP_SECRET=<Meta app secret>`
   - `WA_BUSINESS_ACCOUNT_ID=<WABA ID>`
   - `WA_ACCESS_TOKEN=<production system-user token>`
   - `WA_GRAPH_API_VERSION=<version enabled for your Meta app>`

   Hostinger's Node.js MySQL guide specifies `127.0.0.1` and port `3306` for its local database connection. Use the live version shown in your Meta app rather than copying a version string from an old example.

6. Deploy and open `https://inbox.elitegoldsignal.com/health`. It should report database connectivity without returning secrets. Sign in and confirm the app displays the setup state.
7. In Meta App Dashboard, configure callback `https://inbox.elitegoldsignal.com/webhooks/whatsapp`, use the same `WA_VERIFY_TOKEN`, and subscribe the WABA's `messages` field. The callback must be publicly reachable over HTTPS.
8. Sign in, click **Sync numbers from Meta**, and confirm the new phone appears in the number list. The app learns the Meta Phone Number ID from the WABA response; it does not need a separate hard-coded ID.
9. Perform a controlled inbound and outbound message check. Confirm webhook events update message status, then review Hostinger runtime logs and MySQL records. Start customer traffic only after those checks succeed.

## Operational constraints and remaining work

- Hostinger managed Node.js plans run a web process but do not support inbound WebSockets or always-running background workers. The inbox refreshes by polling; webhook writes happen during the HTTP request. Keep each webhook request small and acknowledge only after its data is committed.
- Hostinger stops requests after 120 seconds. The app's Meta requests have shorter timeouts, and number synchronization paginates in pages of 100.
- The deployment contains personal message data in MySQL. Set and verify automated database backups, retention, restoration, and access restrictions in hPanel before live customer use. The current app does not schedule these itself.
- Current message composer sends text only. Add approved templates for business-initiated messages outside the customer-service window before relying on the app for outbound campaigns or follow-ups.
- The first release has one administrator. Do not share the single admin account with multiple people; multi-user access and audit records need a later release.
- The user's `+44` line and supplied Meta Phone Number ID are not proof the number is registered or attached to the WABA. Registration and number sync must confirm that through Meta.
- Do not paste Hostinger, Meta, or MySQL passwords, tokens, app secrets, or SSH private keys into chat. Enter them directly into Hostinger's private environment settings.

Hostinger references: [Create a Node.js web app](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/), [Connect MySQL to Node.js](https://www.hostinger.com/support/connecting-a-hostinger-mysql-database-to-a-node-js-application/), [Node.js version selection](https://www.hostinger.com/support/how-to-select-the-node-js-version-for-your-application/), and [Node.js plan limits](https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/).

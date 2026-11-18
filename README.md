# Relaydesk shared inbox

Relaydesk is a WhatsApp shared inbox built on Meta's official WhatsApp Business Platform Cloud API. It never automates or scans WhatsApp Web.

## What it does

- One administrator sign-in (secure, HttpOnly session cookie stored in MySQL; login throttling).
- Receives messages through Meta's signed webhook: text, replies, reactions, locations, shared contacts, and media (image, audio, video, document, sticker).
- Shows media through an authenticated proxy. Files are fetched from Meta on demand and are not stored on the server. Meta keeps inbound media for a limited time only.
- Free-form text replies inside WhatsApp's 24-hour customer-service window. The UI shows how long the window stays open.
- Sends approved message templates with text variables, both outside the window and to start new conversations. It lists templates from Meta, previews them and validates the variables. Templates with media headers or dynamic URL buttons are listed but can't be sent yet.
- Delivery status (sent, delivered, read, failed) from Meta webhooks. Status never moves backwards, and failed sends show Meta's error.
- Conversation list with search, open/closed/all filters and a per-number filter. It refreshes every 8 seconds without clearing anything you are typing.
- Syncs the WABA phone-number list with pagination. Phone Number IDs come from Meta and are never hard-coded.
- Backup, restore and retention scripts.

## Layout

| Path | Purpose |
|---|---|
| `app.mjs` | HTTP server, routes, auth, webhook |
| `lib/db.mjs` | MySQL pool, schema creation and additive migrations |
| `lib/graph.mjs` | Meta Graph API client: number sync, templates, send, media |
| `lib/inbox.mjs` | Webhook processing, conversations, sending rules |
| `public/` | Browser UI (no build step) |
| `sync-numbers.mjs` | CLI number sync |
| `scripts/backup.mjs`, `scripts/restore.mjs`, `scripts/maintenance.mjs` | Operations |
| `test/e2e.mjs`, `test/mock-graph.mjs` | End-to-end tests against a real MySQL/MariaDB database with a mocked Graph API |

## Local setup

1. Use Node.js 22 or later and create a MySQL or MariaDB database.
2. Copy `.env.example` to `.env`. Fill in the database settings and an admin email and password (at least 16 characters when `NODE_ENV=production`).
3. Run `npm install`, then `npm start`. Tables are created and migrated at startup.
4. Open `http://localhost:8787`.

## Tests

```bash
DB_HOST=127.0.0.1 DB_USER=... DB_PASSWORD=... DB_NAME=relaydesk_test npm test
```

The suite wipes the database, so it refuses to run unless `DB_NAME` contains "test". It starts the real app in production mode and covers these areas:

- **Sign-in:** login, origin checks, throttling.
- **Webhooks:** signature verification, idempotent redelivery, out-of-order messages and statuses.
- **Messaging:** media proxy, number sync pagination and token stripping, 24-hour window enforcement, template validation and sending, new conversations, failed-send recording.
- **Operations:** backup → wipe → restore drill, truncated-backup rollback, retention.

## API routes

- `GET /health` reports database connectivity and non-secret configuration status.
- `GET|POST /webhooks/whatsapp` handles the Meta handshake and signed events.
- `/api/auth/status|login|logout` handles sign-in.
- `GET /api/overview` returns counts.
- `GET /api/conversations?state=&q=&phone=` lists conversations. `POST /api/conversations` starts one with a template.
- `GET /api/conversations/:id`, `GET|POST /api/conversations/:id/messages`, `POST /api/conversations/:id/template` and `POST /api/conversations/:id/state` read and act on one conversation.
- `GET /api/messages/:id/media` proxies inbound media.
- `GET /api/templates[?refresh=1]` lists approved templates.
- `GET /api/numbers` and `POST /api/numbers/sync` list and sync numbers.

## Not built yet

- Multiple agents or admins, roles, assignment, audit log
- Outbound media
- Media-header templates
- Labels, notes, tickets, broadcasts, automations, analytics
- A job queue

Webhooks are processed synchronously, and inserts are idempotent, so Meta's retries are safe. It has not been load-tested at 100+ numbers.

See `DEPLOYMENT.md` for the Hostinger checklist.

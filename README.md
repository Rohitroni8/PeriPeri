# Relaydesk shared inbox

Relaydesk is a single-administrator WhatsApp inbox using Meta's official WhatsApp Business Platform Cloud API. It supports inbound webhook delivery, text replies, conversation open/close, session-based sign-in, and paginated phone-number synchronization into MySQL. It does not automate WhatsApp Web or scan browser sessions.

## Current readiness

The app now stores numbers, contacts, conversations, messages, and sessions in MySQL. It creates the required tables at startup and needs a persistent MySQL database before the app can start. Hostinger Business Web supports managed Node.js apps and MySQL. The application has not been deployed or connected to the new phone number yet.

This is a production deployment candidate for a controlled single-admin pilot after the deployment checklist is complete. It is not a feature-complete Periskope replacement: approved template sending, media handling, assignment, multiple administrator accounts, exports, backups/retention automation, and a job queue are not implemented. Free-form replies remain subject to Meta's customer-service window and messaging rules.

## Local setup

1. Use Node.js 22 or 24 and create a MySQL database.
2. Copy `.env.example` to `.env` and set the database connection plus a private admin email and unique password (at least 16 characters for production).
3. Run `npm install`, then `npm start` in this directory. The app creates its tables when it starts.
4. Open `http://localhost:8787` and sign in.

Do not commit `.env`. Keep the admin password, MySQL password, Meta access token, Meta app secret, and webhook verify token in private environment settings.

## Connect the new Meta Cloud API number

1. In Meta Business, create or select a WhatsApp Business Account (WABA), add the new number, receive its verification code, and register it for Cloud API.
2. Create a production system-user access token with the required WhatsApp permissions. Use a token intended for ongoing server use, not the short-lived test token from the Getting Started panel.
3. In Hostinger's private environment settings, set `WA_BUSINESS_ACCOUNT_ID`, `WA_ACCESS_TOKEN`, `WA_GRAPH_API_VERSION`, `META_APP_SECRET`, and a newly generated random `WA_VERIFY_TOKEN`.
4. In Meta App Webhooks, set the callback to `https://YOUR-HOST/webhooks/whatsapp`, enter the same verification token, and subscribe the WABA to `messages`.
5. Sign in and click **Sync numbers from Meta**. The app fetches every page of phone numbers attached to the WABA. The Meta Phone Number ID previously supplied is expected to appear in this API response; the app does not hard-code it.
6. Send a controlled inbound message and reply from the inbox before inviting real agents or handling customer traffic.

Meta references: [WhatsApp Business Developer Hub](https://whatsappbusiness.com/developers/developer-hub/), [Cloud API Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started), [Phone Number API](https://www.postman.com/meta/whatsapp-business-platform/folder/ypba0gk/phone-numbers), and [Cloud API webhooks](https://www.postman.com/meta/whatsapp-business-platform/folder/lboq68h/webhooks).

## API routes

- `GET /health` — database connectivity and non-secret configuration status
- `GET /webhooks/whatsapp`, `POST /webhooks/whatsapp` — Meta handshake and signed event receiver
- `/api/auth/*` — one administrator sign-in and logout
- `GET /api/conversations` — inbox list and search
- `GET /api/conversations/:id/messages` — messages for a conversation
- `POST /api/conversations/:id/messages` — send a text reply through Meta Cloud API
- `POST /api/conversations/:id/state` — close or reopen a conversation
- `GET /api/numbers`, `POST /api/numbers/sync` — list and sync WABA phone numbers

The `sync:numbers` command can also sync the WABA inventory into the configured MySQL database. The database credentials must have permission to create and update the application's tables.

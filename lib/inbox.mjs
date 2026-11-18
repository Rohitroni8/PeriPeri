import { withTransaction } from './db.mjs';
import { sendMessage, listTemplates, renderTemplate, templatePayload, GraphError } from './graph.mjs';

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);
// Later statuses never move backwards (Meta can deliver webhooks out of order).
const STATUS_ORDER = ['sending', 'sent', 'delivered', 'read', 'failed'];

export function extractBody(message) {
  const type = message.type;
  if (type === 'text') return message.text?.body || '';
  if (type === 'button') return message.button?.text || '[button reply]';
  if (type === 'interactive') return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[interactive reply]';
  if (type === 'reaction') return message.reaction?.emoji ? `Reacted ${message.reaction.emoji}` : '[reaction removed]';
  if (type === 'location') {
    const l = message.location || {};
    return ['📍', l.name, l.address, l.latitude != null ? `${l.latitude}, ${l.longitude}` : ''].filter(Boolean).join(' ');
  }
  if (type === 'contacts') return `[shared contact: ${(message.contacts || []).map(c => c.name?.formatted_name).filter(Boolean).join(', ') || 'contact'}]`;
  if (MEDIA_TYPES.has(type)) return message[type]?.caption || '';
  if (type === 'unsupported') return '[message type not supported by WhatsApp Cloud API]';
  return `[${type || 'message'}]`;
}

function preview(message) {
  const text = extractBody(message);
  if (text) return text;
  if (message.type === 'document') return `📄 ${message.document?.filename || 'Document'}`;
  return `[${message.type}]`;
}

function isoFromEpoch(seconds, fallback) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 && value <= 8640000000 ? new Date(value * 1000).toISOString() : fallback;
}

async function ensureConversation(connection, phoneId, waId, now) {
  await connection.execute(`INSERT INTO phone_numbers(phone_number_id, updated_at) VALUES(?, ?)
    ON DUPLICATE KEY UPDATE phone_number_id=phone_number_id`, [phoneId, now]);
  await connection.execute(`INSERT INTO contacts(wa_id, updated_at) VALUES(?, ?)
    ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)`, [waId, now]);
  const [[contact]] = await connection.execute('SELECT id FROM contacts WHERE wa_id=?', [waId]);
  await connection.execute(`INSERT INTO conversations(phone_number_id, contact_id, created_at, updated_at)
    VALUES(?, ?, ?, ?) ON DUPLICATE KEY UPDATE id=id`, [phoneId, contact.id, now, now]);
  const [[conversation]] = await connection.execute('SELECT id FROM conversations WHERE phone_number_id=? AND contact_id=?', [phoneId, contact.id]);
  return { contactId: contact.id, conversationId: conversation.id };
}

export async function storeInbound(db, phoneId, message, profileName) {
  const now = new Date().toISOString();
  const sentAt = isoFromEpoch(message.timestamp, now);
  const media = MEDIA_TYPES.has(message.type) ? message[message.type] || {} : {};
  return withTransaction(db, async connection => {
    const { contactId, conversationId } = await ensureConversation(connection, phoneId, message.from, now);
    const [insert] = await connection.execute(`INSERT IGNORE INTO messages(conversation_id, wa_message_id, direction, message_type, body,
        media_id, media_mime, media_filename, status, sent_at, created_at)
      VALUES(?, ?, 'inbound', ?, ?, ?, ?, ?, 'received', ?, ?)`,
    [conversationId, message.id, String(message.type || 'unknown').slice(0, 32), extractBody(message),
      media.id || null, media.mime_type ? String(media.mime_type).slice(0, 128) : null,
      media.filename ? String(media.filename).slice(0, 255) : null, sentAt, now]);
    if (insert.affectedRows) {
      // GREATEST keeps the newest timestamp when Meta delivers messages out of order.
      await connection.execute(`UPDATE conversations SET
          last_message_preview=IF(COALESCE(last_message_at,'') <= ?, ?, last_message_preview),
          last_message_at=GREATEST(COALESCE(last_message_at,''), ?),
          last_inbound_at=GREATEST(COALESCE(last_inbound_at,''), ?),
          unread_count=unread_count+1, state='open', updated_at=? WHERE id=?`,
      [sentAt, preview(message).slice(0, 500), sentAt, sentAt, now, conversationId]);
    }
    if (profileName) await connection.execute('UPDATE contacts SET profile_name=? WHERE id=?', [String(profileName).slice(0, 255), contactId]);
    return { conversationId, inserted: Boolean(insert.affectedRows) };
  });
}

export async function applyStatus(db, status) {
  const rank = STATUS_ORDER.indexOf(status.status);
  if (rank < 0) return false;
  const error = status.errors?.[0];
  const [result] = await db.execute(`UPDATE messages SET status=?, error_code=COALESCE(?, error_code), error_title=COALESCE(?, error_title)
    WHERE wa_message_id=? AND direction='outbound' AND (FIELD(status, ${STATUS_ORDER.map(() => '?').join(',')}) - 1) <= ?`,
  [status.status, error?.code != null ? String(error.code) : null, error ? String(error.error_data?.details || error.title || error.message || '').slice(0, 255) || null : null,
    status.id, ...STATUS_ORDER, rank]);
  return result.affectedRows > 0;
}

export async function processWebhook(db, payload) {
  const summary = { messages: 0, statuses: 0 };
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    if (change.field && change.field !== 'messages') continue;
    const value = change.value || {};
    const phoneId = value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null;
    const names = new Map((value.contacts || []).map(contact => [contact.wa_id, contact.profile?.name || null]));
    for (const message of value.messages || []) {
      if (!phoneId || !message.id || !message.from) continue;
      const result = await storeInbound(db, phoneId, message, names.get(message.from));
      if (result.inserted) summary.messages += 1;
    }
    for (const status of value.statuses || []) {
      if (status.id && status.status && await applyStatus(db, status)) summary.statuses += 1;
    }
  }
  return summary;
}

export async function conversationList(db, { search = '', state = 'open', phone = '' } = {}) {
  const term = `%${search}%`;
  const stateFilter = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  const [rows] = await db.execute(`SELECT c.id, c.phone_number_id, c.last_message_at, c.last_inbound_at, c.last_message_preview, c.unread_count, c.state,
      p.display_phone_number, p.verified_name, t.wa_id, t.profile_name
    FROM conversations c JOIN contacts t ON t.id=c.contact_id
    LEFT JOIN phone_numbers p ON p.phone_number_id=c.phone_number_id
    WHERE (?='all' OR c.state=?) AND (?='' OR c.phone_number_id=?)
      AND (?='' OR t.wa_id LIKE ? OR COALESCE(t.profile_name,'') LIKE ? OR c.last_message_preview LIKE ?)
    ORDER BY COALESCE(c.last_message_at,'') DESC LIMIT 300`, [stateFilter, stateFilter, phone, phone, search, term, term, term]);
  return rows.map(withWindow);
}

export function withWindow(row) {
  const last = row.last_inbound_at ? Date.parse(row.last_inbound_at) : NaN;
  const closesAt = Number.isFinite(last) ? last + SERVICE_WINDOW_MS : null;
  return { ...row, window_open: closesAt !== null && closesAt > Date.now(), window_closes_at: closesAt ? new Date(closesAt).toISOString() : null };
}

async function loadConversation(db, conversationId) {
  const [[row]] = await db.execute(`SELECT c.id, c.phone_number_id, c.last_inbound_at, t.wa_id FROM conversations c
    JOIN contacts t ON t.id=c.contact_id WHERE c.id=?`, [conversationId]);
  if (!row) throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 });
  return withWindow(row);
}

// Records the outbound message before calling Meta so a failed send is still
// visible in the thread, then stores the WhatsApp message ID on success.
async function deliver(db, conversation, { type, body, payload }) {
  const now = new Date().toISOString();
  const [insert] = await db.execute(`INSERT INTO messages(conversation_id, wa_message_id, direction, message_type, body, status, sent_at, created_at)
    VALUES(?, NULL, 'outbound', ?, ?, 'sending', ?, ?)`, [conversation.id, type, body, now, now]);
  const localId = insert.insertId;
  try {
    const waMessageId = await sendMessage(conversation.phone_number_id, { to: conversation.wa_id, ...payload });
    await db.execute(`UPDATE messages SET wa_message_id=?, status=IF(status='sending','sent',status) WHERE id=?`, [waMessageId, localId]);
    await db.execute(`UPDATE conversations SET last_message_at=?, last_message_preview=?, updated_at=?, state='open' WHERE id=?`,
      [now, body.slice(0, 500), now, conversation.id]);
    return { id: localId, wa_message_id: waMessageId, status: 'sent' };
  } catch (error) {
    const code = error instanceof GraphError && error.code != null ? String(error.code) : null;
    await db.execute(`UPDATE messages SET status='failed', error_code=?, error_title=? WHERE id=?`,
      [code, String(error.message || 'send failed').slice(0, 255), localId]);
    throw Object.assign(error, { statusCode: error.statusCode || 502 });
  }
}

export async function sendText(db, conversationId, text) {
  const conversation = await loadConversation(db, conversationId);
  if (!conversation.window_open) {
    throw Object.assign(new Error('The 24-hour customer service window is closed. Send an approved template instead.'), { statusCode: 409, code: 'window_closed' });
  }
  return deliver(db, conversation, { type: 'text', body: text, payload: { type: 'text', text: { preview_url: false, body: text } } });
}

async function resolveTemplate(name, language, bodyParams, headerParams) {
  const template = (await listTemplates()).find(t => t.name === name && t.language === language);
  if (!template) throw Object.assign(new Error('Template not found or not approved.'), { statusCode: 400 });
  if (!template.supported) throw Object.assign(new Error(`This template uses ${template.unsupported_reason}, which the composer does not support yet.`), { statusCode: 400 });
  const clean = list => (Array.isArray(list) ? list : []).map(v => String(v ?? '').trim());
  const body = clean(bodyParams), header = clean(headerParams);
  if (body.length !== template.body_params || body.some(v => !v || v.length > 1024)) throw Object.assign(new Error(`Fill in all ${template.body_params} template variable(s).`), { statusCode: 400 });
  if (header.length !== template.header_params || header.some(v => !v || v.length > 60)) throw Object.assign(new Error('Fill in the template header variable.'), { statusCode: 400 });
  return { template, body, header };
}

export async function sendTemplate(db, conversationId, { name, language, body_params, header_params }) {
  const conversation = await loadConversation(db, conversationId);
  const { template, body, header } = await resolveTemplate(name, language, body_params, header_params);
  return deliver(db, conversation, { type: 'template', body: renderTemplate(template, body, header), payload: { type: 'template', template: templatePayload(template, body, header) } });
}

export function normalizeWaId(value) {
  const digits = String(value || '').replace(/[\s()+-]/g, '');
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

// Business-initiated conversations must start with an approved template.
export async function startConversation(db, { phone_number_id, to, template }) {
  const waId = normalizeWaId(to);
  if (!waId) throw Object.assign(new Error('Enter the recipient number in international format, e.g. +44 7400 000000.'), { statusCode: 400 });
  const [[phone]] = await db.execute('SELECT phone_number_id FROM phone_numbers WHERE phone_number_id=?', [String(phone_number_id || '')]);
  if (!phone) throw Object.assign(new Error('Choose one of the synced WhatsApp numbers to send from.'), { statusCode: 400 });
  const resolved = await resolveTemplate(template?.name, template?.language, template?.body_params, template?.header_params);
  const now = new Date().toISOString();
  const { conversationId } = await withTransaction(db, connection => ensureConversation(connection, phone.phone_number_id, waId, now));
  const conversation = await loadConversation(db, conversationId);
  const result = await deliver(db, conversation, {
    type: 'template', body: renderTemplate(resolved.template, resolved.body, resolved.header),
    payload: { type: 'template', template: templatePayload(resolved.template, resolved.body, resolved.header) }
  });
  return { ...result, conversation_id: conversationId };
}

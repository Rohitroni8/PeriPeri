import { nextId, isDuplicateKey } from './db.mjs';
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

async function ensureContact(db, waId, now) {
  const contacts = db.collection('contacts');
  const existing = await contacts.findOneAndUpdate({ wa_id: waId }, { $set: { updated_at: now } }, { returnDocument: 'after' });
  if (existing) return existing._id;
  const id = await nextId(db, 'contacts');
  try {
    await contacts.insertOne({ _id: id, wa_id: waId, profile_name: null, updated_at: now });
    return id;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return (await contacts.findOne({ wa_id: waId }))._id; // created concurrently
  }
}

async function ensureConversation(db, phoneId, waId, now) {
  await db.collection('phone_numbers').updateOne({ _id: phoneId }, {
    $setOnInsert: { display_phone_number: null, verified_name: null, quality_rating: null, status: 'connected', updated_at: now }
  }, { upsert: true });
  const contactId = await ensureContact(db, waId, now);
  const conversations = db.collection('conversations');
  const filter = { phone_number_id: phoneId, contact_id: contactId };
  const existing = await conversations.findOne(filter, { projection: { _id: 1 } });
  if (existing) return { contactId, conversationId: existing._id };
  const id = await nextId(db, 'conversations');
  try {
    await conversations.insertOne({ _id: id, ...filter, last_message_at: null, last_inbound_at: null, last_message_preview: '',
      unread_count: 0, state: 'open', created_at: now, updated_at: now });
    return { contactId, conversationId: id };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return { contactId, conversationId: (await conversations.findOne(filter))._id };
  }
}

const literal = value => ({ $literal: value });

export async function storeInbound(db, phoneId, message, profileName) {
  const now = new Date().toISOString();
  const sentAt = isoFromEpoch(message.timestamp, now);
  const media = MEDIA_TYPES.has(message.type) ? message[message.type] || {} : {};
  const { contactId, conversationId } = await ensureConversation(db, phoneId, String(message.from), now);
  let inserted = false;
  try {
    await db.collection('messages').insertOne({
      _id: await nextId(db, 'messages'), conversation_id: conversationId, wa_message_id: String(message.id), direction: 'inbound',
      message_type: String(message.type || 'unknown').slice(0, 32), body: extractBody(message),
      media_id: media.id ? String(media.id) : null, media_mime: media.mime_type ? String(media.mime_type).slice(0, 128) : null,
      media_filename: media.filename ? String(media.filename).slice(0, 255) : null,
      status: 'received', error_code: null, error_title: null, sent_at: sentAt, created_at: now
    });
    inserted = true;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error; // Meta redelivered a message we already have.
  }
  if (inserted) {
    // $max keeps the newest timestamp when Meta delivers messages out of order.
    // Expressions in one $set stage all read the values from before the update.
    const last = { $ifNull: ['$last_message_at', ''] };
    await db.collection('conversations').updateOne({ _id: conversationId }, [{ $set: {
      last_message_preview: { $cond: [{ $lte: [last, literal(sentAt)] }, literal(preview(message).slice(0, 500)), '$last_message_preview'] },
      last_message_at: { $max: [last, literal(sentAt)] },
      last_inbound_at: { $max: [{ $ifNull: ['$last_inbound_at', ''] }, literal(sentAt)] },
      unread_count: { $add: [{ $ifNull: ['$unread_count', 0] }, 1] },
      state: 'open',
      updated_at: literal(now)
    } }]);
  }
  if (profileName) await db.collection('contacts').updateOne({ _id: contactId }, { $set: { profile_name: String(profileName).slice(0, 255) } });
  return { conversationId, inserted };
}

export async function applyStatus(db, status) {
  const rank = STATUS_ORDER.indexOf(status.status);
  if (rank < 0) return false;
  const error = status.errors?.[0];
  const update = { status: status.status };
  if (error?.code != null) update.error_code = String(error.code);
  const title = error ? String(error.error_data?.details || error.title || error.message || '').slice(0, 255) : '';
  if (title) update.error_title = title;
  const result = await db.collection('messages').updateOne(
    { wa_message_id: String(status.id), direction: 'outbound', status: { $in: STATUS_ORDER.slice(0, rank + 1) } },
    { $set: update }
  );
  return result.modifiedCount > 0;
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

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Joins a conversation with its contact and number, shaped like the API rows.
export function conversationPipeline(match, { search = '', limit = 300 } = {}) {
  const pipeline = [
    { $match: match },
    { $lookup: { from: 'contacts', localField: 'contact_id', foreignField: '_id', as: 'contact' } },
    { $unwind: '$contact' },
    { $lookup: { from: 'phone_numbers', localField: 'phone_number_id', foreignField: '_id', as: 'phone' } },
    { $unwind: { path: '$phone', preserveNullAndEmptyArrays: true } }
  ];
  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: 'i' };
    pipeline.push({ $match: { $or: [{ 'contact.wa_id': pattern }, { 'contact.profile_name': pattern }, { last_message_preview: pattern }] } });
  }
  pipeline.push({ $sort: { last_message_at: -1, _id: -1 } }, { $limit: limit }, { $project: {
    _id: 0, id: '$_id', phone_number_id: 1, last_message_at: 1, last_inbound_at: 1, last_message_preview: 1, unread_count: 1, state: 1,
    display_phone_number: { $ifNull: ['$phone.display_phone_number', null] }, verified_name: { $ifNull: ['$phone.verified_name', null] },
    wa_id: '$contact.wa_id', profile_name: { $ifNull: ['$contact.profile_name', null] }
  } });
  return pipeline;
}

export async function conversationList(db, { search = '', state = 'open', phone = '' } = {}) {
  const match = {};
  if (['open', 'closed'].includes(state)) match.state = state;
  else if (state !== 'all') match.state = 'open';
  if (phone) match.phone_number_id = phone;
  const rows = await db.collection('conversations').aggregate(conversationPipeline(match, { search })).toArray();
  return rows.map(withWindow);
}

export async function getConversation(db, conversationId) {
  const [row] = await db.collection('conversations').aggregate(conversationPipeline({ _id: conversationId }, { limit: 1 })).toArray();
  return row ? withWindow(row) : null;
}

export function withWindow(row) {
  const last = row.last_inbound_at ? Date.parse(row.last_inbound_at) : NaN;
  const closesAt = Number.isFinite(last) ? last + SERVICE_WINDOW_MS : null;
  return { ...row, window_open: closesAt !== null && closesAt > Date.now(), window_closes_at: closesAt ? new Date(closesAt).toISOString() : null };
}

async function loadConversation(db, conversationId) {
  const row = await getConversation(db, conversationId);
  if (!row) throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 });
  return row;
}

// Records the outbound message before calling Meta so a failed send is still
// visible in the thread, then stores the WhatsApp message ID on success.
async function deliver(db, conversation, { type, body, payload }) {
  const now = new Date().toISOString();
  const messages = db.collection('messages');
  const conversations = db.collection('conversations');
  const localId = await nextId(db, 'messages');
  await messages.insertOne({ _id: localId, conversation_id: conversation.id, wa_message_id: null, direction: 'outbound', message_type: type, body,
    media_id: null, media_mime: null, media_filename: null, status: 'sending', error_code: null, error_title: null, sent_at: now, created_at: now });
  try {
    const waMessageId = await sendMessage(conversation.phone_number_id, { to: conversation.wa_id, ...payload });
    // A status webhook can arrive before this update; never move it backwards.
    await messages.updateOne({ _id: localId }, [{ $set: { wa_message_id: literal(waMessageId),
      status: { $cond: [{ $eq: ['$status', 'sending'] }, 'sent', '$status'] } } }]);
    await conversations.updateOne({ _id: conversation.id }, { $set: { last_message_at: now, last_message_preview: body.slice(0, 500), updated_at: now, state: 'open' } });
    return { id: localId, wa_message_id: waMessageId, status: 'sent' };
  } catch (error) {
    const code = error instanceof GraphError && error.code != null ? String(error.code) : null;
    await messages.updateOne({ _id: localId }, { $set: { status: 'failed', error_code: code, error_title: String(error.message || 'send failed').slice(0, 255) } });
    // Keep the list preview in step with the thread so failed attempts are visible.
    await conversations.updateOne({ _id: conversation.id }, { $set: { last_message_at: now, last_message_preview: `⚠ ${body}`.slice(0, 500), updated_at: now } });
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
  const phone = await db.collection('phone_numbers').findOne({ _id: String(phone_number_id || '') });
  if (!phone) throw Object.assign(new Error('Choose one of the synced WhatsApp numbers to send from.'), { statusCode: 400 });
  const resolved = await resolveTemplate(template?.name, template?.language, template?.body_params, template?.header_params);
  const now = new Date().toISOString();
  const { conversationId } = await ensureConversation(db, phone._id, waId, now);
  const conversation = await loadConversation(db, conversationId);
  const result = await deliver(db, conversation, {
    type: 'template', body: renderTemplate(resolved.template, resolved.body, resolved.header),
    payload: { type: 'template', template: templatePayload(resolved.template, resolved.body, resolved.header) }
  });
  return { ...result, conversation_id: conversationId };
}

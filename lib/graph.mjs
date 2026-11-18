import { withTransaction } from './db.mjs';

const GRAPH_HOST = 'graph.facebook.com';

export function graphVersion() {
  return (process.env.WA_GRAPH_API_VERSION || '').trim().replace(/^\/+|\/+$/g, '');
}

export function graphConfigured() {
  return Boolean(process.env.WA_BUSINESS_ACCOUNT_ID && process.env.WA_ACCESS_TOKEN && /^v\d+\.\d+$/.test(graphVersion()));
}

function settings({ needWaba = false } = {}) {
  const version = graphVersion();
  const token = process.env.WA_ACCESS_TOKEN || '';
  const wabaId = process.env.WA_BUSINESS_ACCOUNT_ID || '';
  if (!/^v\d+\.\d+$/.test(version) || !token || (needWaba && !/^\d+$/.test(wabaId))) {
    throw Object.assign(new Error('WhatsApp Cloud API is not configured. Set WA_GRAPH_API_VERSION, WA_BUSINESS_ACCOUNT_ID and WA_ACCESS_TOKEN in the private server environment.'), { statusCode: 503 });
  }
  return { version, token, wabaId };
}

export class GraphError extends Error {
  constructor(message, { status, code, title, details } = {}) {
    super(message);
    this.statusCode = 502;
    this.metaStatus = status;
    this.code = code;
    this.title = title;
    this.details = details;
  }
}

async function graphFetch(url, { method = 'GET', body, timeout = 20000 } = {}) {
  const { token } = settings();
  const target = url instanceof URL ? url : new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== GRAPH_HOST) throw new Error('Refusing to send credentials to a non-Graph host.');
  const response = await fetch(target, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data?.error || {};
    const detail = error.error_data?.details;
    throw new GraphError(detail || error.message || `Meta Graph API request failed (${response.status}).`, {
      status: response.status, code: error.code, title: error.error_user_title || error.message, details: detail
    });
  }
  return data;
}

// Follows Graph API cursor pagination, re-validating the host on every page and
// stripping any credential Meta echoes into the next URL.
async function graphPaginate(firstUrl, maxPages = 100) {
  const items = [];
  let nextUrl = firstUrl;
  let pages = 0;
  while (nextUrl && pages < maxPages) {
    const body = await graphFetch(nextUrl, { timeout: 30000 });
    items.push(...(body.data || []));
    pages += 1;
    const rawNext = body.paging?.next;
    if (!rawNext) break;
    const candidate = new URL(rawNext);
    if (candidate.protocol !== 'https:' || candidate.hostname !== GRAPH_HOST) throw new Error('Unexpected Meta pagination host; stopped before sending credentials.');
    candidate.searchParams.delete('access_token');
    candidate.searchParams.delete('appsecret_proof');
    nextUrl = candidate;
  }
  return { items, pages };
}

export async function fetchWabaNumbers() {
  const { version, wabaId } = settings({ needWaba: true });
  const url = new URL(`https://${GRAPH_HOST}/${version}/${encodeURIComponent(wabaId)}/phone_numbers`);
  url.searchParams.set('fields', 'id,display_phone_number,verified_name,quality_rating,status');
  url.searchParams.set('limit', '100');
  const { items, pages } = await graphPaginate(url);
  const unique = new Map();
  for (const number of items) if (number.id) unique.set(String(number.id), number);
  return { numbers: [...unique.values()], pages };
}

export async function syncNumbers(db) {
  const { numbers, pages } = await fetchWabaNumbers();
  const now = new Date().toISOString();
  await withTransaction(db, async connection => {
    for (const number of numbers) {
      await connection.execute(`INSERT INTO phone_numbers(phone_number_id, display_phone_number, verified_name, quality_rating, status, updated_at)
        VALUES(?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE display_phone_number=VALUES(display_phone_number),
        verified_name=VALUES(verified_name), quality_rating=VALUES(quality_rating), status=VALUES(status), updated_at=VALUES(updated_at)`,
      [String(number.id), number.display_phone_number || null, number.verified_name || null, number.quality_rating || null,
        String(number.status || 'connected').toLowerCase().slice(0, 32), now]);
    }
  });
  return { synced: numbers.length, pages };
}

let templateCache = { at: 0, items: null };

export async function listTemplates({ fresh = false } = {}) {
  if (!fresh && templateCache.items && Date.now() - templateCache.at < 5 * 60 * 1000) return templateCache.items;
  const { version, wabaId } = settings({ needWaba: true });
  const url = new URL(`https://${GRAPH_HOST}/${version}/${encodeURIComponent(wabaId)}/message_templates`);
  url.searchParams.set('fields', 'name,language,status,category,components');
  url.searchParams.set('limit', '100');
  const { items } = await graphPaginate(url, 20);
  const templates = items.filter(t => t.status === 'APPROVED').map(describeTemplate)
    .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  templateCache = { at: Date.now(), items: templates };
  return templates;
}

export function clearTemplateCache() { templateCache = { at: 0, items: null }; }

function placeholderCount(text = '') {
  const found = new Set([...String(text).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => Number(m[1])));
  return found.size ? Math.max(...found) : 0;
}

// Reduces a Meta template to what the composer needs and flags parts this app
// cannot fill in yet (media headers, dynamic URL buttons, named parameters).
export function describeTemplate(template) {
  const components = template.components || [];
  const header = components.find(c => c.type === 'HEADER');
  const body = components.find(c => c.type === 'BODY');
  const footer = components.find(c => c.type === 'FOOTER');
  const buttons = components.find(c => c.type === 'BUTTONS')?.buttons || [];
  const reasons = [];
  if (header && header.format && header.format !== 'TEXT') reasons.push(`${header.format.toLowerCase()} header`);
  if (buttons.some(b => b.type === 'URL' && /\{\{/.test(b.url || ''))) reasons.push('dynamic URL button');
  if (/\{\{\s*[a-z_]/i.test(body?.text || '') || /\{\{\s*[a-z_]/i.test(header?.text || '')) reasons.push('named parameters');
  return {
    name: template.name,
    language: template.language,
    category: template.category,
    header_text: header?.format === 'TEXT' ? header.text || '' : '',
    header_params: header?.format === 'TEXT' ? placeholderCount(header.text) : 0,
    body_text: body?.text || '',
    body_params: placeholderCount(body?.text),
    footer_text: footer?.text || '',
    buttons: buttons.map(b => b.text).filter(Boolean),
    supported: reasons.length === 0,
    unsupported_reason: reasons.join(', ') || null
  };
}

export function renderTemplate(template, bodyParams = [], headerParams = []) {
  const fill = (text, params) => String(text).replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] ?? `{{${n}}}`);
  return [template.header_text && fill(template.header_text, headerParams), fill(template.body_text, bodyParams), template.footer_text]
    .filter(Boolean).join('\n\n');
}

export function templatePayload(template, bodyParams = [], headerParams = []) {
  const components = [];
  if (template.header_params) components.push({ type: 'header', parameters: headerParams.map(text => ({ type: 'text', text })) });
  if (template.body_params) components.push({ type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text })) });
  return { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) };
}

export async function sendMessage(phoneNumberId, payload) {
  const { version } = settings();
  const url = `https://${GRAPH_HOST}/${version}/${encodeURIComponent(phoneNumberId)}/messages`;
  const body = await graphFetch(url, { method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload } });
  return body.messages?.[0]?.id || null;
}

// Resolves a WhatsApp media ID to a short-lived download URL, then fetches the
// bytes with the access token. Returns a fetch Response for streaming.
export async function downloadMedia(mediaId) {
  const { version, token } = settings();
  const meta = await graphFetch(`https://${GRAPH_HOST}/${version}/${encodeURIComponent(mediaId)}`);
  if (!meta.url) throw new GraphError('Meta did not return a media URL.');
  const mediaUrl = new URL(meta.url);
  if (mediaUrl.protocol !== 'https:' || !/(^|\.)(facebook\.com|fbsbx\.com|fbcdn\.net|whatsapp\.net)$/.test(mediaUrl.hostname)) {
    throw new GraphError('Unexpected media host; refusing to send credentials.');
  }
  const response = await fetch(mediaUrl, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new GraphError(`Media download failed (${response.status}). Meta keeps inbound media for a limited time.`);
  return { response, mime: meta.mime_type || response.headers.get('content-type') || 'application/octet-stream', size: Number(meta.file_size) || null };
}

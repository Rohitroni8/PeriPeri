// Preloaded into the app process during tests (node --import). Replaces fetch
// for Meta hosts with a deterministic fake so no real credentials or network
// are needed. Every call is appended to MOCK_GRAPH_LOG for assertions.
import fs from 'node:fs';

const realFetch = globalThis.fetch;
const log = process.env.MOCK_GRAPH_LOG;
const record = entry => { if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let counter = 0;

const TEMPLATES = [
  { name: 'order_update', language: 'en_GB', status: 'APPROVED', category: 'UTILITY', components: [
    { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
    { type: 'BODY', text: 'Hi {{1}}, your order is {{2}}.' },
    { type: 'FOOTER', text: 'Elite Gold Signal' }] },
  { name: 'hello', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hello from us!' }] },
  { name: 'promo_image', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [
    { type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'New offer' }] },
  { name: 'draft_one', language: 'en_US', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] }
];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['graph.facebook.com', 'lookaside.fbsbx.com'].includes(url.hostname)) return realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  const auth = new Headers(init.headers || {}).get('authorization');
  const body = init.body ? JSON.parse(init.body) : null;
  record({ method, host: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams), auth, body });
  if (auth !== `Bearer ${process.env.WA_ACCESS_TOKEN}`) return json(401, { error: { message: 'Invalid OAuth access token', code: 190 } });

  if (url.hostname === 'lookaside.fbsbx.com') {
    // MOCK_MEDIA_FILE lets the demo show a real picture; tests use fixed bytes.
    if (process.env.MOCK_MEDIA_FILE) return new Response(fs.readFileSync(process.env.MOCK_MEDIA_FILE), { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response(Buffer.from('FAKEJPEGBYTES'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '13' } });
  }

  const [, , objectId, edge] = url.pathname.split('/');
  if (edge === 'phone_numbers') {
    if (url.searchParams.get('after') === 'PAGE2') {
      return json(200, { data: [{ id: '1148479081159296', display_phone_number: '+44 7862 617669', verified_name: 'Elite Gold Signal', quality_rating: 'GREEN', status: 'CONNECTED' }] });
    }
    return json(200, {
      data: [
        { id: '100000000000001', display_phone_number: '+44 7000 000001', verified_name: 'Test One', quality_rating: 'GREEN', status: 'CONNECTED' },
        { id: '100000000000002', display_phone_number: '+44 7000 000002', verified_name: 'Test Two', quality_rating: 'YELLOW', status: 'CONNECTED' }
      ],
      // Meta embeds the token in the next link; the app must strip it.
      paging: { next: `https://graph.facebook.com${url.pathname}?limit=100&after=PAGE2&access_token=SHOULD_BE_STRIPPED` }
    });
  }
  if (edge === 'message_templates') return json(200, { data: TEMPLATES });
  if (edge === 'messages' && method === 'POST') {
    if (body.to === '440000000000') {
      return json(400, { error: { message: '(#131026) Message undeliverable', code: 131026, error_data: { details: 'Recipient is not a valid WhatsApp user' } } });
    }
    counter += 1;
    return json(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.OUT${counter}` }] });
  }
  if (!edge && /^MEDIA/.test(objectId)) {
    return json(200, { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${objectId}`, mime_type: 'image/jpeg', file_size: 13, id: objectId });
  }
  return json(404, { error: { message: 'Unknown mock route', code: 100 } });
};

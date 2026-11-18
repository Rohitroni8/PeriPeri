const root = document.querySelector('#root');
const toastNode = document.querySelector('#toast');
const state = {
  page: 'inbox', filter: 'open', phone: '', search: '', email: '',
  conversations: [], selected: null, messages: [], numbers: [], templates: null, overview: {}, timer: null
};

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status, code: data.code });
  return data;
}
function toast(message) { toastNode.textContent = message; toastNode.classList.add('show'); clearTimeout(toastNode._timer); toastNode._timer = setTimeout(() => toastNode.classList.remove('show'), 3500); }
function esc(value = '') { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function avatarText(row) { return row.profile_name ? initials(row.profile_name) : '#'; }
function initials(value = '') { return String(value).trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'WA'; }
function clock(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(+date) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function dayLabel(value) {
  if (!value) return ''; const date = new Date(value); const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  return date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function listTime(value) { if (!value) return ''; const label = dayLabel(value); return label === 'Today' ? clock(value) : label; }
function numberLabel(row) { return row.display_phone_number || row.phone_number_id; }
function windowText(conversation) {
  if (!conversation.window_closes_at) return 'No customer message yet · template required';
  if (!conversation.window_open) return 'Reply window closed · template required';
  const hours = Math.max(0, (Date.parse(conversation.window_closes_at) - Date.now()) / 3600000);
  return `Reply window open · ${hours >= 1 ? `${Math.floor(hours)}h` : `${Math.ceil(hours * 60)}m`} left`;
}

function loginView(error = '') {
  clearInterval(state.timer);
  root.innerHTML = `<section class="login-wrap"><form class="login" id="loginForm"><div class="brand"><span class="brand-mark">R</span> Relaydesk</div><h1>Sign in to your inbox</h1><p class="muted">Your private WhatsApp Business workspace.</p><div class="field"><label for="email">Administrator email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><div class="error" id="loginError">${esc(error)}</div><button class="primary" type="submit">Sign in</button></form></section>`;
  document.querySelector('#loginForm').onsubmit = async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { const form = new FormData(event.currentTarget); await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }); await boot(); }
    catch (err) { document.querySelector('#loginError').textContent = err.message; button.disabled = false; }
  };
}

// Full render: used when the page or selected conversation changes. Polling
// uses updateList/renderMessages instead so typed text is never wiped.
function renderShell() {
  const admin = state.email || 'Administrator';
  const pageContent = state.page === 'settings' ? settingsPage() : state.page === 'numbers' ? numbersPage() : inboxPage();
  root.innerHTML = `<div class="shell ${state.selected && state.page === 'inbox' ? 'chat-open' : ''} ${state.page === 'settings' ? 'settings-open' : ''} ${state.page === 'numbers' ? 'numbers-open' : ''}">
    <aside class="sidebar"><div class="brand"><span class="brand-mark">R</span> Relaydesk</div><div class="workspace"><div class="work-dot">E</div><div><b>Elite Gold Signal</b><small>WhatsApp workspace</small></div></div>
    <div class="nav-title">WORKSPACE</div><nav class="nav"><button data-page="inbox" class="${state.page === 'inbox' ? 'active' : ''}">▤ &nbsp; <span class="nav-label">Inbox</span><span class="nav-count" id="navUnread">${state.overview.unread || ''}</span></button><button data-page="numbers" class="${state.page === 'numbers' ? 'active' : ''}">▦ &nbsp; <span class="nav-label">Numbers</span></button><button data-page="settings" class="${state.page === 'settings' ? 'active' : ''}">⚙ &nbsp; <span class="nav-label">Settings</span></button></nav>
    <div class="sidebottom"><div class="connection"><b><span class="connection-dot ${state.overview.whatsapp_configured ? 'connected' : ''}">●</span> ${state.overview.whatsapp_configured ? 'WhatsApp API ready' : 'WhatsApp not connected'}</b><p>${state.overview.numbers || 0} WhatsApp number(s) in this workspace.</p><button data-page="settings">Connection settings →</button></div><div class="profile"><div class="avatar">${esc(initials(admin))}</div><div><strong>${esc(admin)}</strong><small>Administrator</small></div><button id="logout" class="signout">Sign out</button></div></div></aside>${pageContent}</div>`;
  document.querySelectorAll('[data-page]').forEach(button => button.onclick = async () => { state.page = button.dataset.page; state.selected = null; await refresh(); });
  document.querySelector('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {}); loginView(); };
  if (state.page === 'inbox') wireInbox();
  if (state.page === 'settings' || state.page === 'numbers') document.querySelector('#syncNumbers').onclick = sync;
}

function conversationRows() {
  return state.conversations.map(row => `<button class="conv ${state.selected?.id === row.id ? 'selected' : ''}" data-conversation="${row.id}"><span class="avatar">${esc(avatarText(row))}</span><span class="conv-main"><span class="conv-top"><b>${esc(row.profile_name || `+${row.wa_id}`)}</b><time>${esc(listTime(row.last_message_at))}</time></span><span class="conv-preview">${esc(row.last_message_preview || 'No messages yet')}</span><span class="conv-number">via ${esc(numberLabel(row))}</span></span>${row.unread_count ? `<span class="unread">${row.unread_count}</span>` : ''}</button>`).join('')
    || `<div class="empty-list">${state.search || state.phone ? 'No matching conversations.' : 'No conversations yet. Once a WhatsApp Business number is connected, inbound messages appear here. You can also start one with an approved template.'}</div>`;
}

function inboxPage() {
  const selected = state.selected;
  const person = selected ? (selected.profile_name || `+${selected.wa_id}`) : '';
  const phoneOptions = state.numbers.length > 1 ? `<select class="select" id="phoneFilter" aria-label="Filter by number"><option value="">All numbers</option>${state.numbers.map(n => `<option value="${esc(n.phone_number_id)}" ${state.phone === n.phone_number_id ? 'selected' : ''}>${esc(numberLabel(n))}</option>`).join('')}</select>` : '';
  return `<section class="list-panel"><header class="list-head"><div class="list-head-row"><h1>Inbox</h1><button class="secondary small" id="newConversation">＋ New</button></div><p id="listSummary">${listSummary()}</p></header><div class="list-controls"><input class="search" id="search" placeholder="⌕  Search name, number or message" value="${esc(state.search)}">${phoneOptions}<div class="tabs">${['open', 'closed', 'all'].map(filter => `<button data-filter="${filter}" class="${state.filter === filter ? 'active' : ''}">${filter[0].toUpperCase() + filter.slice(1)}</button>`).join('')}</div></div><div class="conversation-list" id="conversationList">${conversationRows()}</div></section>
    <section class="chat-panel">${selected ? `<header class="chat-header"><button class="ghost mobile-menu" id="backToList" aria-label="Back">‹</button><div class="avatar">${esc(avatarText(selected))}</div><div class="chat-person"><b>${esc(person)}</b><small>+${esc(selected.wa_id)} · via ${esc(numberLabel(selected))}</small><small class="window ${selected.window_open ? 'open' : 'closed'}" id="windowState">${esc(windowText(selected))}</small></div><div class="chat-actions"><button class="ghost" id="toggleState">${selected.state === 'closed' ? 'Reopen' : 'Close'}</button></div></header><div class="messages" id="messages"><div class="loading">Loading messages…</div></div><div id="composerArea">${composer(selected)}</div>` : `<div class="chat-empty"><div class="empty-icon">◌</div><h2>Your shared inbox</h2><p>Select a conversation to reply, or start a new one with an approved template.</p></div>`}</section>`;
}

function listSummary() { return `${state.overview.open || 0} open conversation(s) · ${state.overview.numbers || 0} number(s)`; }

function composer(conversation) {
  if (!conversation.window_open) {
    return `<div class="composer closed-window"><p>WhatsApp only allows free-form replies within 24 hours of the customer's last message. Send an approved template to restart the conversation.</p><button class="primary" id="openTemplate">Send template</button></div>`;
  }
  return `<form class="composer" id="composer"><textarea id="messageText" rows="1" maxlength="4096" placeholder="Write a message…" title="Enter to send, Shift+Enter for a new line" required></textarea><button class="ghost" type="button" id="openTemplate" title="Send an approved template">Template</button><button class="primary" type="submit">Send</button></form><p class="composer-note">Sent through the official WhatsApp Business Cloud API.</p>`;
}

function settingsPage() {
  const webhook = `${location.origin}/webhooks/whatsapp`;
  const o = state.overview;
  return `<section class="settings-view"><h1>Settings</h1><p>Manage the administrator workspace and the official WhatsApp connection.</p><div class="section-card"><h2>WhatsApp Business Platform</h2><p>Connected through Meta Cloud API. This workspace never scans WhatsApp Web sessions.</p><div class="settings-row"><b>API connection</b><span class="value"><span class="pill ${o.whatsapp_configured ? 'good' : ''}">${o.whatsapp_configured ? 'Configured' : 'Not configured'}</span></span></div><div class="settings-row"><b>Webhook callback URL</b><span class="value"><code>${esc(webhook)}</code></span></div><div class="settings-row"><b>Webhook verification</b><span class="value"><span class="pill ${o.webhook_configured ? 'good' : ''}">${o.webhook_configured ? 'Configured' : 'Needs Meta credentials'}</span></span></div><div class="settings-row"><b>WABA phone numbers</b><span class="value">${o.numbers || 0}</span></div><p>Set the Meta app secret, webhook verify token, WABA ID, access token and Graph API version in the host's private environment settings, then sync numbers to import their Phone Number IDs.</p><button class="primary" id="syncNumbers">Sync numbers from Meta</button></div><div class="section-card"><h2>Administrator</h2><p>This release uses one administrator account configured on the server with <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code>.</p><div class="settings-row"><b>Signed in as</b><span class="value">${esc(state.email || 'Administrator')}</span></div></div><div class="notice">Keep Meta access tokens, app secrets and webhook verification tokens in server environment variables. Never put them in the browser, source files or chat.</div></section>`;
}

function numbersPage() {
  const rows = state.numbers.map(number => `<tr><td><b>${esc(number.display_phone_number || '—')}</b></td><td>${esc(number.verified_name || '—')}</td><td><code>${esc(number.phone_number_id)}</code></td><td><span class="pill ${number.quality_rating === 'GREEN' ? 'good' : ''}">${esc(number.quality_rating || '—')}</span></td><td>${esc(number.status || '')}</td><td>${number.open_conversations || 0}</td></tr>`).join('');
  return `<section class="number-list"><h1>WhatsApp numbers</h1><p>Numbers registered in the connected WhatsApp Business Account.</p><div class="section-card"><button class="primary" id="syncNumbers">Sync numbers from Meta</button>${state.numbers.length ? `<table class="numbers-table"><thead><tr><th>PHONE NUMBER</th><th>VERIFIED NAME</th><th>PHONE NUMBER ID</th><th>QUALITY</th><th>STATUS</th><th>OPEN CHATS</th></tr></thead><tbody>${rows}</tbody></table>` : `<p>No numbers imported yet. Configure Meta credentials in the private server environment, then sync the WABA number list.</p>`}</div><div class="notice">Meta decides which numbers can be attached to a WABA and each number's messaging limits. Numbers are never added by hand here: sync confirms them from Meta.</div></section>`;
}

function updateList() {
  const list = document.querySelector('#conversationList');
  if (!list) return;
  list.innerHTML = conversationRows();
  document.querySelector('#listSummary').textContent = listSummary();
  const unread = document.querySelector('#navUnread'); if (unread) unread.textContent = state.overview.unread || '';
  wireConversationRows();
  if (state.selected) {
    const node = document.querySelector('#windowState');
    if (node) { node.textContent = windowText(state.selected); node.className = `window ${state.selected.window_open ? 'open' : 'closed'}`; }
    // The window can open (customer replied) or close while the chat is open.
    const area = document.querySelector('#composerArea');
    const hasForm = Boolean(document.querySelector('#composer'));
    if (area && hasForm !== Boolean(state.selected.window_open)) { area.innerHTML = composer(state.selected); wireComposer(); }
  }
}

function wireConversationRows() {
  document.querySelectorAll('[data-conversation]').forEach(button => button.onclick = async () => {
    state.selected = state.conversations.find(row => row.id === Number(button.dataset.conversation));
    state.messages = [];
    renderShell();
    await loadMessages();
  });
}

function wireInbox() {
  const search = document.querySelector('#search');
  search.oninput = () => { clearTimeout(search._timer); search._timer = setTimeout(async () => { state.search = search.value; await loadConversations(); updateList(); }, 250); };
  const phoneFilter = document.querySelector('#phoneFilter');
  if (phoneFilter) phoneFilter.onchange = async () => { state.phone = phoneFilter.value; await loadConversations(); updateList(); };
  document.querySelectorAll('[data-filter]').forEach(button => button.onclick = async () => { state.filter = button.dataset.filter; await refresh(); });
  document.querySelector('#newConversation').onclick = () => templateModal(null);
  wireConversationRows();
  if (state.selected) {
    wireComposer();
    document.querySelector('#toggleState').onclick = async () => {
      const next = state.selected.state === 'closed' ? 'open' : 'closed';
      try { await api(`/api/conversations/${state.selected.id}/state`, { method: 'POST', body: JSON.stringify({ state: next }) }); state.selected.state = next; toast(`Conversation ${next === 'closed' ? 'closed' : 'reopened'}.`); await refresh(); }
      catch (error) { toast(error.message); }
    };
    document.querySelector('#backToList').onclick = () => { state.selected = null; renderShell(); };
  }
}

function wireComposer() {
  const templateButton = document.querySelector('#openTemplate');
  if (templateButton) templateButton.onclick = () => templateModal(state.selected);
  const form = document.querySelector('#composer');
  if (!form) return;
  const text = document.querySelector('#messageText');
  text.oninput = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 130)}px`; };
  text.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
  form.onsubmit = async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type=submit]'); const body = text.value.trim();
    if (!body || !state.selected) return;
    submit.disabled = true;
    try {
      await api(`/api/conversations/${state.selected.id}/messages`, { method: 'POST', body: JSON.stringify({ text: body }) });
      text.value = ''; text.style.height = '';
    } catch (error) {
      toast(error.message);
      if (error.code === 'window_closed') await refreshData();
    } finally {
      submit.disabled = false;
      await loadMessages({ forceScroll: true });
      await refreshData(); updateList();
      document.querySelector('#messageText')?.focus();
    }
  };
}

function mediaHtml(message) {
  if (!message.has_media) return '';
  const src = `/api/messages/${message.id}/media`;
  const mime = message.media_mime || '';
  if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) return `<a href="${src}" target="_blank" rel="noopener"><img class="media" src="${src}" alt="Image attachment" loading="lazy"></a>`;
  if (/^audio\//.test(mime)) return `<audio class="media" controls preload="none" src="${src}"></audio>`;
  if (/^video\//.test(mime)) return `<video class="media" controls preload="none" src="${src}"></video>`;
  return `<a class="attachment" href="${src}">📄 ${esc(message.media_filename || 'Download attachment')}</a>`;
}

function statusIcon(status) { return ({ sending: '◷ sending', sent: '✓ sent', delivered: '✓✓ delivered', read: '✓✓ read', failed: '⚠ failed' })[status] || status; }

function renderMessages({ forceScroll = false } = {}) {
  const node = document.querySelector('#messages'); if (!node) return;
  const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  let lastDay = '';
  node.innerHTML = state.messages.length ? state.messages.map(message => {
    const day = dayLabel(message.sent_at);
    const chip = day !== lastDay ? `<div class="date-chip">${esc(day)}</div>` : '';
    lastDay = day;
    const failed = message.status === 'failed';
    const kind = message.message_type === 'template' ? '<span class="tag">Template</span> ' : '';
    return `${chip}<div class="bubble ${message.direction} ${failed ? 'failed' : ''}">${mediaHtml(message)}${message.body ? `<div>${kind}${esc(message.body)}</div>` : ''}<div class="bubble-meta">${esc(clock(message.sent_at))}${message.direction === 'outbound' ? ` · ${esc(statusIcon(message.status))}` : ''}</div>${failed && (message.error_title || message.error_code) ? `<div class="bubble-error">${esc(message.error_title || '')}${message.error_code ? ` (code ${esc(message.error_code)})` : ''}</div>` : ''}</div>`;
  }).join('') : '<div class="empty-list">No messages yet.</div>';
  if (forceScroll || nearBottom) node.scrollTop = node.scrollHeight;
}

async function loadMessages({ forceScroll = true } = {}) {
  if (!state.selected) return;
  const id = state.selected.id;
  try {
    const { messages } = await api(`/api/conversations/${id}/messages`);
    if (state.selected?.id !== id) return;
    const changed = JSON.stringify(messages) !== JSON.stringify(state.messages);
    state.messages = messages;
    if (changed || forceScroll) renderMessages({ forceScroll });
    const row = state.conversations.find(item => item.id === id); if (row) row.unread_count = 0;
  } catch (error) { toast(error.message); }
}

async function ensureTemplates(fresh = false) {
  if (!state.templates || fresh) state.templates = (await api(`/api/templates${fresh ? '?refresh=1' : ''}`)).templates;
  return state.templates;
}

function closeModal() { document.querySelector('#modal')?.remove(); }

// conversation = null starts a new business-initiated conversation.
async function templateModal(conversation) {
  closeModal();
  const modal = document.createElement('div');
  modal.id = 'modal'; modal.className = 'modal-back';
  modal.innerHTML = '<div class="modal"><div class="loading">Loading approved templates…</div></div>';
  document.body.append(modal);
  modal.onclick = event => { if (event.target === modal) closeModal(); };
  let templates;
  try { templates = await ensureTemplates(); }
  catch (error) { modal.querySelector('.modal').innerHTML = `<h2>Templates unavailable</h2><p class="muted">${esc(error.message)}</p><div class="modal-foot"><button class="ghost" id="closeModal">Close</button></div>`; modal.querySelector('#closeModal').onclick = closeModal; return; }
  if (!conversation && !state.numbers.length) { try { state.numbers = (await api('/api/numbers')).numbers; } catch { /* shown below */ } }
  const usable = templates.filter(t => t.supported);
  const fromOptions = state.numbers.map(n => `<option value="${esc(n.phone_number_id)}">${esc(numberLabel(n))}${n.verified_name ? ` · ${esc(n.verified_name)}` : ''}</option>`).join('');
  modal.querySelector('.modal').innerHTML = `<form id="templateForm"><h2>${conversation ? `Send template to ${esc(conversation.profile_name || `+${conversation.wa_id}`)}` : 'New conversation'}</h2>
    ${conversation ? '' : `<div class="field"><label for="fromNumber">Send from</label><select id="fromNumber" required>${fromOptions || '<option value="">No synced numbers — sync from Meta first</option>'}</select></div><div class="field"><label for="toNumber">Customer WhatsApp number</label><input id="toNumber" inputmode="tel" placeholder="+44 7700 900123" required></div>`}
    <div class="field"><label for="templateSelect">Approved template</label><select id="templateSelect" required>${usable.map((t, i) => `<option value="${i}">${esc(t.name)} · ${esc(t.language)} · ${esc(t.category.toLowerCase())}</option>`).join('') || '<option value="">No approved templates available</option>'}</select>
    <button type="button" class="link" id="refreshTemplates">Refresh from Meta</button></div>
    <div id="templateVars"></div><div class="template-preview" id="templatePreview"></div>
    ${templates.length > usable.length ? `<p class="muted small">${templates.length - usable.length} approved template(s) hidden because they use media headers or dynamic buttons, which this composer does not support yet.</p>` : ''}
    <div class="error" id="templateError"></div><div class="modal-foot"><button class="ghost" type="button" id="closeModal">Cancel</button><button class="primary" type="submit" ${usable.length ? '' : 'disabled'}>Send template</button></div></form>`;
  const form = modal.querySelector('#templateForm');
  const select = form.querySelector('#templateSelect');
  const vars = form.querySelector('#templateVars');
  const previewNode = form.querySelector('#templatePreview');
  const current = () => usable[Number(select.value)];
  const values = sel => [...form.querySelectorAll(sel)].map(input => input.value.trim());
  const fill = (text, params) => text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[n - 1] || `{{${n}}}`);
  const preview = () => {
    const t = current(); if (!t) { previewNode.textContent = ''; return; }
    previewNode.textContent = [t.header_text && fill(t.header_text, values('[data-header]')), fill(t.body_text, values('[data-body]')), t.footer_text].filter(Boolean).join('\n\n');
  };
  const drawVars = () => {
    const t = current(); if (!t) { vars.innerHTML = ''; return; }
    vars.innerHTML = [...Array(t.header_params)].map((_, i) => `<div class="field"><label>Header {{${i + 1}}}</label><input data-header maxlength="60" required></div>`).join('')
      + [...Array(t.body_params)].map((_, i) => `<div class="field"><label>Body {{${i + 1}}}</label><input data-body maxlength="1024" required></div>`).join('');
    vars.querySelectorAll('input').forEach(input => input.oninput = preview);
    preview();
  };
  select.onchange = drawVars; drawVars();
  form.querySelector('#closeModal').onclick = closeModal;
  form.querySelector('#refreshTemplates').onclick = async () => { try { await ensureTemplates(true); templateModal(conversation); } catch (error) { toast(error.message); } };
  form.querySelector('#toNumber')?.focus();
  form.onsubmit = async event => {
    event.preventDefault();
    const t = current(); if (!t) return;
    const submit = form.querySelector('button[type=submit]'); submit.disabled = true;
    const template = { name: t.name, language: t.language, body_params: values('[data-body]'), header_params: values('[data-header]') };
    try {
      if (conversation) {
        await api(`/api/conversations/${conversation.id}/template`, { method: 'POST', body: JSON.stringify(template) });
        closeModal(); toast('Template sent.');
        await loadMessages({ forceScroll: true }); await refreshData(); updateList();
      } else {
        const result = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ phone_number_id: form.querySelector('#fromNumber').value, to: form.querySelector('#toNumber').value, template }) });
        closeModal(); toast('Conversation started.');
        state.filter = 'open'; state.search = ''; state.page = 'inbox';
        await refreshData();
        state.selected = state.conversations.find(row => row.id === result.conversation_id) || (await api(`/api/conversations/${result.conversation_id}`)).conversation;
        renderShell(); await loadMessages();
      }
    } catch (error) {
      form.querySelector('#templateError').textContent = error.message;
      submit.disabled = false;
      if (conversation) loadMessages({ forceScroll: true });
    }
  };
}

async function sync() {
  const buttons = [...document.querySelectorAll('#syncNumbers')]; buttons.forEach(button => button.disabled = true);
  try { const result = await api('/api/numbers/sync', { method: 'POST', body: '{}' }); state.templates = null; toast(`Synced ${result.synced} number(s) from Meta.`); await refresh(); }
  catch (error) { toast(error.message); }
  finally { buttons.forEach(button => button.disabled = false); }
}

async function loadConversations() {
  const params = new URLSearchParams({ state: state.filter, q: state.search, phone: state.phone });
  state.conversations = (await api(`/api/conversations?${params}`)).conversations;
  if (state.selected) {
    const fresh = state.conversations.find(row => row.id === state.selected.id);
    if (fresh) state.selected = fresh;
    else { try { state.selected = (await api(`/api/conversations/${state.selected.id}`)).conversation; } catch { /* keep current */ } }
  }
}
async function refreshData() {
  const [overview, numbers] = await Promise.all([api('/api/overview'), api('/api/numbers')]);
  state.overview = overview; state.numbers = numbers.numbers;
  await loadConversations();
}
async function refresh() {
  try { await refreshData(); renderShell(); if (state.selected) await loadMessages(); }
  catch (error) { if (error.status === 401) loginView(); else toast(error.message); }
}
async function poll() {
  if (document.hidden || state.page !== 'inbox') return;
  try { await refreshData(); updateList(); if (state.selected) await loadMessages({ forceScroll: false }); }
  catch (error) { if (error.status === 401) loginView(); /* otherwise a brief network blip; retry next tick */ }
}
async function boot() {
  const auth = await api('/api/auth/status');
  if (!auth.configured) { loginView('Administrator credentials are missing. Set ADMIN_EMAIL and ADMIN_PASSWORD in the server environment.'); return; }
  if (!auth.authenticated) { loginView(); return; }
  state.email = auth.email;
  await refresh();
  clearInterval(state.timer); state.timer = setInterval(poll, 8000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
boot().catch(error => { root.innerHTML = `<section class="login-wrap"><div class="login"><div class="brand"><span class="brand-mark">R</span> Relaydesk</div><h1>Could not load app</h1><p class="muted">${esc(error.message)}</p></div></section>`; });

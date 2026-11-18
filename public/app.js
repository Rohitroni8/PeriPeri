const root = document.querySelector('#root');
const toastNode = document.querySelector('#toast');
const state = { page: 'inbox', filter: 'open', conversations: [], selected: null, numbers: [], overview: {}, search: '', timer: null };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function toast(message) { toastNode.textContent = message; toastNode.classList.add('show'); clearTimeout(toastNode._timer); toastNode._timer = setTimeout(() => toastNode.classList.remove('show'), 3000); }
function esc(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function initials(value = '') { return String(value).trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'WA'; }
function clock(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(+date) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function dayLabel(value) { if (!value) return ''; const date = new Date(value); const today = new Date(); if (date.toDateString() === today.toDateString()) return 'Today'; const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1); return date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString([], { day: 'numeric', month: 'short' }); }

function loginView(error = '') {
  root.innerHTML = `<section class="login-wrap"><form class="login" id="loginForm"><div class="brand"><span class="brand-mark">R</span> Relaydesk</div><h1>Sign in to your inbox</h1><p class="muted">Your private WhatsApp Business workspace.</p><div class="field"><label for="email">Administrator email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><div class="error" id="loginError">${esc(error)}</div><button class="primary" type="submit">Sign in</button></form></section>`;
  document.querySelector('#loginForm').onsubmit = async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { const form = new FormData(event.currentTarget); await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }); await boot(); }
    catch (err) { document.querySelector('#loginError').textContent = err.message; button.disabled = false; }
  };
}

function appShell() {
  const admin = state.email || 'Administrator';
  const pageContent = state.page === 'settings' ? settingsPage() : state.page === 'numbers' ? numbersPage() : inboxPage();
  root.innerHTML = `<div class="shell ${state.selected && state.page === 'inbox' ? 'chat-open' : ''} ${state.page === 'settings' ? 'settings-open' : ''} ${state.page === 'numbers' ? 'numbers-open' : ''}">
    <aside class="sidebar"><div class="brand"><span class="brand-mark">R</span> Relaydesk</div><div class="workspace"><div class="work-dot">E</div><div><b>Elite Gold Signal</b><small>WhatsApp workspace</small></div></div>
    <div class="nav-title">WORKSPACE</div><nav class="nav"><button data-page="inbox" class="${state.page === 'inbox' ? 'active' : ''}">▤ &nbsp; <span class="nav-label">Inbox</span><span class="nav-count">${state.overview.unread || ''}</span></button><button data-page="numbers" class="${state.page === 'numbers' ? 'active' : ''}">▦ &nbsp; <span class="nav-label">Numbers</span></button><button data-page="settings" class="${state.page === 'settings' ? 'active' : ''}">⚙ &nbsp; <span class="nav-label">Settings</span></button></nav>
    <div class="sidebottom"><div class="connection"><b><span class="connection-dot ${state.overview.whatsapp_configured ? 'connected' : ''}">●</span> ${state.overview.whatsapp_configured ? 'WhatsApp API ready' : 'WhatsApp not connected'}</b><p>${state.overview.numbers || 0} WhatsApp numbers in this workspace.</p><button data-page="settings">Set up connection →</button></div><div class="profile"><div class="avatar">${esc(initials(admin))}</div><div><strong>${esc(admin)}</strong><small>Administrator</small></div><button id="logout" aria-label="Sign out">···</button></div></div></aside>${pageContent}</div>`;
  document.querySelectorAll('[data-page]').forEach(button => button.onclick = async () => { state.page = button.dataset.page; state.selected = null; await refresh(); });
  document.querySelector('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: '{}' }); clearInterval(state.timer); loginView(); };
  if (state.page === 'inbox') wireInbox();
  if (state.page === 'settings') wireSettings();
  if (state.page === 'numbers') wireNumbers();
}

function inboxPage() {
  const rows = state.conversations.map(row => `<button class="conv ${state.selected?.id === row.id ? 'selected' : ''}" data-conversation="${row.id}"><span class="avatar">${esc(initials(row.profile_name || row.wa_id))}</span><span class="conv-main"><span class="conv-top"><b>${esc(row.profile_name || row.wa_id)}</b><time>${esc(clock(row.last_message_at))}</time></span><span class="conv-preview">${esc(row.last_message_preview || 'No messages yet')}</span><span class="conv-number">via ${esc(row.display_phone_number || row.phone_number_id)}</span></span>${row.unread_count ? `<span class="unread">${row.unread_count}</span>` : ''}</button>`).join('');
  const selected = state.selected;
  const person = selected ? (selected.profile_name || selected.wa_id) : '';
  return `<section class="list-panel"><header class="list-head"><h1>Inbox</h1><p>${state.overview.open || 0} open conversations · ${state.overview.numbers || 0} connected numbers</p></header><div class="list-controls"><input class="search" id="search" placeholder="⌕  Search conversations" value="${esc(state.search)}"><div class="tabs">${['open', 'closed', 'all'].map(filter => `<button data-filter="${filter}" class="${state.filter === filter ? 'active' : ''}">${filter[0].toUpperCase() + filter.slice(1)}</button>`).join('')}</div></div><div class="conversation-list">${rows || `<div class="empty-list">${state.search ? 'No matching conversations.' : 'No conversations yet. Connect a WhatsApp Business number and inbound messages will appear here.'}</div>`}</div></section>
    <section class="chat-panel">${selected ? `<header class="chat-header"><button class="ghost mobile-menu" id="backToList">‹</button><div class="avatar">${esc(initials(person))}</div><div class="chat-person"><b>${esc(person)}</b><small>${esc(selected.wa_id)} · ${esc(selected.display_phone_number || selected.phone_number_id)}</small></div><div class="chat-actions"><button class="ghost" id="toggleState">${selected.state === 'closed' ? 'Reopen' : 'Close'} conversation</button></div></header><div class="messages" id="messages"><div class="loading">Loading messages…</div></div><form class="composer" id="composer"><textarea id="messageText" rows="1" maxlength="4096" placeholder="Write a message…" required></textarea><button class="primary" type="submit">Send</button></form><p class="composer-note">Messages are sent through the official WhatsApp Business Cloud API.</p>` : `<div class="chat-empty"><div class="empty-icon">◌</div><h2>Your shared inbox</h2><p>Select a conversation to reply, or connect your WhatsApp Business account to receive messages.</p></div>`}</section>`;
}

function settingsPage() {
  const webhook = `${location.origin}/webhooks/whatsapp`;
  return `<section class="settings-view"><h1>Settings</h1><p>Manage your first administrator workspace and official WhatsApp connection.</p><div class="section-card"><h2>WhatsApp Business Platform</h2><p>Connect through Meta Cloud API. This workspace does not scan WhatsApp Web sessions.</p><div class="settings-row"><b>API connection</b><span class="value"><span class="pill ${state.overview.whatsapp_configured ? 'good' : ''}">${state.overview.whatsapp_configured ? 'Configured' : 'Not configured'}</span></span></div><div class="settings-row"><b>Webhook callback</b><span class="value">${esc(webhook)}</span></div><div class="settings-row"><b>Webhook verification</b><span class="value"><span class="pill ${state.overview.webhook_configured ? 'good' : ''}">${state.overview.webhook_configured ? 'Configured' : 'Needs Meta credentials'}</span></span></div><div class="settings-row"><b>WABA phone numbers</b><span class="value">${state.overview.numbers || 0}</span></div><p>Set the Meta app secret, webhook verify token, WABA ID, access token, and Graph API version in your host’s private environment settings. Then use Sync numbers to import authorized phone number IDs.</p><button class="primary" id="syncNumbers">Sync numbers from Meta</button></div><div class="section-card"><h2>Administrator</h2><p>The initial release uses one administrator account configured on the server with <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code>. Use a unique password of at least 16 characters before exposing this app publicly.</p><div class="settings-row"><b>Signed in as</b><span class="value">${esc(state.email || 'Administrator')}</span></div></div><div class="notice">Keep Meta access tokens, app secrets, and webhook verification tokens in server environment variables. Never put them in the browser, source files, or chat.</div></section>`;
}

function numbersPage() {
  const rows = state.numbers.map(number => `<tr><td><b>${esc(number.display_phone_number || '—')}</b></td><td>${esc(number.verified_name || '—')}</td><td>${esc(number.phone_number_id)}</td><td><span class="pill ${number.quality_rating === 'GREEN' ? 'good' : ''}">${esc(number.quality_rating || number.status)}</span></td></tr>`).join('');
  return `<section class="number-list"><h1>WhatsApp numbers</h1><p>Numbers registered in the connected WhatsApp Business Account.</p><div class="section-card"><button class="primary" id="syncNumbers">Sync numbers from Meta</button>${state.numbers.length ? `<table class="numbers-table"><thead><tr><th>PHONE NUMBER</th><th>VERIFIED NAME</th><th>PHONE NUMBER ID</th><th>QUALITY</th></tr></thead><tbody>${rows}</tbody></table>` : `<p>No numbers imported. Configure Meta credentials in the private server environment, then sync the WABA number list.</p>`}</div><div class="notice">Meta decides which numbers can be attached to a WABA and the account’s messaging limits. The two numbers you shared are not added automatically.</div></section>`;
}

function wireInbox() {
  const search = document.querySelector('#search');
  search.oninput = () => { clearTimeout(search._timer); search._timer = setTimeout(async () => { state.search = search.value; await loadConversations(); appShell(); }, 250); };
  document.querySelectorAll('[data-filter]').forEach(button => button.onclick = async () => { state.filter = button.dataset.filter; await refresh(); });
  document.querySelectorAll('[data-conversation]').forEach(button => button.onclick = async () => { state.selected = state.conversations.find(row => row.id === Number(button.dataset.conversation)); appShell(); await loadMessages(); });
  const composer = document.querySelector('#composer');
  if (composer) {
    const text = document.querySelector('#messageText');
    text.oninput = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 130)}px`; };
    composer.onsubmit = async event => { event.preventDefault(); const submit = composer.querySelector('button'); const body = text.value.trim(); if (!body || !state.selected) return; submit.disabled = true; try { await api(`/api/conversations/${state.selected.id}/messages`, { method: 'POST', body: JSON.stringify({ text: body }) }); text.value = ''; await loadMessages(); await refreshData(); toast('Message sent.'); } catch (error) { toast(error.message); } finally { submit.disabled = false; text.focus(); } };
    text.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); } };
    document.querySelector('#toggleState').onclick = async () => { const next = state.selected.state === 'closed' ? 'open' : 'closed'; try { await api(`/api/conversations/${state.selected.id}/state`, { method: 'POST', body: JSON.stringify({ state: next }) }); state.selected.state = next; toast(`Conversation ${next}.`); await refresh(); } catch (error) { toast(error.message); } };
    document.querySelector('#backToList').onclick = () => { state.selected = null; appShell(); };
    loadMessages();
  }
}

async function loadMessages() {
  if (!state.selected) return;
  try {
    const { messages } = await api(`/api/conversations/${state.selected.id}/messages`);
    const node = document.querySelector('#messages'); if (!node) return;
    node.innerHTML = messages.length ? `<div class="date-chip">${esc(dayLabel(messages[0].sent_at))}</div>` + messages.map(message => `<div class="bubble ${message.direction}">${esc(message.body)}<div class="bubble-meta">${esc(clock(message.sent_at))}${message.direction === 'outbound' ? ` · ${esc(message.status)}` : ''}${message.error_code ? ` · Error ${esc(message.error_code)}` : ''}</div></div>`).join('') : '<div class="empty-list">No messages yet.</div>';
    node.scrollTop = node.scrollHeight;
    const row = state.conversations.find(item => item.id === state.selected.id); if (row) row.unread_count = 0;
  } catch (error) { toast(error.message); }
}

function wireSettings() { document.querySelector('#syncNumbers').onclick = sync; }
function wireNumbers() { document.querySelector('#syncNumbers').onclick = sync; }
async function sync() { const buttons = [...document.querySelectorAll('#syncNumbers')]; buttons.forEach(button => button.disabled = true); try { const result = await api('/api/numbers/sync', { method: 'POST', body: '{}' }); toast(`Synced ${result.synced} numbers from Meta.`); await refresh(); } catch (error) { toast(error.message); } finally { buttons.forEach(button => button.disabled = false); } }

async function loadConversations() { const params = new URLSearchParams({ state: state.filter, q: state.search }); const data = await api(`/api/conversations?${params}`); state.conversations = data.conversations; if (state.selected) state.selected = state.conversations.find(row => row.id === state.selected.id) || state.selected; }
async function refreshData() { const [overview] = await Promise.all([api('/api/overview')]); state.overview = overview; await loadConversations(); if (state.page === 'numbers') state.numbers = (await api('/api/numbers')).numbers; }
async function refresh() { try { await refreshData(); appShell(); } catch (error) { if (error.message === 'sign_in_required') loginView(); else toast(error.message); } }
async function boot() {
  const auth = await api('/api/auth/status');
  if (!auth.configured) { loginView('Administrator credentials are missing. Set ADMIN_EMAIL and ADMIN_PASSWORD in the server environment.'); return; }
  if (!auth.authenticated) { loginView(); return; }
  state.email = auth.email;
  await refresh();
  clearInterval(state.timer); state.timer = setInterval(async () => { if (state.page === 'inbox') { try { const selectedId = state.selected?.id; await refreshData(); appShell(); if (selectedId && state.selected) await loadMessages(); } catch { /* network may be briefly unavailable */ } } }, 10000);
}
boot().catch(error => { root.innerHTML = `<section class="login-wrap"><div class="login"><div class="brand"><span class="brand-mark">R</span> Relaydesk</div><h1>Could not load app</h1><p class="muted">${esc(error.message)}</p></div></section>`; });

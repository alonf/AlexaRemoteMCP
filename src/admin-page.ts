// The owner's catalog page: a static shell. It signs in through the server's own OAuth (PKCE) and
// calls the admin API with a bearer token, so it keeps no cookies and needs no CSRF protection.
const PAGE_SCRIPT = String.raw`
const CATEGORIES = ['light', 'cover', 'heater', 'ac', 'outlet', 'access', 'other'];
const GROUPS = ['low-risk', 'requires-approval', 'read-only'];
const PAGE = location.origin + '/admin/catalog';
const $ = (id) => document.getElementById(id);
let rows = [];
let sortKey = 'name';
let sortDir = 1;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const setStatus = (text, bad) => { $('status').textContent = text; $('status').className = bad ? 'bad' : 'muted'; };

async function discover() {
  const [meta, resource] = await Promise.all([
    fetch('/.well-known/openid-configuration').then((r) => r.json()),
    fetch('/.well-known/oauth-protected-resource').then((r) => r.json()),
  ]);
  return { meta, resource: resource.resource };
}

async function signIn() {
  const { meta, resource } = await discover();
  let clientId = localStorage.getItem('admin_client_id');
  if (!clientId) {
    const response = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Catalog admin page', redirect_uris: [PAGE], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
    });
    if (!response.ok) throw new Error('registration refused');
    clientId = (await response.json()).client_id;
    localStorage.setItem('admin_client_id', clientId);
  }
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem('admin_pkce', JSON.stringify({ verifier, state }));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: PAGE, response_type: 'code', scope: 'admin', resource, code_challenge: challenge, code_challenge_method: 'S256', state });
  location.assign(meta.authorization_endpoint + '?' + query);
}

async function finishSignIn(code, state) {
  const saved = JSON.parse(sessionStorage.getItem('admin_pkce') || '{}');
  sessionStorage.removeItem('admin_pkce');
  history.replaceState(null, '', PAGE);
  if (!saved.state || saved.state !== state) throw new Error('sign-in state mismatch');
  const { meta } = await discover();
  const response = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: PAGE, client_id: localStorage.getItem('admin_client_id') || '', code_verifier: saved.verifier }),
  });
  if (!response.ok) throw new Error('token request refused');
  const token = await response.json();
  sessionStorage.setItem('admin_token', JSON.stringify({ value: token.access_token, expires: Date.now() + (token.expires_in - 60) * 1000 }));
}

function token() {
  const saved = JSON.parse(sessionStorage.getItem('admin_token') || 'null');
  return saved && saved.expires > Date.now() ? saved.value : undefined;
}

async function api(method, path, body) {
  const bearer = token();
  if (!bearer) throw Object.assign(new Error('signed out'), { signedOut: true });
  const response = await fetch(path, { method, headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body });
  if (response.status === 401) { sessionStorage.removeItem('admin_token'); throw Object.assign(new Error('signed out'), { signedOut: true }); }
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
}

const fromEntry = (id, name, kind, caps, entry, flags) => ({
  id, name, kind, caps, inCatalog: !!entry,
  flags: flags || {},
  category: entry ? entry.category : 'other',
  group: entry ? entry.group || 'read-only' : 'read-only',
  disabled: !!(entry && entry.disabled),
  description: (entry && entry.description) || '',
  extra: entry ? { groupKind: entry.groupKind, members: entry.members } : {},
  operations: (entry && entry.operations) || {},
});

async function load() {
  setStatus('Loading devices...');
  const result = await api('GET', '/admin/api/devices');
  const data = result.body;
  rows = (data.devices || []).map((d) => fromEntry(d.id, d.name, d.kind, d.capabilities || [], d.catalog, { unsupported: d.supported === false, readOnly: d.writable === false }));
  for (const c of data.catalogOnly || []) rows.push(fromEntry(c.id, '(not in Alexa now) ' + c.id, '', [], c.catalog));
  if (data.status && data.status !== 'ok') setStatus('Alexa inventory unavailable (' + (data.health || data.reason || data.status) + '); showing the catalog only.', true);
  else setStatus('Loaded ' + rows.length + ' devices.');
  render();
}

const entryOf = (d) => {
  const e = { category: d.category, group: d.group };
  if (d.disabled) e.disabled = true;
  if (d.description.trim()) e.description = d.description.trim();
  if (d.extra.groupKind) e.groupKind = d.extra.groupKind;
  if (d.extra.members) e.members = d.extra.members;
  if (Object.keys(d.operations).length) e.operations = d.operations;
  return e;
};

const OPS = [['power_on', 'PowerController', 'on'], ['power_off', 'PowerController', 'off'], ['brightness', 'BrightnessController', 'brightness'], ['open', 'ModeController', 'open'], ['close', 'ModeController', 'close'], ['stop', 'ModeController', 'stop'], ['step', 'ModeController', 'step']];

function operationsCell(d, locked) {
  const cell = document.createElement('div');
  if (locked) return cell;
  for (const [op, cap, label] of OPS) {
    if (!d.caps.some((c) => String(c).includes(cap))) continue;
    const s = document.createElement('select');
    s.title = 'Override for ' + label + ': (default) follows the group';
    s.add(new Option(label + ': default', ''));
    for (const m of ['allow', 'approve', 'deny']) s.add(new Option(label + ': ' + m, m));
    s.value = d.operations[op] || '';
    s.onchange = () => { if (s.value) d.operations[op] = s.value; else delete d.operations[op]; changed(d); };
    cell.append(s);
  }
  return cell;
}

const timers = new Map();
function changed(d) {
  clearTimeout(timers.get(d.id));
  setStatus('Saving...');
  timers.set(d.id, setTimeout(async () => {
    try {
      const result = await api('PATCH', '/admin/api/catalog', JSON.stringify({ set: { [d.id]: entryOf(d) } }));
      if (result.ok) { d.inCatalog = true; setStatus('Saved (backed up before the change).'); renderCount(); }
      else setStatus('Not saved: ' + (result.body.reason || result.body.error || result.status) + (result.body.detail ? ' - ' + result.body.detail : ''), true);
    } catch (error) { fail(error); }
  }, 400));
}

function fail(error) {
  if (error && error.signedOut) showSignIn(); else setStatus('Error: ' + (error && error.message), true);
}

function showSignIn() {
  $('app').hidden = true;
  $('login').hidden = false;
}

function select(values, current, onchange) {
  const s = document.createElement('select');
  for (const v of values) s.add(new Option(v, v));
  s.value = current;
  s.onchange = () => onchange(s.value);
  return s;
}

function renderCount() {
  $('count').textContent = rows.length + ' devices, ' + rows.filter((r) => r.inCatalog).length + ' in the catalog, ' + rows.filter((r) => r.disabled || r.flags.unsupported).length + ' disabled';
}

const rowClass = (d) => (d.disabled || d.flags.unsupported ? 'off' : d.inCatalog ? d.group : 'new');

function heads() {
  const head = $('head');
  head.textContent = '';
  for (const [key, label] of [['name', 'Name'], ['kind', 'Alexa type'], ['category', 'Category'], ['group', 'Group']]) {
    const th = document.createElement('th');
    th.className = 'sortable';
    th.textContent = label + (sortKey === key ? (sortDir > 0 ? ' \u25B2' : ' \u25BC') : '');
    th.onclick = () => { sortDir = sortKey === key ? -sortDir : 1; sortKey = key; heads(); render(); };
    head.append(th);
  }
  for (const label of ['Disabled (hidden from AI)', 'Per-operation override', 'Note for the agent', '']) head.append(Object.assign(document.createElement('th'), { textContent: label }));
}

function render() {
  const q = $('q').value.toLowerCase();
  const body = $('rows');
  body.textContent = '';
  const sorted = [...rows].sort((a, b) => sortDir * String(a[sortKey]).localeCompare(String(b[sortKey])) || a.name.localeCompare(b.name));
  for (const d of sorted) {
    if (q && !(d.name + ' ' + d.id + ' ' + d.kind + ' ' + d.description).toLowerCase().includes(q)) continue;
    if ($('fc').value && d.category !== $('fc').value) continue;
    if ($('fg').value && d.group !== $('fg').value) continue;
    if ($('fn').checked && d.inCatalog) continue;
    if ($('fd').checked && !(d.disabled || d.flags.unsupported)) continue;
    const locked = d.flags.unsupported || d.flags.readOnly;
    const tr = body.insertRow();
    tr.className = rowClass(d);
    const nameCell = tr.insertCell();
    nameCell.textContent = d.name;
    if (d.flags.unsupported) nameCell.append(Object.assign(document.createElement('b'), { textContent: ' NOT SUPPORTED YET', className: 'tag' }));
    else if (d.disabled) nameCell.append(Object.assign(document.createElement('b'), { textContent: ' DISABLED', className: 'tag' }));
    else if (d.flags.readOnly) nameCell.append(Object.assign(document.createElement('b'), { textContent: ' READ ONLY', className: 'tag2' }));
    tr.insertCell().textContent = d.kind;
    const category = select(CATEGORIES, d.category, (v) => { d.category = v; changed(d); });
    const group = select(GROUPS, locked ? 'read-only' : d.group, (v) => { d.group = v; tr.className = rowClass(d); changed(d); });
    category.disabled = locked;
    group.disabled = locked;
    tr.insertCell().append(category);
    tr.insertCell().append(group);
    const off = document.createElement('input');
    off.type = 'checkbox';
    off.checked = d.disabled || !!d.flags.unsupported;
    off.disabled = !!d.flags.unsupported;
    off.title = d.flags.unsupported ? 'No MCP tool supports this device type yet, so it is always hidden from agents.' : '';
    off.onchange = () => { d.disabled = off.checked; render(); changed(d); };
    tr.insertCell().append(off);
    tr.insertCell().append(operationsCell(d, locked || d.disabled));
    const note = document.createElement('input');
    note.type = 'text';
    note.maxLength = 300;
    note.value = d.description;
    note.onchange = () => { d.description = note.value; changed(d); };
    tr.insertCell().append(note);
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.disabled = !d.inCatalog;
    remove.onclick = async () => {
      try {
        const result = await api('PATCH', '/admin/api/catalog', JSON.stringify({ remove: [d.id] }));
        if (result.ok) { Object.assign(d, fromEntry(d.id, d.name, d.kind, d.caps, undefined, d.flags)); setStatus('Removed.'); render(); }
        else setStatus('Not removed: ' + (result.body.reason || result.status), true);
      } catch (error) { fail(error); }
    };
    tr.insertCell().append(remove);
  }
  renderCount();
}

$('signin').onclick = () => signIn().catch((error) => setStatus('Sign-in failed: ' + error.message, true));
for (const id of ['q', 'fc', 'fg', 'fn', 'fd']) $(id).oninput = render;
for (const c of CATEGORIES) $('fc').add(new Option(c, c));
for (const g of GROUPS) $('fg').add(new Option(g, g));

$('download').onclick = () => {
  const devices = {};
  for (const d of rows) if (d.inCatalog) devices[d.id] = entryOf(d);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, devices }, null, 2)], { type: 'application/json' }));
  a.download = 'device-catalog.json';
  a.click();
};

$('import').onchange = async () => {
  const file = $('import').files[0];
  $('import').value = '';
  if (!file || !confirm('Replace the whole catalog with this file? The current catalog is backed up first.')) return;
  try {
    const result = await api('PUT', '/admin/api/catalog', await file.text());
    if (!result.ok) { setStatus('Import refused: ' + (result.body.detail || result.body.reason || result.status), true); return; }
    await load();
    setStatus('Imported ' + result.body.count + ' devices.');
  } catch (error) { fail(error); }
};

(async () => {
  heads();
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('error')) { setStatus('Sign-in was not completed: ' + params.get('error'), true); history.replaceState(null, '', PAGE); showSignIn(); return; }
    if (params.get('code')) await finishSignIn(params.get('code'), params.get('state'));
    if (!token()) { showSignIn(); return; }
    $('login').hidden = true;
    $('app').hidden = false;
    await load();
  } catch (error) { fail(error); }
})();
`;

const PAGE_STYLE = `
body{font:14px system-ui,sans-serif;margin:16px;color:#222}
header{display:flex;gap:8px;flex-wrap:wrap;align-items:center;position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #ddd}
table{border-collapse:collapse;width:100%;margin-top:8px}
th,td{border-bottom:1px solid #eee;padding:3px 6px;text-align:left;vertical-align:middle}
th{background:#f6f6f6}th.sortable{cursor:pointer}
input[type=text]{width:100%;box-sizing:border-box}#q{max-width:260px}
.low-risk{background:#e6f6e6}.requires-approval{background:#fff3d6}.read-only{background:#f0f0f0}.new{background:#fff}
.muted{color:#777}.bad{color:#b00020}
.off{background:#d9d9d9;color:#666}.off td:first-child{text-decoration:line-through}.tag{color:#b00020;text-decoration:none;display:inline-block}.tag2{color:#555;display:inline-block}
`;

export function adminPage(nonce: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Device catalog</title>
<style nonce="${nonce}">${PAGE_STYLE}</style>
<h2>Device catalog <span class="muted" id="count"></span></h2>
<p id="status" class="muted"></p>
<div id="login" hidden><p>Sign in as the owner to manage the device catalog.</p><button id="signin">Sign in</button></div>
<div id="app" hidden>
<header>
  <input id="q" type="text" placeholder="Search name, id, type or note">
  <select id="fc"><option value="">All categories</option></select>
  <select id="fg"><option value="">All groups</option></select>
  <label><input type="checkbox" id="fn"> Only devices not in the catalog</label>
  <label><input type="checkbox" id="fd"> Only disabled</label>
  <button id="download">Download catalog</button>
  <label>Import <input type="file" id="import" accept="application/json"></label>
  <span class="muted">Every change saves immediately; the previous state is backed up first.</span>
</header>
<table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table>
</div>
<script nonce="${nonce}">${PAGE_SCRIPT}</script>
`;
}

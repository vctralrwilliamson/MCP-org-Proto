const $ = (sel) => document.querySelector(sel);

async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error(data.error || 'Sign in first.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const daysLeft = (iso) => Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 86400000));

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
}

// --- session ---

let tester = null;

function setTester(name) {
  tester = name;
  $('#who').textContent = name || '';
  $('#logout').hidden = !name;
}

let authMode = 'invite';

function showLogin() {
  setTester(null);
  $('#sso').hidden = authMode !== 'oidc';
  $('#invite-intro').hidden = $('#login-form').hidden = authMode !== 'invite';
  show('login');
}

// The OAuth callback redirects back with ?auth_error=… when sign-in is refused.
const authError = new URLSearchParams(location.search).get('auth_error');
if (authError) {
  $('#login-error').textContent = authError;
  history.replaceState(null, '', location.pathname + location.hash);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#login-error').textContent = '';
  try {
    const { tester } = await api('/login', { method: 'POST', body: { name: f.name.value, code: f.code.value } });
    setTester(tester);
    f.reset();
    route();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  location.hash = '#/';
  showLogin();
});

// --- instance list ---

async function renderList() {
  show('list');
  $('#list-error').textContent = '';
  const { instances } = await api('/instances');
  const ul = $('#instances');
  ul.replaceChildren(
    ...instances.map((i) =>
      el(
        'li',
        {},
        el(
          'div',
          { class: 'main' },
          el('a', { class: 'title', href: `#/i/${i.id}` }, i.name),
          el('div', { class: 'sub' }, `${i.documents.length} document(s) · expires in ${daysLeft(i.expiresAt)} day(s)`)
        ),
        el('a', { href: `#/i/${i.id}` }, 'Open')
      )
    )
  );
  $('#instances-empty').hidden = instances.length > 0;
}

$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const { instance } = await api('/instances', { method: 'POST', body: { name: e.target.name.value } });
    e.target.reset();
    location.hash = `#/i/${instance.id}`;
  } catch (err) {
    $('#list-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// --- single instance ---

let current = null;

function renderDocs() {
  const ul = $('#docs');
  ul.replaceChildren(
    ...current.documents.map((d) =>
      el(
        'li',
        {},
        el(
          'div',
          { class: 'main' },
          el('div', { class: 'title' }, d.title),
          el('div', { class: 'sub' }, `${d.kind} · ${d.chunks} chunk(s) · ${fmtDate(d.uploadedAt)}`)
        ),
        el('button', { class: 'link', onclick: () => removeDoc(d) }, 'Remove')
      )
    )
  );
  $('#docs-empty').hidden = current.documents.length > 0;
}

async function renderInstance(id) {
  show('instance');
  const { instance } = await api(`/instances/${id}`);
  current = instance;
  $('#inst-name').textContent = instance.name;
  $('#inst-meta').textContent = `Created ${fmtDate(instance.createdAt)} · expires ${fmtDate(instance.expiresAt)} (${daysLeft(instance.expiresAt)} days)`;
  $('#messages').replaceChildren();
  $('#upload-status').textContent = '';
  renderDocs();
}

async function removeDoc(doc) {
  if (!confirm(`Remove "${doc.title}" from this instance?`)) return;
  try {
    const { instance } = await api(`/instances/${current.id}/documents/${doc.id}`, { method: 'DELETE' });
    current = instance;
    renderDocs();
  } catch (err) {
    setStatus(err.message, 'bad');
  }
}

$('#inst-delete').addEventListener('click', async () => {
  if (!confirm(`Delete "${current.name}" and all of its documents? This can't be undone.`)) return;
  try {
    await api(`/instances/${current.id}`, { method: 'DELETE' });
    location.hash = '#/';
  } catch (err) {
    alert(err.message);
  }
});

function setStatus(text, kind = '') {
  const s = $('#upload-status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

const fileInput = $('#upload-form input[type=file]');
const drop = $('#drop');
fileInput.addEventListener('change', () => {
  const n = fileInput.files.length;
  drop.querySelector('span').textContent = n ? `${n} file(s) selected` : 'Tap to choose .docx, .xlsx or .txt files';
});
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileInput.files = e.dataTransfer.files;
  fileInput.dispatchEvent(new Event('change'));
});

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fileInput.files.length) return setStatus('Choose at least one file.', 'bad');
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  setStatus('Extracting and embedding… larger files can take a minute.');
  try {
    const { results, instance } = await api(`/instances/${current.id}/documents`, {
      method: 'POST',
      form: new FormData(e.target),
    });
    current = instance;
    renderDocs();
    const failed = results.filter((r) => r.error);
    const ok = results.length - failed.length;
    setStatus(
      [ok && `Indexed ${ok} file(s).`, ...failed.map((f) => `${f.title}: ${f.error}`)].filter(Boolean).join(' '),
      failed.length ? 'bad' : 'ok'
    );
    e.target.reset();
    fileInput.dispatchEvent(new Event('change'));
  } catch (err) {
    setStatus(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

function addAnswer(question, { answer, sources = [] }) {
  const node = $('#tpl-answer').content.firstElementChild.cloneNode(true);
  node.querySelector('.body').textContent = answer;
  node.querySelector('.sources').replaceChildren(
    ...sources.map((s) => el('li', {}, `${s.title} (${s.score.toFixed(2)})`))
  );
  const flagForm = node.querySelector('.flag-form');
  node.querySelector('.flag').addEventListener('click', () => {
    flagForm.hidden = false;
    flagForm.note.focus();
  });
  flagForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/instances/${current.id}/feedback`, {
        method: 'POST',
        body: { question, answer, note: flagForm.note.value },
      });
      node.querySelector('.actions').replaceChildren(el('span', { class: 'thanks' }, 'Thanks — flagged for review.'));
      flagForm.remove();
    } catch (err) {
      alert(err.message);
    }
  });
  return node;
}

$('#ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const question = f.question.value.trim();
  if (!question) return;
  const box = $('#messages');
  box.append(el('div', { class: 'msg me' }, question));
  const pending = el('div', { class: 'msg bot pending' }, 'Thinking…');
  box.append(pending);
  box.scrollTop = box.scrollHeight;
  f.reset();
  f.querySelector('button').disabled = true;
  try {
    const result = await api(`/instances/${current.id}/ask`, { method: 'POST', body: { question } });
    pending.replaceWith(addAnswer(question, result));
  } catch (err) {
    pending.textContent = err.message;
    pending.classList.remove('pending');
  } finally {
    f.querySelector('button').disabled = false;
    box.scrollTop = box.scrollHeight;
  }
});

// --- routing ---

async function route() {
  if (!tester) return showLogin();
  const m = location.hash.match(/^#\/i\/([a-f0-9]+)$/);
  try {
    if (m) await renderInstance(m[1]);
    else await renderList();
  } catch (err) {
    if (tester) {
      location.hash = '#/';
      $('#list-error').textContent = err.message;
    }
  }
}

window.addEventListener('hashchange', route);

api('/me')
  .then(({ tester, authMode: mode }) => {
    authMode = mode;
    setTester(tester);
    route();
  })
  .catch(showLogin);

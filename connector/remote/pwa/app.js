// Cockpit Remote: the phone side of Remote Access. Plain JS (no build step) served by the
// laptop's Remote listener. All text from the API goes into the DOM as textContent, never HTML.

const DEVICE_KEY = 'tlc.remote.device';
const app = document.getElementById('app');

const state = {
  /** @type {{deviceId: string, secret: string, deviceName: string} | null} */
  device: null,
  /** @type {{token: string, expiresAt: number, remoteExpiresAt: number} | null} */
  session: null,
  tab: 'projects',
  data: { projects: null, agents: null, mrs: null, e2e: null },
  errors: {},
  loading: false,
  refreshTimer: 0,
  clockTimer: 0,
};

// ---------- helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function render(...nodes) {
  app.replaceChildren(...nodes);
}

function loadDevice() {
  try {
    const d = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
    return d && typeof d.deviceId === 'string' && typeof d.secret === 'string' ? d : null;
  } catch {
    return null;
  }
}

function saveDevice(d) {
  try {
    if (d) localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* private mode: pairing lasts for this tab only */
  }
  state.device = d;
}

function remaining(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} mnt`;
  return `${Math.floor(min / 60)} j ${min % 60} mnt`;
}

const fmtDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function rawFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new ApiError('Laptop tidak bisa dihubungi.', 0, 'offline');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError((body && body.error) || `HTTP ${res.status}`, res.status, (body && body.code) || 'error');
  return body;
}

async function openSession() {
  if (!state.device) throw new ApiError('Belum dipasangkan.', 401, 'unpaired');
  try {
    const s = await rawFetch('/m/api/session', { method: 'POST', body: { deviceId: state.device.deviceId, secret: state.device.secret } });
    state.session = { token: s.token, expiresAt: Date.parse(s.expiresAt), remoteExpiresAt: Date.parse(s.remoteExpiresAt) };
    scheduleRefresh();
  } catch (e) {
    if (e.code === 'revoked') saveDevice(null);
    throw e;
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (!state.session) return;
  const left = state.session.expiresAt - Date.now();
  // Renew at ~80% of the token's life, while the app is open.
  state.refreshTimer = setTimeout(() => {
    if (document.visibilityState === 'visible') openSession().catch(handleFatal);
  }, Math.max(5_000, left * 0.8));
}

async function api(path, opts = {}) {
  if (!state.session || Date.now() >= state.session.expiresAt) await openSession();
  try {
    return await rawFetch(path, { ...opts, token: state.session.token });
  } catch (e) {
    if (e.status !== 401) throw e;
    state.session = null;
    await openSession();
    return rawFetch(path, { ...opts, token: state.session.token });
  }
}

/** Errors that mean "nothing to show here": inactive Remote or a lost pairing. */
function handleFatal(e) {
  if (e.code === 'offline' || e.code === 'inactive' || e.status === 503) return showInactive();
  if (e.code === 'revoked' || e.code === 'unpaired' || !state.device) return showPair(e.code === 'revoked' ? 'Perangkat ini sudah dicabut dari laptop. Pasangkan ulang.' : undefined);
  showError(e.message);
}

// ---------- screens ----------

function showInactive() {
  state.session = null;
  clearInterval(state.clockTimer);
  render(
    h(
      'section',
      { class: 'screen center' },
      h('div', { class: 'badge off', text: 'Nonaktif' }),
      h('h1', { text: 'Remote Cockpit sedang nonaktif' }),
      h('p', { class: 'muted', text: 'Aktifkan Remote dari laptop (Cockpit → Remote, dengan PIN/Touch ID), pastikan Tailscale di HP ini tersambung, lalu coba lagi.' }),
      h('button', { class: 'btn primary', onclick: () => start() }, 'Coba lagi'),
    ),
  );
}

function showError(message) {
  render(h('section', { class: 'screen center' }, h('h1', { text: 'Terjadi kesalahan' }), h('p', { class: 'muted', text: message }), h('button', { class: 'btn primary', onclick: () => start() }, 'Coba lagi')));
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'HP';
}

function showPair(notice) {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('pair') || '';
  const code = h('input', { class: 'input code', id: 'code', inputmode: 'text', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', maxlength: '12', placeholder: 'XXXX-XXXX', value: fromHash });
  const name = h('input', { class: 'input', id: 'name', maxlength: '40', value: guessDeviceName() });
  const msg = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Pasangkan');
  const form = h(
    'form',
    {
      class: 'screen',
      onsubmit: async (ev) => {
        ev.preventDefault();
        msg.textContent = '';
        btn.disabled = true;
        try {
          const r = await rawFetch('/m/api/pair', { method: 'POST', body: { code: code.value, name: name.value } });
          saveDevice({ deviceId: r.deviceId, secret: r.secret, deviceName: r.deviceName });
          history.replaceState(null, '', '/m/');
          await start();
        } catch (e) {
          if (e.code === 'offline' || e.code === 'inactive') return showInactive();
          msg.textContent = e.message;
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('h1', { text: 'Pasangkan HP ini' }),
    notice ? h('p', { class: 'warn', text: notice }) : null,
    h('p', { class: 'muted', text: 'Di laptop: Cockpit → Remote → "Pasangkan perangkat". Pindai QR-nya, atau ketik kode 8 karakter di bawah. Kode berlaku 2 menit dan hanya sekali pakai.' }),
    h('label', { for: 'code', text: 'Kode pairing' }),
    code,
    h('label', { for: 'name', text: 'Nama perangkat' }),
    name,
    msg,
    btn,
    h('p', { class: 'muted small', text: 'iPhone: setelah tersambung, Share → Add to Home Screen. Bila aplikasi di Home Screen meminta pairing lagi, buat kode baru di laptop dan ketik di sana.' }),
  );
  render(form);
  if (!fromHash) code.focus();
}

function header() {
  const left = state.session ? state.session.remoteExpiresAt - Date.now() : 0;
  return h(
    'header',
    { class: 'top' },
    h('div', {}, h('div', { class: 'title', text: 'Cockpit Remote' }), h('div', { class: 'muted small', id: 'clock', text: `Aktif · sisa ${remaining(left)}${state.device ? ` · ${state.device.deviceName}` : ''}` })),
    h('div', { class: 'top-actions' }, h('button', { class: 'btn ghost', 'aria-label': 'Muat ulang', onclick: () => loadTab(true) }, '↻'), h('button', { class: 'btn danger', onclick: disableRemote }, 'Matikan')),
  );
}

const TABS = [
  ['projects', 'Proyek'],
  ['agents', 'Agent'],
  ['mrs', 'MR'],
  ['e2e', 'E2E'],
];

function tabBar() {
  return h(
    'nav',
    { class: 'tabs', role: 'tablist' },
    TABS.map(([id, label]) =>
      h('button', { role: 'tab', class: state.tab === id ? 'tab active' : 'tab', 'aria-selected': state.tab === id ? 'true' : 'false', onclick: () => ((state.tab = id), showMain(), loadTab(false)) }, label),
    ),
  );
}

function showMain() {
  render(header(), tabBar(), h('section', { class: 'content', id: 'content' }, renderTab()));
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(() => {
    const el = document.getElementById('clock');
    if (!el || !state.session) return;
    const left = state.session.remoteExpiresAt - Date.now();
    if (left <= 0) return showInactive();
    el.textContent = `Aktif · sisa ${remaining(left)}${state.device ? ` · ${state.device.deviceName}` : ''}`;
  }, 30_000);
}

function refreshContent() {
  const c = document.getElementById('content');
  if (c) c.replaceChildren(renderTab());
}

function renderTab() {
  const key = state.tab;
  const data = state.data[key];
  if (state.errors[key]) return h('p', { class: 'err', text: state.errors[key] });
  if (!data) return h('p', { class: 'muted center', text: 'Memuat…' });
  if (key === 'projects') return renderProjects(data);
  if (key === 'agents') return renderAgents(data);
  if (key === 'mrs') return renderMrs(data);
  return renderE2E(data);
}

function bar(percent) {
  const fill = h('span', { class: 'fill' });
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(percent), 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
}

function renderProjects(projects) {
  if (!projects.length) return h('p', { class: 'muted center', text: 'Belum ada proyek. Buat proyek di laptop (menu Proyek).' });
  const errs = [...new Set(projects.flatMap((p) => p.errors || []))];
  return h(
    'div',
    { class: 'list' },
    errs.map((e) => h('p', { class: 'warn small', text: e })),
    projects.map((p) =>
      h(
        'article',
        { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: p.name }), h('strong', { class: 'pct', text: `${p.devPercent}%` })),
        bar(p.devPercent),
        h(
          'div',
          { class: 'meta' },
          h('span', { text: `Target: ${fmtDate(p.targetDate)}${p.targetDate && !p.targetComplete ? ' (estimasi belum lengkap)' : ''}` }),
          p.livePercent !== p.devPercent ? h('span', { class: 'muted', text: `live ${p.livePercent}%` }) : null,
        ),
        h(
          'div',
          { class: 'chips' },
          h('span', { class: 'chip ok', text: `Selesai ${p.stages.merged}` }),
          h('span', { class: 'chip review', text: `Review ${p.stages.review}` }),
          h('span', { class: 'chip prog', text: `Coding ${p.stages.inProgress}` }),
          h('span', { class: 'chip', text: `To Do ${p.stages.todo}` }),
        ),
        p.attention.length
          ? h(
              'details',
              { class: 'attention' },
              h('summary', { text: `⚠️ ${p.attention.length} task perlu perhatian` }),
              h(
                'ul',
                {},
                p.attention.map((a) => h('li', {}, h('div', { class: 'task', text: a.task }), h('div', { class: 'muted small', text: `${a.jiraKeys.join(', ') || 'Tanpa Jira'} · ${a.flags.join('; ')}` }))),
              ),
            )
          : h('p', { class: 'muted small', text: 'Tidak ada task yang perlu perhatian.' }),
        h('button', { class: 'btn', onclick: () => draftReport(p) }, 'Draft Progress Report'),
      ),
    ),
  );
}

const STATUS_LABEL = { pending: 'Menunggu', queued: 'Antre', running: 'Berjalan', blocked: 'Butuh tindakan', completed: 'Selesai', failed: 'Gagal', cancelled: 'Dibatalkan' };

function renderAgents({ counts, tasks }) {
  return h(
    'div',
    { class: 'list' },
    h(
      'div',
      { class: 'chips' },
      Object.entries(counts).map(([s, n]) => h('span', { class: `chip st-${s}`, text: `${STATUS_LABEL[s] || s} ${n}` })),
    ),
    tasks.length
      ? tasks.map((t) =>
          h(
            'article',
            { class: 'card compact' },
            h('div', { class: 'row' }, h('div', { class: 'task', text: t.title }), h('span', { class: `chip st-${t.status}`, text: STATUS_LABEL[t.status] || t.status })),
            t.progress && !['failed', 'completed', 'cancelled'].includes(t.status) ? h('div', { class: 'muted small', text: t.progress }) : null,
            t.error ? h('div', { class: 'err small', text: t.error }) : null,
            h('div', { class: 'muted small', text: fmtTime(t.updatedAt) }),
          ),
        )
      : h('p', { class: 'muted center', text: 'Belum ada agent task.' }),
  );
}

function renderMrs(mrs) {
  if (!mrs.length) return h('p', { class: 'muted center', text: 'Tidak ada MR terbuka.' });
  return h(
    'div',
    { class: 'list' },
    mrs.map((m) =>
      h(
        'a',
        { class: 'card compact link', href: m.webUrl, target: '_blank', rel: 'noopener noreferrer' },
        h('div', { class: 'task', text: `${m.draft ? '[Draft] ' : ''}${m.title}` }),
        h('div', { class: 'muted small', text: `${m.ref} · ${m.author} · ${fmtTime(m.updatedAt)}` }),
        h(
          'div',
          { class: 'chips' },
          m.hasConflicts ? h('span', { class: 'chip bad', text: 'Konflik' }) : null,
          m.pipelineStatus ? h('span', { class: `chip pipe-${m.pipelineStatus}`, text: `Pipeline ${m.pipelineStatus}` }) : null,
        ),
      ),
    ),
  );
}

function renderE2E(runs) {
  if (!runs.length) return h('p', { class: 'muted center', text: 'Belum ada run E2E.' });
  return h(
    'div',
    { class: 'list' },
    runs.map((r) =>
      h(
        'article',
        { class: 'card compact' },
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'task', text: r.projectName }),
          h('span', { class: `chip ${r.status === 'running' ? 'prog' : r.failedFlows ? 'bad' : 'ok'}`, text: r.status === 'running' ? 'Berjalan' : r.failedFlows ? `${r.failedFlows} gagal` : 'Lulus' }),
        ),
        h('div', { class: 'muted small', text: `${r.passedFlows}/${r.flows} flow lulus · ${r.environment} · ${fmtTime(r.finishedAt || r.startedAt)}` }),
      ),
    ),
  );
}

// ---------- actions ----------

const ENDPOINT = { projects: '/m/api/projects', agents: '/m/api/agent-tasks', mrs: '/m/api/mrs', e2e: '/m/api/e2e' };

async function loadTab(force) {
  const key = state.tab;
  if (state.data[key] && !force) return;
  state.errors[key] = '';
  if (force) {
    state.data[key] = null;
    refreshContent();
  }
  try {
    state.data[key] = await api(ENDPOINT[key]);
  } catch (e) {
    if (e.code === 'offline' || e.code === 'inactive' || e.code === 'revoked' || e.code === 'unpaired') return handleFatal(e);
    state.errors[key] = e.message;
  }
  if (state.tab === key) refreshContent();
}

function sheet(...children) {
  const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && overlay.remove() }, h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, ...children));
  document.body.append(overlay);
  return overlay;
}

async function draftReport(project) {
  const body = h('div', { class: 'sheet-body' }, h('p', { class: 'muted', text: 'Menyusun draft…' }));
  const overlay = sheet(h('h2', { text: `Progress Report · ${project.name}` }), body);
  let draft;
  try {
    draft = await api('/m/api/report/draft', { method: 'POST', body: { projectId: project.id } });
  } catch (e) {
    body.replaceChildren(h('p', { class: 'err', text: e.message }), h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Tutup'));
    return;
  }
  const msg = h('p', { class: 'err', role: 'alert' });
  const send = h(
    'button',
    {
      class: 'btn primary',
      disabled: !draft.target,
      onclick: async () => {
        // Second confirmation, on the phone, right before anything leaves the laptop.
        if (!confirm(`Kirim Progress Report "${project.name}" ke grup WhatsApp "${draft.target}"?`)) return;
        send.disabled = true;
        msg.textContent = '';
        try {
          const r = await api('/m/api/report/send', { method: 'POST', body: { draftId: draft.draftId, confirm: true } });
          body.replaceChildren(h('p', { class: 'ok', text: `Terkirim ke ${r.target}.` }), h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Tutup'));
        } catch (e) {
          msg.textContent = e.message;
          send.disabled = false;
        }
      },
    },
    draft.target ? `Kirim ke ${draft.target}` : 'Grup tujuan belum diatur',
  );
  body.replaceChildren(
    draft.target ? h('p', { class: 'muted small', text: `Tujuan: grup WhatsApp "${draft.target}". Draft berlaku 10 menit.` }) : h('p', { class: 'warn small', text: 'Grup WhatsApp tujuan untuk proyek ini belum diatur. Atur di laptop: Remote → Tujuan laporan.' }),
    h('pre', { class: 'report', text: draft.text }),
    msg,
    h('div', { class: 'row gap' }, h('button', { class: 'btn ghost', onclick: () => overlay.remove() }, 'Batal'), send),
  );
}

async function disableRemote() {
  if (!confirm('Matikan Remote Cockpit sekarang? Akses dari HP ditutup sampai diaktifkan lagi dari laptop.')) return;
  try {
    await api('/m/api/remote/disable', { method: 'POST', body: { confirm: true } });
  } catch (e) {
    if (e.code !== 'offline') return alert(e.message);
  }
  showInactive();
}

async function start() {
  state.device = loadDevice();
  state.data = { projects: null, agents: null, mrs: null, e2e: null };
  state.errors = {};
  if (!state.device) {
    // Not paired yet: check the laptop is reachable first, so an inactive Remote says so.
    try {
      await rawFetch('/m/api/status');
    } catch (e) {
      if (e.code === 'offline' || e.code === 'inactive') return showInactive();
    }
    return showPair();
  }
  try {
    await openSession();
  } catch (e) {
    return handleFatal(e);
  }
  showMain();
  loadTab(true);
}

// A QR scanned while the app is already open only changes the hash.
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).get('pair')) showPair();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.device) return;
  if (!state.session || Date.now() >= state.session.expiresAt - 30_000) openSession().then(() => showMain(), handleFatal);
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(() => {});
}

start();

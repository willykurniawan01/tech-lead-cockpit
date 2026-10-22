import type { QADbQueryLog, QAFlowResult, QARun, QAStepResult, QAStepStatus } from './types';

/**
 * A run as a Confluence evidence page (storage format): summary, a table of test cases, and per
 * test case its steps with request, response, expectations, data checks and curl in expand
 * blocks. Request and response come from the run as recorded (secrets already masked by the
 * runner). Long bodies are cut; the full run goes along as an attachment. Pure, shared by both apps.
 */

/** Per body in the page; the attachment keeps everything. */
const MAX_BODY = 6_000;
/** Storage format pages get slow past a few MB: the step details stop there, the summary stays. */
const MAX_PAGE = 3_000_000;

const STATUS: Record<QAStepStatus, { label: string; colour: string }> = {
  passed: { label: 'LULUS', colour: 'Green' },
  failed: { label: 'GAGAL', colour: 'Red' },
  error: { label: 'ERROR', colour: 'Red' },
  blocked: { label: 'TERBLOKIR', colour: 'Yellow' },
  skipped: { label: 'DILEWATI', colour: 'Grey' },
  pending: { label: 'BELUM', colour: 'Grey' },
  running: { label: 'BERJALAN', colour: 'Blue' },
};

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** CDATA can't hold "]]>": split it across two sections. */
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

const status = (s: QAStepStatus) => `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${STATUS[s].colour}</ac:parameter><ac:parameter ac:name="title">${STATUS[s].label}</ac:parameter></ac:structured-macro>`;

function cut(text: string | undefined): string {
  const t = text ?? '';
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY)}\n… (dipotong, ${t.length.toLocaleString('id-ID')} karakter; lengkap di lampiran)` : t;
}

/** Pretty JSON when the body is JSON. */
function pretty(body: string | undefined): { text: string; lang: string } {
  if (!body) return { text: '', lang: 'text' };
  try {
    return { text: JSON.stringify(JSON.parse(body), null, 2), lang: 'json' };
  } catch {
    return { text: body, lang: 'text' };
  }
}

const code = (text: string, lang = 'text', title?: string) =>
  `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${lang}</ac:parameter>${title ? `<ac:parameter ac:name="title">${esc(title)}</ac:parameter>` : ''}<ac:parameter ac:name="collapse">false</ac:parameter><ac:plain-text-body>${cdata(cut(text))}</ac:plain-text-body></ac:structured-macro>`;

const expand = (title: string, body: string) => `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">${esc(title)}</ac:parameter><ac:rich-text-body>${body}</ac:rich-text-body></ac:structured-macro>`;

const headers = (h: Record<string, string> | undefined) =>
  Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB' : '-');

function duration(ms?: number): string {
  if (ms === undefined) return '-';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function dbLogs(title: string, logs: QADbQueryLog[] | undefined): string {
  if (!logs?.length) return '';
  const rows = logs.map((l) => `<tr><td>${esc(l.label)}</td><td>${esc(l.db)}</td><td>${l.ok ? '✅' : '❌'}</td><td>${esc(l.value ?? l.error ?? (l.reusedFrom ? `dari ${l.reusedFrom}` : ''))}</td></tr>`).join('');
  const sql = logs.map((l) => `-- ${l.label} (${l.db})\n${l.sql}`).join('\n\n');
  return `<p><strong>${esc(title)}</strong></p><table><tbody><tr><th>Untuk</th><th>DB</th><th>OK</th><th>Hasil</th></tr>${rows}</tbody></table>${code(sql, 'sql', 'SQL')}`;
}

function stepBody(st: QAStepResult): string {
  const parts: string[] = [];
  if (st.error) parts.push(`<p><strong>Error:</strong> ${esc(st.error)}</p>`);
  parts.push(dbLogs('Setup data sebelum request', st.dbSetup));
  if (st.request) {
    const body = pretty(st.request.body);
    parts.push(`<p><strong>Request</strong> <code>${esc(st.request.method)} ${esc(st.request.url)}</code></p>`);
    if (Object.keys(st.request.headers ?? {}).length) parts.push(code(headers(st.request.headers), 'text', 'Header'));
    if (body.text) parts.push(code(body.text, body.lang, 'Body'));
  }
  if (st.response) {
    const body = pretty(st.response.body);
    parts.push(`<p><strong>Response</strong> HTTP ${esc(st.response.status)}${st.response.truncated ? ' (body dipotong runner)' : ''}</p>`);
    if (Object.keys(st.response.headers ?? {}).length) parts.push(code(headers(st.response.headers), 'text', 'Header'));
    if (body.text) parts.push(code(body.text, body.lang, 'Body'));
  }
  if (st.assertions.length) {
    const rows = st.assertions.map((a) => `<tr><td>${a.passed ? '✅' : '❌'}</td><td>${esc(a.message)}</td><td>${esc(String(a.actual === undefined ? '' : typeof a.actual === 'string' ? a.actual : JSON.stringify(a.actual)).slice(0, 500))}</td></tr>`).join('');
    parts.push(`<p><strong>Ekspektasi</strong></p><table><tbody><tr><th>Hasil</th><th>Ekspektasi</th><th>Aktual</th></tr>${rows}</tbody></table>`);
  }
  parts.push(dbLogs('Cek data', st.dbChecks));
  if (st.extracted && Object.keys(st.extracted).length) parts.push(code(headers(st.extracted), 'text', 'Variabel yang diambil'));
  if (st.curl) parts.push(code(st.curl, 'bash', 'Reproduksi (curl)'));
  return parts.join('');
}

function flowSection(f: QAFlowResult, i: number, details: boolean): string {
  const head = `<h3>${i + 1}. ${esc(f.name)} ${status(f.status)}</h3><p>Kategori: ${esc(f.category)}${f.taskTitles.length ? ` · Task: ${esc(f.taskTitles.join(', '))}` : ''}</p>`;
  const data = dbLogs('Data uji dari database', f.dataQueries);
  if (!details) return head + data;
  const steps = f.steps.map((st, j) => expand(`Step ${j + 1}: ${st.name} · ${STATUS[st.status].label}${st.durationMs !== undefined ? ` · ${duration(st.durationMs)}` : ''}`, stepBody(st))).join('');
  return head + data + steps;
}

export function evidenceTitle(run: QARun): string {
  const s = run.summary;
  const at = new Date(run.startedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/\./g, ':');
  return `Evidence ${run.projectName} · ${at} · ${run.environment.name} (${s.passedFlows}/${s.flows} lulus)`.slice(0, 250);
}

export function evidenceStorage(run: QARun, opts: { by?: string; attachment: string }): string {
  const s = run.summary;
  const ms = run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : undefined;
  const info = [
    ['Proyek', esc(run.projectName)],
    ['Environment', `${esc(run.environment.name)}${run.environment.readOnly ? ' (read-only)' : ''}`],
    ['Mulai', when(run.startedAt)],
    ['Selesai', `${when(run.finishedAt)}${ms !== undefined ? ` (${duration(ms)})` : ''}`],
    ['Status run', run.status === 'cancelled' ? 'Dibatalkan' : 'Selesai'],
    ['Test case', `${s.passedFlows}/${s.flows} lulus, ${s.failedFlows} gagal`],
    ['Step', `${s.passedSteps}/${s.steps} lulus, ${s.failedSteps} gagal`],
    ['Dikirim oleh', esc(opts.by ?? '-')],
    ['ID run', `<code>${esc(run.id)}</code>`],
  ];
  const summary = `<table><tbody>${info.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</tbody></table>`;
  const table = `<table><tbody><tr><th>No</th><th>Test case</th><th>Kategori</th><th>Status</th><th>Step lulus</th><th>Durasi</th></tr>${run.flows
    .map((f, i) => {
      const passed = f.steps.filter((x) => x.status === 'passed').length;
      const total = f.steps.reduce((n, x) => n + (x.durationMs ?? 0), 0);
      return `<tr><td>${i + 1}</td><td>${esc(f.name)}</td><td>${esc(f.category)}</td><td>${status(f.status)}</td><td>${passed}/${f.steps.length}</td><td>${duration(total)}</td></tr>`;
    })
    .join('')}</tbody></table>`;
  const intro = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Evidence API Testing, dibuat oleh Cockpit dari hasil run. Token dan password sudah disamarkan. Data lengkap: lampiran <code>${esc(opts.attachment)}</code>. Jangan diedit manual.</p></ac:rich-text-body></ac:structured-macro>`;

  const head = `${intro}<h2>Ringkasan</h2>${summary}<h2>Test case</h2>${table}<h2>Detail</h2>`;
  let body = '';
  let cutAt = -1;
  for (const [i, f] of run.flows.entries()) {
    const full = flowSection(f, i, cutAt < 0);
    if (cutAt < 0 && head.length + body.length + full.length > MAX_PAGE) {
      cutAt = i;
      body += flowSection(f, i, false);
      continue;
    }
    body += full;
  }
  const note = cutAt >= 0 ? `<ac:structured-macro ac:name="note"><ac:rich-text-body><p>Halaman terlalu besar: detail step mulai test case ${cutAt + 1} hanya ada di lampiran.</p></ac:rich-text-body></ac:structured-macro>` : '';
  return head + note + body;
}

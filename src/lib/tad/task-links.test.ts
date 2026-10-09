import { describe, expect, it } from 'vitest';
import {
  checkConformance,
  detailTaskSpec,
  extractTadFlowSteps,
  findTasksForKeys,
  jiraKeysIn,
  parseScopeTasks,
  setScopeJiraKeys,
  suggestTransition,
  verdictOf,
} from './task-links';

const JQL_LINK =
  'https://x.atlassian.net/jira/software/projects/MU/boards/14/backlog?jql=textfields%20~%20%22TABUNGAN-MOTION%2A%22&selectedIssue=MU-2434';

const TAD = [
  '# TAD - Tabungan',
  '',
  '# Development Scope',
  '',
  '|   | **Service Name** | **Task Name** | **Jira Task** |',
  '|---|---|---|---|',
  `| 1 | \`CORE-TCICO\` | [BACKEND][CORE-TCICO][TM] - Get Transfer Sof | [${JQL_LINK}](${JQL_LINK}) |`,
  '| 2 | `CORE-PAYMENT` | [BACKEND][CORE-PAYMENT][TM] - QR Pay | MU-2500 |',
  '| 3 | `PORTAL` | [WEB-FE][PORTAL][TM] - Partner Category | |',
  '',
  '# Detail Task',
  '',
  '## [BACKEND][CORE-TCICO][TM] - Get Transfer Sof',
  '',
  '<table data-table-width="1579"><tbody><tr><th><h3><strong>Description</strong></h3></th><td><p>Ambil SOF aktif. Fallback ke EMONEY.</p></td></tr><tr><th><h3><strong>Service</strong></h3></th><td><p><code>CORE-TCICO-ULTIMATE</code></p></td></tr><tr><th><h3><strong>Endpoint</strong></h3></th><td><h4><code>/v1/internal/tcico/transfer/sof</code></h4></td></tr><tr><th><h3><strong>Method</strong></h3></th><td><p><code>GET</code></p></td></tr><tr><th><h3><strong>Response</strong></h3></th><td><table><tbody><tr><td><code>SUCCESS</code></td><td><code>UNAUTHORIZED</code></td><td><code>GENERAL_ERROR_REQUEST</code></td></tr></tbody></table></td></tr></tbody></table>',
  '',
  '## [BACKEND][CORE-PAYMENT][TM] - QR Pay',
  '',
  '#### Description',
  'Bayar QR dengan SOF tabungan.',
  '',
  '#### Endpoint',
  '`/v1/payment/qr/pay`',
  '',
].join('\n');

describe('TAD ↔ Jira', () => {
  it('reads issue keys from board links and plain cells, not from JQL text', () => {
    expect(jiraKeysIn(`[x](${JQL_LINK})`)).toEqual(['MU-2434']);
    expect(jiraKeysIn('see https://x/browse/MU-9 and MU-10')).toEqual(['MU-9', 'MU-10']);
  });

  it('parses the Development Scope table', () => {
    const tasks = parseScopeTasks(TAD);
    expect(tasks.map((t) => [t.service, t.title, t.jiraKeys])).toEqual([
      ['CORE-TCICO', '[BACKEND][CORE-TCICO][TM] - Get Transfer Sof', ['MU-2434']],
      ['CORE-PAYMENT', '[BACKEND][CORE-PAYMENT][TM] - QR Pay', ['MU-2500']],
      ['PORTAL', '[WEB-FE][PORTAL][TM] - Partner Category', []],
    ]);
  });

  it('reads Detail Task specs from tadgen tables and #### sections', () => {
    const a = detailTaskSpec(TAD, '[BACKEND][CORE-TCICO][TM] - Get Transfer Sof')!;
    expect(a.fields.Endpoint).toBe('/v1/internal/tcico/transfer/sof');
    expect(a.fields.Method).toBe('GET');
    expect(a.fields.Response).toContain('GENERAL_ERROR_REQUEST');
    const b = detailTaskSpec(TAD, '[BACKEND][CORE-PAYMENT][TM] - QR Pay')!;
    expect(b.fields.Endpoint).toBe('`/v1/payment/qr/pay`');
  });

  it('falls back to the task name when the tags differ between scope and detail', () => {
    const spec = detailTaskSpec(TAD, '[BACKEND][CORE-PAYMENT-ULTIMATE][TM] - QR Pay');
    expect(spec?.title).toBe('[BACKEND][CORE-PAYMENT][TM] - QR Pay');
    expect(detailTaskSpec(TAD, '[BACKEND][X][TM] - Tidak Ada')).toBeUndefined();
  });

  it('finds the TAD task for an MR by Jira key', () => {
    const m = findTasksForKeys([{ id: 'd1', markdown: TAD }], ['MU-2434', 'XX-1']);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ draftId: 'd1', task: { title: '[BACKEND][CORE-TCICO][TM] - Get Transfer Sof' } });
    expect(m[0].spec?.fields.Service).toBe('CORE-TCICO-ULTIMATE');
  });
});

describe('checkConformance', () => {
  const [match] = findTasksForKeys([{ id: 'd1', markdown: TAD }], ['MU-2434']);
  const change = (newPath: string, diff: string) => ({ oldPath: newPath, newPath, newFile: false, renamedFile: false, deletedFile: false, diff, additions: 1, deletions: 0 });

  it('passes when repo, route, method and response codes match', () => {
    const checks = checkConformance(match.spec!, match.task, {
      projectPath: 'backend-private/core-tcico-ultimate',
      changes: [
        change('app/routes/transfer.py', '@@\n+@bp.route("/transfer/sof", methods=["GET"])\n+def sof():'),
        change('app/services/sof.py', '@@\n+ return resp("SUCCESS")\n+ except Unauthorized: return resp("UNAUTHORIZED")\n+ return resp("GENERAL_ERROR_REQUEST")'),
        change('tests/test_sof.py', '@@\n+def test_sof(): pass'),
      ],
    });
    expect(checks.map((c) => [c.label, c.status])).toEqual([
      ['Service', 'ok'],
      ['Endpoint /v1/internal/tcico/transfer/sof', 'ok'],
      ['Kode response', 'ok'],
      ['Test', 'ok'],
    ]);
  });

  it('flags a wrong repo, a missing route and missing codes', () => {
    const checks = checkConformance(match.spec!, match.task, {
      projectPath: 'backend-private/core-payment-ultimate',
      changes: [change('a.go', '@@\n+return "SUCCESS"')],
    });
    expect(checks.map((c) => c.status)).toEqual(['warn', 'missing', 'warn', 'warn']);
    expect(checks[2].detail).toContain('UNAUTHORIZED');
  });
});

describe('Jira suggestion', () => {
  const transitions = [
    { id: '1', name: 'Start', to: { name: 'In Progress' } },
    { id: '2', name: 'To QA', to: { name: 'Ready for QA' } },
    { id: '3', name: 'Finish', to: { name: 'Done' } },
  ];

  it('reads the review verdict from its conclusion', () => {
    expect(verdictOf('## Temuan\nAPPROVE nanti\n## Kesimpulan\n**REQUEST CHANGES**: perbaiki')).toBe('changes');
    expect(verdictOf('## Kesimpulan\nAPPROVE WITH COMMENTS')).toBe('approve');
    expect(verdictOf('belum ada kesimpulan')).toBeUndefined();
  });

  it('picks a matching transition Jira actually offers', () => {
    expect(suggestTransition(transitions, 'changes')?.id).toBe('1');
    expect(suggestTransition(transitions, 'approve')?.id).toBe('2');
    expect(suggestTransition(transitions, 'merged')?.id).toBe('2');
    expect(suggestTransition([{ id: '9', name: 'Close', to: { name: 'Closed' } }], 'approve')).toBeUndefined();
    expect(suggestTransition(transitions, undefined)).toBeUndefined();
    // Example workflow: IN REVIEW TL → Review Done / Code Not Pass / Tech Feature.
    const mp = [
      { id: '2', name: 'Review Done', to: { name: 'READY TO TEST' } },
      { id: '7', name: 'Code Not Pass', to: { name: 'To Do' } },
      { id: '9', name: 'Tech Feature', to: { name: 'Done' } },
    ];
    expect(suggestTransition(mp, 'approve')?.id).toBe('2');
    expect(suggestTransition(mp, 'changes')?.id).toBe('7');
  });
});

describe('extractTadFlowSteps', () => {
  it('extracts numbered flow steps from TAD technical implementation', () => {
    const spec = {
      title: 'Develop API Promo Check',
      fields: {
        Description: 'API pengecekan promo abuse',
        Endpoint: '/internal/promo/check',
        Method: 'POST',
      },
      text: [
        '### Description',
        'API pengecekan promo abuse.',
        '',
        '**Technical Implementation**',
        '- **1. Validasi payload:** BodyParser lalu validate.Struct. Gagal return 400.',
        '- **2. Data customer:** Cek cache Redis, jika miss panggil core-user.',
        '- **3. Cek kunci promo:** Query lock DB/Redis, jika terkunci return REJECT.',
        '- **4. Happy path:** Evaluasi rule dan return 200 SUCCESS.',
      ].join('\n'),
    };
    const steps = extractTadFlowSteps(spec);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toEqual({
      number: '1',
      title: 'Validasi payload',
      detail: 'BodyParser lalu validate.Struct. Gagal return 400.',
    });
    expect(steps[2]).toEqual({
      number: '3',
      title: 'Cek kunci promo',
      detail: 'Query lock DB/Redis, jika terkunci return REJECT.',
    });
  });

  it('falls back to default sections when no numbered steps exist', () => {
    const spec = {
      title: 'Simple Task',
      fields: {
        Endpoint: '/v1/users',
        Method: 'GET',
        Payload: '{"id": 1}',
        Description: 'Get user details',
        Response: '200 SUCCESS, 404 NOT_FOUND',
      },
      text: 'Simple task description',
    };
    const steps = extractTadFlowSteps(spec);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0].title).toBe('Endpoint & Route Setup');
  });
});

describe('setScopeJiraKeys', () => {
  const SCOPE = [
    '# Development Scope',
    '',
    '|   | **Service Name** | **Task Name** | **Jira Task** |',
    '|---|---|---|---|',
    '| 1 | `CORE-A` | [BACKEND][CORE-A][X] - API Lama | [https://x.atlassian.net/browse/MU-1](https://x.atlassian.net/browse/MU-1) |',
    '| 2 | `CORE-A` | [BACKEND][CORE-A][X] - API Baru |  |',
    '| 3 | `CORE-B` | [BACKEND][CORE-B][X] - API Lain \\| Pipe |  |',
    '',
    '# Detail Task',
    '',
    '## [BACKEND][CORE-A][X] - API Baru',
  ].join('\n');

  it('fills the Jira column of rows without a key, leaving other rows untouched', () => {
    const r = setScopeJiraKeys(SCOPE, { '[BACKEND][CORE-A][X] - API Baru': 'MU-2', '[BACKEND][CORE-A][X] - API Lama': 'MU-9', 'Tidak ada': 'MU-3' });
    expect(r.written).toEqual(['[BACKEND][CORE-A][X] - API Baru']);
    expect(r.markdown).toContain('| 2 | `CORE-A` | [BACKEND][CORE-A][X] - API Baru | MU-2 |');
    expect(r.markdown).toContain('browse/MU-1');
    expect(r.markdown).not.toContain('MU-9');
    expect(r.markdown).toContain('API Lain \\| Pipe |  |');
    expect(parseScopeTasks(r.markdown).find((t) => t.title.endsWith('API Baru'))?.jiraKeys).toEqual(['MU-2']);
  });

  it('adds a Jira Task column when the table has none', () => {
    const md = '# Development Scope\n\n| No | Service | Task |\n|---|---|---|\n| 1 | CORE-A | Task A |\n| 2 | CORE-A | Task B |\n';
    const r = setScopeJiraKeys(md, { 'Task B': 'MU-7' });
    expect(r.markdown).toContain('| No | Service | Task | **Jira Task** |');
    expect(r.markdown).toContain('| --- | --- | --- | --- |');
    expect(r.markdown).toContain('| 1 | CORE-A | Task A |  |');
    expect(r.markdown).toContain('| 2 | CORE-A | Task B | MU-7 |');
  });

  it('writes into an HTML scope table', () => {
    const md = '# Development Scope\n\n<table><tbody><tr><th>No</th><th>Service</th><th>Task Name</th><th>Jira</th></tr><tr><td>1</td><td>CORE-A</td><td>Task A</td><td></td></tr></tbody></table>\n\n# Detail Task\n';
    const r = setScopeJiraKeys(md, { 'Task A': 'MU-5' });
    expect(r.written).toEqual(['Task A']);
    expect(r.markdown).toContain('<td><span data-tlc-jira="MU-5">MU-5</span></td>');
    expect(r.markdown).toContain('# Detail Task');
    expect(parseScopeTasks(r.markdown)[0].jiraKeys).toEqual(['MU-5']);
  });
});

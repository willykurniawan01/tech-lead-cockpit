import type { QAEnvironment, QAFlow, QAPlan, QAProject, QARun, QASuite } from '../../src/lib/qa/types.ts';
import { ConfluenceError } from '../confluence.ts';
import { bare, KEEP_RUNS, QaConflictError, storableEnvironment, type QaStore } from './store.ts';

/**
 * API Testing data in Confluence, shared by Tech Lead Cockpit and QA Cockpit. Everything lives
 * under one parent page the user picks:
 *
 *   <parent>
 *   ├── API Testing · Environment                 environments.json
 *   └── <project> · API Testing [<projectId>]     project.json, suite.json   (body: readable summary)
 *       ├── <project> · Rencana [<projectId>]     plan.json
 *       └── <project> · Run [<projectId>]         run-<id>.json (newest KEEP_RUNS)
 *
 * The JSON attachments are the data; page bodies are summaries for people. The page version is
 * the lock: a save updates the page with version + 1 first (Confluence refuses a stale one with
 * 409), then replaces the attachment, so a save over someone else's newer one never goes
 * through. Runs never change once written, so their page has no lock. The account is shared, so
 * who saved is recorded by the app (updatedBy), not by Confluence's history.
 */

/** What the store needs from Confluence (ConfluenceClient; tests pass a fake). */
export interface ConfluenceApi {
  getPage(id: string, spaceKey?: string): Promise<{ id: string; title: string; version: number; storage?: string }>;
  childPages(pageId: string): Promise<{ id: string; title: string; version: number }[]>;
  createPage(input: { spaceKey: string; title: string; parentId?: string; storage: string }): Promise<{ id: string; version: number }>;
  updatePage(input: { id: string; spaceKey: string; title: string; storage: string; version: number; message?: string }): Promise<{ version: number }>;
  attachments(pageId: string, filename?: string): Promise<{ id: string; title: string }[]>;
  readAttachment(pageId: string, filename: string): Promise<string | null>;
  putAttachment(pageId: string, filename: string, data: Buffer, contentType: string): Promise<void>;
  deleteAttachment(attachmentId: string): Promise<void>;
}

export interface ConfluenceLocation {
  spaceKey: string;
  parentPageId: string;
}

const ENV_TITLE = 'API Testing · Environment';
const RUN_FILE = /^run-([A-Za-z0-9_-]{1,64})\.json$/;
const projectTitle = (name: string, id: string) => `${clip(name)} · API Testing [${id}]`;
const planTitle = (name: string, id: string) => `${clip(name)} · Rencana [${id}]`;
const runsTitle = (name: string, id: string) => `${clip(name)} · Run [${id}]`;
const clip = (s: string) => s.replace(/[[\]]/g, '').trim().slice(0, 120) || 'Proyek';
/** The project id at the end of a project page title. */
const idOf = (title: string) => /· API Testing \[([A-Za-z0-9_-]{1,64})\]$/.exec(title)?.[1];

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function note(text: string): string {
  return `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>${esc(text)}</p></ac:rich-text-body></ac:structured-macro>`;
}

function suiteBody(s: QASuite, by?: string): string {
  const groups = new Map<string, QAFlow[]>();
  for (const f of s.flows) groups.set(f.stage ?? '', [...(groups.get(f.stage ?? '') ?? []), f]);
  const order = [...(s.groups ?? []).filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !(s.groups ?? []).includes(g))];
  const tables = order.map((g) => {
    const rows = groups.get(g)!.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.category)}</td><td>${f.steps.length}</td><td>${f.enabled ? 'Ya' : 'Tidak'}</td><td>${esc(f.taskTitles.join(', '))}</td></tr>`).join('');
    return `<h2>${esc(g || 'Tanpa grup')} (${groups.get(g)!.length})</h2><table><tbody><tr><th>Test case</th><th>Kategori</th><th>Step</th><th>Aktif</th><th>Task TAD</th></tr>${rows}</tbody></table>`;
  });
  return [
    note(`Dikelola oleh Cockpit (API Testing). Jangan ubah halaman atau lampirannya secara manual. Terakhir disimpan oleh ${by ?? 'tidak diketahui'} pada ${new Date().toISOString()}.`),
    `<p><strong>${s.flows.length} test case</strong> dalam ${order.length} grup.</p>`,
    ...tables,
  ].join('');
}

function parse<T>(text: string | null, what: string): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConfluenceError(`Lampiran ${what} di Confluence rusak (bukan JSON).`, 502, 'upstream');
  }
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2), 'utf8');

/** Runs `fn` over items, at most `limit` at a time (Confluence rate limits). */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export class ConfluenceQaStore implements QaStore {
  readonly kind = 'confluence' as const;
  /** projectId → page ids, filled from the parent's children (pages are never moved by the app). */
  private projects = new Map<string, { id: string; title: string }>();
  private children = new Map<string, Map<string, string>>();

  constructor(
    private readonly api: ConfluenceApi,
    private readonly at: ConfluenceLocation,
  ) {}

  /** "Tes koneksi": the parent page and whether this account may update it. */
  async probe(canUpdate?: (pageId: string) => Promise<boolean | undefined>): Promise<{ title: string; canUpdate?: boolean }> {
    const page = await this.api.getPage(this.at.parentPageId, this.at.spaceKey);
    return { title: page.title, canUpdate: await canUpdate?.(page.id) };
  }

  private async scan(): Promise<void> {
    const pages = await this.api.childPages(this.at.parentPageId);
    this.projects = new Map(pages.flatMap((p) => (idOf(p.title) ? [[idOf(p.title)!, { id: p.id, title: p.title }] as const] : [])));
  }

  private async projectPage(projectId: string): Promise<{ id: string; title: string } | undefined> {
    if (!this.projects.has(projectId)) await this.scan();
    return this.projects.get(projectId);
  }

  /** The project's page, created (with its sub-pages) on first save. */
  private async ensureProject(projectId: string, name: string, body: string): Promise<{ id: string; title: string; created: boolean }> {
    const existing = await this.projectPage(projectId);
    if (existing) return { ...existing, created: false };
    const title = projectTitle(name, projectId);
    const page = await this.api.createPage({ spaceKey: this.at.spaceKey, title, parentId: this.at.parentPageId, storage: body });
    this.projects.set(projectId, { id: page.id, title });
    return { id: page.id, title, created: true };
  }

  /** A sub-page of the project (plan, runs), found by its title and created when missing. */
  private async subPage(projectId: string, name: string, kind: 'plan' | 'runs', create: boolean): Promise<string | undefined> {
    const project = await this.projectPage(projectId);
    if (!project) return undefined;
    const title = kind === 'plan' ? planTitle(name, projectId) : runsTitle(name, projectId);
    const suffix = `· ${kind === 'plan' ? 'Rencana' : 'Run'} [${projectId}]`;
    let pages = this.children.get(project.id);
    if (!pages || ![...pages.keys()].some((t) => t.endsWith(suffix))) {
      pages = new Map((await this.api.childPages(project.id)).map((p) => [p.title, p.id]));
      this.children.set(project.id, pages);
    }
    const found = [...pages.entries()].find(([t]) => t.endsWith(suffix));
    if (found) return found[1];
    if (!create) return undefined;
    const body = kind === 'plan' ? note('Rencana journey API Testing (lampiran plan.json). Dikelola oleh Cockpit.') : note('Riwayat run API Testing (lampiran run-*.json). Dikelola oleh Cockpit.');
    const page = await this.api.createPage({ spaceKey: this.at.spaceKey, title, parentId: project.id, storage: body });
    pages.set(title, page.id);
    return page.id;
  }

  private async conflict(what: QaConflictError['what'], pageId: string, file: string): Promise<QaConflictError> {
    const current = await this.api.readAttachment(pageId, file).then((t) => parse<{ updatedBy?: string; updatedAt?: string }>(t, file)).catch(() => null);
    return new QaConflictError(what, current?.updatedBy, current?.updatedAt);
  }

  /**
   * One versioned document: the page moves to expected + 1 (refused by Confluence when someone
   * else moved it), then the attachment is replaced.
   */
  private async saveVersioned<T extends object>(what: QaConflictError['what'], page: { id: string; title: string }, file: string, data: T, expected: number, body: string, by?: string): Promise<{ version: number; updatedAt: string }> {
    const current = await this.api.getPage(page.id, this.at.spaceKey);
    if (current.version !== expected) throw await this.conflict(what, page.id, file);
    let version: number;
    try {
      version = (await this.api.updatePage({ id: page.id, spaceKey: this.at.spaceKey, title: current.title, storage: body, version: expected + 1, message: by ? `Disimpan oleh ${by}` : undefined })).version;
    } catch (e) {
      if (e instanceof ConfluenceError && e.status === 409) throw await this.conflict(what, page.id, file);
      throw e;
    }
    const updatedAt = new Date().toISOString();
    await this.api.putAttachment(page.id, file, json({ ...data, version, updatedAt, ...(by ? { updatedBy: by } : {}) }), 'application/json');
    // Should an attachment upload ever count as a page version, the next save must expect that one.
    return { version: Math.max(version, (await this.api.getPage(page.id, this.at.spaceKey)).version), updatedAt };
  }

  // Suites ----------------------------------------------------------------------------------

  async getSuite(projectId: string): Promise<QASuite | null> {
    const page = await this.projectPage(projectId);
    if (!page) return null;
    const [info, text] = await Promise.all([this.api.getPage(page.id, this.at.spaceKey), this.api.readAttachment(page.id, 'suite.json')]);
    const suite = parse<QASuite>(text, 'suite.json');
    // The page version is the lock, whatever the attachment says.
    return suite ? { ...suite, version: info.version } : null;
  }

  async saveSuite(suite: QASuite, by?: string): Promise<QASuite> {
    const data = bare(suite) as QASuite;
    const expected = suite.version ?? 0;
    const existing = await this.projectPage(suite.projectId);
    if (!existing) {
      if (expected !== 0) throw new QaConflictError('suite');
      const page = await this.ensureProject(suite.projectId, suite.projectName, suiteBody(data, by));
      const updatedAt = new Date().toISOString();
      await this.api.putAttachment(page.id, 'project.json', json({ id: suite.projectId, name: suite.projectName, tads: [], updatedAt, ...(by ? { updatedBy: by } : {}) }), 'application/json');
      await this.api.putAttachment(page.id, 'suite.json', json({ ...data, version: 1, updatedAt, ...(by ? { updatedBy: by } : {}) }), 'application/json');
      return { ...data, version: 1, ...(by ? { updatedBy: by } : {}) };
    }
    // A page made for the project (upsertProject) without test cases yet is still a first save.
    const hasSuite = (await this.api.attachments(existing.id, 'suite.json')).length > 0;
    const { version } = await this.saveVersioned('suite', existing, 'suite.json', data, hasSuite || expected !== 0 ? expected : (await this.api.getPage(existing.id)).version, suiteBody(data, by), by);
    return { ...data, version, ...(by ? { updatedBy: by } : {}) };
  }

  // Plans -----------------------------------------------------------------------------------

  async getPlan(projectId: string): Promise<QAPlan | null> {
    const pageId = await this.subPage(projectId, '', 'plan', false);
    if (!pageId) return null;
    const [info, text] = await Promise.all([this.api.getPage(pageId, this.at.spaceKey), this.api.readAttachment(pageId, 'plan.json')]);
    const plan = parse<QAPlan>(text, 'plan.json');
    return plan ? { ...plan, version: info.version } : null;
  }

  async savePlan(plan: QAPlan, by?: string): Promise<QAPlan> {
    const data = bare(plan) as QAPlan;
    if (!(await this.projectPage(plan.projectId))) await this.ensureProject(plan.projectId, plan.projectName, note('Belum ada test case.'));
    const pageId = (await this.subPage(plan.projectId, plan.projectName, 'plan', true))!;
    const page = await this.api.getPage(pageId, this.at.spaceKey);
    const hasPlan = (await this.api.attachments(pageId, 'plan.json')).length > 0;
    // A sub-page just made holds no plan yet: its first version counts as "new".
    const expected = plan.version ?? 0;
    const body = note(`Rencana journey: ${data.stages.length} tahap. Dikelola oleh Cockpit; terakhir disimpan oleh ${by ?? 'tidak diketahui'}.`);
    const { version } = await this.saveVersioned('plan', { id: pageId, title: page.title }, 'plan.json', data, !hasPlan && expected === 0 ? page.version : expected, body, by);
    return { ...data, version, ...(by ? { updatedBy: by } : {}) };
  }

  // Environments ----------------------------------------------------------------------------

  private async envPage(create: boolean): Promise<{ id: string; title: string; version: number } | undefined> {
    const found = (await this.api.childPages(this.at.parentPageId)).find((p) => p.title === ENV_TITLE);
    if (found || !create) return found;
    const page = await this.api.createPage({ spaceKey: this.at.spaceKey, title: ENV_TITLE, parentId: this.at.parentPageId, storage: note('Environment API Testing (lampiran environments.json), tanpa token atau password. Dikelola oleh Cockpit.') });
    return { id: page.id, title: ENV_TITLE, version: page.version };
  }

  async listEnvironments(): Promise<QAEnvironment[]> {
    const page = await this.envPage(false);
    if (!page) return [];
    const doc = parse<{ environments: QAEnvironment[] }>(await this.api.readAttachment(page.id, 'environments.json'), 'environments.json');
    // One page holds every environment: its version guards each of them.
    return (doc?.environments ?? []).map((e) => ({ ...e, version: page.version }));
  }

  private async writeEnvironments(fn: (envs: QAEnvironment[]) => QAEnvironment[], expected: number | undefined, by?: string): Promise<number> {
    const page = (await this.envPage(true))!;
    const doc = parse<{ environments: QAEnvironment[] }>(await this.api.readAttachment(page.id, 'environments.json'), 'environments.json');
    const envs = fn((doc?.environments ?? []).map((e) => bare(e) as QAEnvironment));
    const body = note(`${envs.length} environment: ${envs.map((e) => e.name).join(', ') || '-'}. Token dan password tidak disimpan di sini. Dikelola oleh Cockpit.`);
    // The page as created holds no environments yet: anyone's first environment may be saved on it.
    const base = expected === undefined || (!doc && expected === 0) ? page.version : expected;
    return (await this.saveVersioned('environment', page, 'environments.json', { environments: envs }, base, body, by)).version;
  }

  async saveEnvironment(env: QAEnvironment, by?: string): Promise<QAEnvironment> {
    const saved = { ...storableEnvironment(env), updatedAt: new Date().toISOString(), ...(by ? { updatedBy: by } : {}) } as QAEnvironment;
    const isNew = !(env.version ?? 0);
    // A new environment never collides: it is added to whatever is there now.
    const version = await this.writeEnvironments((envs) => (envs.some((e) => e.id === env.id) ? envs.map((e) => (e.id === env.id ? saved : e)) : [...envs, saved]), isNew ? undefined : env.version, by);
    return { ...saved, version };
  }

  async deleteEnvironment(id: string): Promise<void> {
    await this.writeEnvironments((envs) => envs.filter((e) => e.id !== id), undefined);
  }

  // Runs ------------------------------------------------------------------------------------

  private async runFiles(pageId: string): Promise<{ id: string; title: string; runId: string }[]> {
    // Run ids start with their start time, so names sort oldest first.
    return (await this.api.attachments(pageId))
      .flatMap((a) => (RUN_FILE.test(a.title) ? [{ ...a, runId: RUN_FILE.exec(a.title)![1] }] : []))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async listRuns(projectId: string): Promise<QARun[]> {
    const pageId = await this.subPage(projectId, '', 'runs', false);
    if (!pageId) return [];
    const files = (await this.runFiles(pageId)).reverse().slice(0, KEEP_RUNS);
    const runs = await pool(files, 6, (f) => this.api.readAttachment(pageId, f.title).then((t) => parse<QARun>(t, f.title)).catch(() => null));
    return runs.filter((r): r is QARun => Boolean(r));
  }

  async getRun(projectId: string, id: string): Promise<QARun | undefined> {
    const pageId = await this.subPage(projectId, '', 'runs', false);
    if (!pageId) return undefined;
    return parse<QARun>(await this.api.readAttachment(pageId, `run-${id}.json`), 'run') ?? undefined;
  }

  async saveRun(run: QARun, by?: string): Promise<void> {
    if (!(await this.projectPage(run.projectId))) await this.ensureProject(run.projectId, run.projectName, note('Belum ada test case.'));
    const pageId = (await this.subPage(run.projectId, run.projectName, 'runs', true))!;
    await this.api.putAttachment(pageId, `run-${run.id}.json`, json({ ...run, ...(by ? { createdBy: by } : {}) }), 'application/json');
    const files = await this.runFiles(pageId);
    for (const old of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) await this.api.deleteAttachment(old.id).catch(() => {});
  }

  // Projects --------------------------------------------------------------------------------

  async listProjects(): Promise<QAProject[]> {
    await this.scan();
    const pages = [...this.projects.entries()];
    const docs = await pool(pages, 6, ([id, p]) =>
      this.api
        .readAttachment(p.id, 'project.json')
        .then((t) => parse<QAProject>(t, 'project.json'))
        .catch(() => null)
        .then((doc) => ({ id, name: doc?.name ?? p.title.replace(/ · API Testing \[[^\]]+\]$/, ''), tads: doc?.tads ?? [], updatedAt: doc?.updatedAt ?? '', ...(doc?.updatedBy ? { updatedBy: doc.updatedBy } : {}) })),
    );
    return docs.sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertProject(project: Omit<QAProject, 'updatedAt' | 'updatedBy'>, by?: string): Promise<QAProject> {
    const page = await this.ensureProject(project.id, project.name, note('Belum ada test case.'));
    const saved: QAProject = { ...project, updatedAt: new Date().toISOString(), ...(by ? { updatedBy: by } : {}) };
    // No version: only Tech Lead Cockpit writes it, and the latest name and TADs win.
    await this.api.putAttachment(page.id, 'project.json', json(saved), 'application/json');
    return saved;
  }
}

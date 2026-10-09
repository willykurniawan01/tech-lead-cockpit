// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StartCoderRunRequest } from '../src/lib/coder/types.ts';
import { agentPrompt, branchName, CoderRuns, commandPrefix, DEFAULT_PROFILES, detectTestCommands, newMrUrl, repoFileMap, webUrlOf, type CoderJira } from './coder-runs.ts';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function until(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('helpers', () => {
  it('names branches after the Jira key and task', () => {
    expect(branchName('MU-2434', '[BACKEND][CORE-TCICO][TABUNGAN-MOTION] - Develop API Mobile Get Transfer Sof')).toBe('feature/MU-2434-develop-api-mobile-get-transfer-sof');
    expect(branchName(undefined, 'Tambah filter')).toBe('feature/agent-tambah-filter');
    expect(branchName('MU-9', '[BUGFIX][CORE-PROMO-ULTIMATE] - Reserve promo gagal 500', 'fix')).toBe('fix/MU-9-reserve-promo-gagal-500');
  });

  it('builds the GitLab new-MR link from https and ssh origins', () => {
    expect(webUrlOf('git@gitlab.example.com:backend-private/core-tcico.git')).toBe('https://gitlab.example.com/backend-private/core-tcico');
    expect(webUrlOf('https://gitlab.example.com/backend-private/core-tcico.git')).toBe('https://gitlab.example.com/backend-private/core-tcico');
    const url = newMrUrl('https://gitlab.example.com/b/x.git', 'feature/MU-1-a', 'staging', 'MU-1 A')!;
    expect(url).toContain('/b/x/-/merge_requests/new?');
    expect(decodeURIComponent(url)).toContain('merge_request[title]=Draft: MU-1 A');
  });

  it('limits test commands to fixed prefixes', () => {
    expect(commandPrefix('go test ./...')).toBe('go test');
    expect(commandPrefix('npm run lint')).toBe('npm run lint');
  });
});

describe('CoderRuns', () => {
  let tmp: string;
  let services: string;
  let remote: string;
  const jiraLog: string[] = [];
  let jiraStatus = { status: 'To Do', statusCategory: 'new' };

  const jira: CoderJira = {
    status: async () => jiraStatus,
    transitions: async () =>
      jiraStatus.statusCategory === 'new'
        ? [{ id: '11', name: 'Start', to: { name: 'In Progress' } }]
        : [{ id: '4', name: 'Development Done', to: { name: 'IN REVIEW TL' } }],
    move: async (key, id) => {
      jiraLog.push(`${key}:${id}`);
      const from = jiraStatus.status;
      jiraStatus = id === '11' ? { status: 'In Progress', statusCategory: 'indeterminate' } : { status: 'IN REVIEW TL', statusCategory: 'indeterminate' };
      return { from, to: jiraStatus.status };
    },
  };

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tlc-coder-'));
    jiraLog.length = 0;
    jiraStatus = { status: 'To Do', statusCategory: 'new' };
    // "GitLab": a bare repo with a staging branch; the user's checkout under Services clones it.
    remote = join(tmp, 'remote.git');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'staging', remote]);
    const seed = join(tmp, 'seed');
    execFileSync('git', ['clone', '--quiet', remote, seed]);
    sh(seed, 'config', 'user.email', 't@t');
    sh(seed, 'config', 'user.name', 't');
    await writeFile(join(seed, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }));
    await writeFile(join(seed, 'check.js'), "process.exit(require('fs').existsSync('feature.js') ? 0 : 1)");
    sh(seed, 'add', '-A');
    sh(seed, 'commit', '--quiet', '-m', 'init');
    sh(seed, 'push', '--quiet', 'origin', 'HEAD:staging');
    services = join(tmp, 'services');
    execFileSync('git', ['clone', '--quiet', remote, join(services, 'svc-a')]);
    execFileSync('git', ['clone', '--quiet', remote, join(services, 'svc-b')]);
    for (const r of ['svc-a', 'svc-b']) {
      sh(join(services, r), 'config', 'user.email', 't@t');
      sh(join(services, r), 'config', 'user.name', 't');
    }
  });
  afterEach(() => rm(tmp, { recursive: true, force: true }));

  const req = (repo: string, title: string, jiraKey?: string): StartCoderRunRequest => ({
    draftId: 'd1',
    tadTitle: 'TAD - X',
    taskTitle: title,
    jiraKey,
    profile: 'backend',
    repo,
    spec: '### Endpoint\n/v1/x',
  });

  function manager(aiDelay = 0, writeFiles = true) {
    const started: string[] = [];
    const runs = new CoderRuns({
      dataDir: join(tmp, 'coder'),
      servicesRoot: async () => services,
      jira: async () => jira,
      runAi: (_sel, prompt, opts) => {
        started.push(opts.cwd);
        return {
          cancel: () => {},
          done: (async () => {
            await new Promise((r) => setTimeout(r, aiDelay));
            expect(opts.allowedCommands).toEqual(_sel.provider === 'claude' ? ['npm run test'] : []);
            expect(prompt).toContain('/v1/x');
            if (writeFiles) await writeFile(join(opts.cwd, 'feature.js'), 'module.exports = 1;\n');
            return { reply: 'Selesai: feature.js', sessionId: 's1' };
          })(),
        };
      },
    });
    for (const r of ['svc-a', 'svc-b']) sh(join(services, r), 'config', 'user.name', 't');
    return { runs, started };
  }

  it('clones, lets the agent work, tests, commits; pushes only on request and moves Jira around review', async () => {
    const { runs } = manager();
    const [run] = await runs.start([req('svc-a', '[BACKEND][SVC-A][X] - Tambah fitur', 'MU-1')]);
    await until(() => runs.get(run.id)!.status === 'ready');
    const r = runs.get(run.id)!;
    expect(r.worktree.startsWith(join(tmp, 'coder', 'work'))).toBe(true);
    expect(sh(r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/MU-1-tambah-fitur');
    expect(sh(r.worktree, 'log', '-1', '--format=%s')).toBe('MU-1 Tambah fitur');
    expect(sh(r.worktree, 'log', '-1', '--format=%B').trim()).toBe('MU-1 Tambah fitur');
    expect(r.test).toMatchObject({ command: 'npm run test', exitCode: 0 });
    expect(r.changedFiles).toEqual([{ path: 'feature.js', additions: 1, deletions: 0 }]);
    expect(jiraLog).toEqual(['MU-1:11']); // To Do → In Progress when the agent started
    // The user's own checkout is untouched.
    expect(existsSync(join(services, 'svc-a', 'feature.js'))).toBe(false);
    // Nothing reached "GitLab" yet.
    expect(sh(remote, 'branch', '--list', 'feature/*')).toBe('');

    const diff = await runs.diff(run.id);
    expect(diff[0]).toMatchObject({ newPath: 'feature.js', newFile: true, additions: 1 });

    const pushed = await runs.push(run.id);
    expect(pushed.status).toBe('pushed');
    expect(sh(remote, 'branch', '--list', 'feature/*')).toContain('feature/MU-1-tambah-fitur');
    expect(jiraLog).toEqual(['MU-1:11', 'MU-1:4']); // In Progress → IN REVIEW TL on push, never further
    expect(pushed.mrCreateUrl).toBeUndefined(); // a local path origin has no web URL
  }, 20_000);

  it('runs different repos in parallel but never two runs on the same repo', async () => {
    const { runs } = manager(150);
    const created = await runs.start([req('svc-a', 'A1'), req('svc-a', 'A2'), req('svc-b', 'B1')]);
    await until(() => created.some((c) => runs.get(c.id)!.status === 'running'));
    await until(() => runs.get(created[2].id)!.status === 'running' || runs.get(created[2].id)!.status === 'ready');
    const statuses = created.map((c) => runs.get(c.id)!.status);
    expect(statuses[1]).toBe('queued'); // A2 waits for A1 (same repo)
    await until(() => created.every((c) => !['queued', 'preparing', 'running', 'testing'].includes(runs.get(c.id)!.status)), 25_000).catch(() => {});
    expect(created.map((c) => runs.get(c.id)!.status)).toEqual(['ready', 'ready', 'ready']);
  }, 30_000);

  it('fails clearly when the agent changes nothing, and survives a restart', async () => {
    const { runs } = manager(0, false);
    const [run] = await runs.start([req('svc-b', 'Kosong')]);
    await until(() => ['failed', 'ready'].includes(runs.get(run.id)!.status));
    expect(runs.get(run.id)).toMatchObject({ status: 'failed', error: 'Agent selesai tanpa mengubah file apa pun.' });
    const state = JSON.parse(await readFile(join(tmp, 'coder', 'state.json'), 'utf8'));
    expect(state.runs[0].id).toBe(run.id);
    const reloaded = new CoderRuns({ dataDir: join(tmp, 'coder'), servicesRoot: async () => services, runAi: () => ({ cancel() {}, done: Promise.resolve({ reply: '' }) }) });
    expect((await reloaded.list()).runs[0].status).toBe('failed');
  });

  it('rejects repos outside the Services folder', async () => {
    const { runs } = manager();
    await expect(runs.start([req('../x', 'T')])).rejects.toThrow(/tidak valid/);
    await expect(runs.start([req('nope', 'T')])).rejects.toThrow(/bukan repo git/);
  });

  it('gives Antigravity the file list and keeps its edits when a terminal command is denied', async () => {
    const prompts: string[] = [];
    const runs = new CoderRuns({
      dataDir: join(tmp, 'coder'),
      servicesRoot: async () => services,
      runAi: (_sel, prompt, opts) => {
        prompts.push(prompt);
        expect(opts.allowedCommands).toEqual([]);
        return {
          cancel: () => {},
          done: (async () => {
            await writeFile(join(opts.cwd, 'feature.js'), 'module.exports = 1;\n');
            return { reply: '', error: 'Antigravity CLI mencoba menjalankan perintah terminal, dan itu sengaja diblokir.' };
          })(),
        };
      },
    });
    await runs.updateSettings({ profiles: { backend: { ai: { provider: 'antigravity', model: 'gemini-3.8-flash-high' } } } });
    const [run] = await runs.start([req('svc-a', 'Agy')]);
    await until(() => ['failed', 'ready'].includes(runs.get(run.id)!.status));
    expect(runs.get(run.id)).toMatchObject({ status: 'ready', test: { exitCode: 0 } });
    expect(prompts[0]).toContain('Daftar file repo');
    expect(prompts[0]).toMatch(/\ncheck\.js\npackage\.json$/);
  });

  it('still fails a denied run that changed nothing', async () => {
    const runs = new CoderRuns({
      dataDir: join(tmp, 'coder'),
      servicesRoot: async () => services,
      runAi: () => ({ cancel() {}, done: Promise.resolve({ reply: '', error: 'Antigravity CLI mencoba menjalankan perintah terminal, dan itu sengaja diblokir.' }) }),
    });
    await runs.updateSettings({ profiles: { backend: { ai: { provider: 'antigravity', model: 'gemini-3.8-flash-high' } } } });
    const [run] = await runs.start([req('svc-b', 'Agy kosong')]);
    await until(() => ['failed', 'ready'].includes(runs.get(run.id)!.status));
    expect(runs.get(run.id)!.error).toContain('perintah terminal');
  });

  it('maps repo files, skipping vendored and binary files, and summarises past the budget', async () => {
    const dir = join(tmp, 'map');
    execFileSync('git', ['init', '--quiet', dir]);
    execFileSync('mkdir', ['-p', join(dir, 'app/models'), join(dir, 'vendor/x')]);
    for (const f of ['app/models/a.go', 'app/models/b.go', 'main.go', 'vendor/x/y.go', 'logo.png']) await writeFile(join(dir, f), 'x');
    sh(dir, 'add', '-A');
    expect(await repoFileMap(dir)).toBe('app/models/a.go\napp/models/b.go\nmain.go');
    expect(await repoFileMap(dir, 16)).toBe('app/models/a.go\n… 2 file lain tidak dicantumkan:\napp/models/ (1 file lain)\n./ (1 file lain)');
  });

  it('tells file-only agents to use the map instead of guessing paths', () => {
    const p = agentPrompt(DEFAULT_PROFILES.backend, req('svc-a', 'T'), [], undefined, ['go test ./...'], 'main.go');
    expect(p).toContain('jangan menebak nama file');
    expect(p).toContain('Terminal TIDAK tersedia');
    expect(p.endsWith('main.go')).toBe(true);
    expect(agentPrompt(DEFAULT_PROFILES.backend, req('svc-a', 'T'), ['go test ./...'])).not.toContain('Daftar file repo');
    // A bug fix asks for a reproducing test first and labels the spec as the bug analysis.
    const bug = agentPrompt(DEFAULT_PROFILES.backend, { ...req('svc-a', 'T'), kind: 'bugfix', tadTitle: 'Bug: Reserve gagal' }, ['go test ./...']);
    expect(bug).toContain('INI PERBAIKAN BUG');
    expect(bug).toContain('Tulis dulu test yang mereproduksi bug');
    expect(bug).toContain('Kasus bug: Bug: Reserve gagal');
    expect(bug).toContain('Laporan, analisa, dan rencana perbaikan bug');
    expect(bug).not.toMatch(/^TAD: /m);
    expect(agentPrompt(DEFAULT_PROFILES.backend, req('svc-a', 'T'), [])).not.toContain('PERBAIKAN BUG');
  });

  it('detects test commands from manifests', async () => {
    const dir = join(tmp, 'go');
    execFileSync('mkdir', ['-p', dir]);
    await writeFile(join(dir, 'go.mod'), 'module x');
    expect(await detectTestCommands(dir)).toEqual(['go build ./...', 'go test ./...']);
  });

  it('supports custom baseBranch and targetBranch configuration', async () => {
    // create a development branch on remote
    const seed = join(tmp, 'seed');
    sh(seed, 'checkout', '-b', 'development');
    await writeFile(join(seed, 'dev.txt'), 'dev branch content');
    sh(seed, 'add', '-A');
    sh(seed, 'commit', '-m', 'add dev.txt');
    sh(seed, 'push', 'origin', 'development');

    // fetch development in services/svc-a
    sh(join(services, 'svc-a'), 'fetch', 'origin');

    const { runs } = manager();
    const [run] = await runs.start([{
      ...req('svc-a', 'Task dari Dev'),
      baseBranch: 'development',
      targetBranch: 'staging',
    }]);

    await until(() => ['ready', 'failed'].includes(runs.get(run.id)!.status), 25_000);
    const r = runs.get(run.id)!;
    if (r.status === 'failed') throw new Error(`Run failed: ${r.error} (events: ${JSON.stringify(r.events)})`);
    expect(r.baseBranch).toBe('development');
    expect(r.targetBranch).toBe('staging');
    expect(existsSync(join(r.worktree, 'dev.txt'))).toBe(true);

    const pushed = await runs.push(run.id);
    expect(pushed.status).toBe('pushed');
  }, 30_000);

  it('resolves merge conflict during revise when target branch has conflicting commits', async () => {
    let callCount = 0;
    const runs = new CoderRuns({
      dataDir: join(tmp, 'coder'),
      servicesRoot: async () => services,
      jira: async () => jira,
      runAi: (_sel, prompt, opts) => {
        callCount++;
        return {
          cancel: () => {},
          done: (async () => {
            if (callCount === 1) {
              await writeFile(join(opts.cwd, 'feature.js'), 'module.exports = "feature v1";\n');
              return { reply: 'Selesai feature.js' };
            }
            expect(prompt).toContain('🚨 TUGAS UTAMA: Selesaikan Merge Conflict');
            expect(prompt).toContain('feature.js');
            const content = await readFile(join(opts.cwd, 'feature.js'), 'utf8');
            expect(content).toContain('<<<<<<< HEAD');
            await writeFile(join(opts.cwd, 'feature.js'), 'module.exports = "resolved combined";\n');
            return { reply: 'Conflict resolved cleanly.' };
          })(),
        };
      },
    });

    const [run] = await runs.start([req('svc-a', 'Conflict Task')]);
    await until(() => runs.get(run.id)!.status === 'ready', 25_000);
    expect(runs.get(run.id)!.status).toBe('ready');

    // Meanwhile on remote staging: commit conflicting changes to feature.js
    const seed = join(tmp, 'seed');
    sh(seed, 'checkout', 'staging');
    await writeFile(join(seed, 'feature.js'), 'module.exports = "staging upstream change";\n');
    sh(seed, 'add', '-A');
    sh(seed, 'commit', '-m', 'conflicting commit on staging');
    sh(seed, 'push', 'origin', 'staging');

    // Trigger revision with conflict instruction
    await runs.revise(run.id, 'Ada merge conflict dengan staging, tolong selesaikan', { syncTarget: true });
    await until(() => ['ready', 'failed'].includes(runs.get(run.id)!.status), 25_000);

    const updated = runs.get(run.id)!;
    expect(updated.status).toBe('ready');
    const finalContent = await readFile(join(updated.worktree, 'feature.js'), 'utf8');
    expect(finalContent).toBe('module.exports = "resolved combined";\n');
    expect(finalContent).not.toContain('<<<<<<<');
    const lastCommit = sh(updated.worktree, 'log', '-1', '--format=%s');
    expect(lastCommit).toContain('Merge origin/staging');

    const pushed = await runs.push(run.id);
    expect(pushed.status).toBe('pushed');
  }, 30_000);

  it('fails revise if agent leaves conflict markers in the file', async () => {
    let callCount = 0;
    const runs = new CoderRuns({
      dataDir: join(tmp, 'coder'),
      servicesRoot: async () => services,
      jira: async () => jira,
      runAi: (_sel, prompt, opts) => {
        callCount++;
        return {
          cancel: () => {},
          done: (async () => {
            if (callCount === 1) {
              await writeFile(join(opts.cwd, 'feature.js'), 'module.exports = "v1";\n');
              return { reply: 'v1' };
            }
            return { reply: 'I tried but left markers' };
          })(),
        };
      },
    });

    const [run] = await runs.start([req('svc-a', 'Broken conflict resolution')]);
    await until(() => runs.get(run.id)!.status === 'ready', 25_000);

    const seed = join(tmp, 'seed');
    sh(seed, 'checkout', 'staging');
    await writeFile(join(seed, 'feature.js'), 'module.exports = "v2";\n');
    sh(seed, 'add', '-A');
    sh(seed, 'commit', '-m', 'conflict on staging');
    sh(seed, 'push', 'origin', 'staging');

    await runs.revise(run.id, 'selesaikan conflict', { syncTarget: true });
    await until(() => ['ready', 'failed'].includes(runs.get(run.id)!.status), 25_000);

    const updated = runs.get(run.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toContain('Conflict marker masih ditemukan di feature.js');
  }, 30_000);

  it('marks a run as completed with an event note', async () => {
    const { runs } = manager();
    const [run] = await runs.start([req('svc-a', 'Task to complete')]);
    await until(() => runs.get(run.id)!.status === 'ready', 25_000);

    const completed = await runs.markCompleted(run.id, 'MR sudah merged di GitLab.');
    expect(completed.status).toBe('completed');
    expect(completed.finishedAt).toBeTruthy();
    expect(completed.events.some((e) => e.text.includes('MR sudah merged'))).toBe(true);
  });

  it('syncs branch automatically to local Services repo on commit and via syncLocal', async () => {
    const { runs } = manager();
    const [run] = await runs.start([req('svc-a', 'Fitur Auto Sync')]);
    await until(() => runs.get(run.id)!.status === 'ready', 25_000);

    const r = runs.get(run.id)!;
    // Check that the branch now exists in the local repo under services/svc-a
    const localBranches = sh(join(services, 'svc-a'), 'branch', '--list', r.branch);
    expect(localBranches).toContain(r.branch);

    // Call syncLocal explicitly
    const syncRes = await runs.syncLocal(run.id);
    expect(syncRes.synced).toBe(true);
    expect(syncRes.branch).toBe(r.branch);
  });

  it('auto-rescues uncommitted files when agent fails or times out, and syncs branch to local repo', async () => {
    let callCount = 0;
    const runs = new CoderRuns({
      dataDir: join(tmp, 'coder'),
      servicesRoot: async () => services,
      jira: async () => jira,
      runAi: (_sel, _prompt, opts) => {
        callCount++;
        return {
          cancel: () => {},
          done: (async () => {
            if (callCount === 1) {
              await writeFile(join(opts.cwd, 'feature.js'), 'module.exports = "partial work";\n');
              await writeFile(join(opts.cwd, 'rescue.txt'), 'rescued data\n');
              return { reply: '', error: 'Agent execution timed out after 5 minutes.' };
            }
            await writeFile(join(opts.cwd, 'feature.js'), 'module.exports = "resumed work";\n');
            return { reply: 'Selesai: resume berhasil' };
          })(),
        };
      },
    });

    const [run] = await runs.start([req('svc-a', 'Timeout rescue task')]);
    await until(() => runs.get(run.id)!.status === 'failed', 25_000);

    const failed = runs.get(run.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('timed out');
    // Changes should have been auto-rescued and committed!
    expect(failed.headSha).toBeTruthy();
    expect(failed.changedFiles?.length).toBeGreaterThan(0);
    expect(failed.changedFiles?.map((f) => f.path)).toContain('feature.js');
    expect(failed.events.some((e) => e.text.includes('Auto-rescue'))).toBe(true);

    // Branch should also have been synced to the local repository!
    const localBranches = sh(join(services, 'svc-a'), 'branch', '--list', failed.branch);
    expect(localBranches).toContain(failed.branch);

    // Now test resume: continue from the rescued state
    await runs.resume(run.id);
    await until(() => runs.get(run.id)!.status === 'ready', 25_000);

    const resumed = runs.get(run.id)!;
    expect(resumed.status).toBe('ready');
    expect(resumed.revisions).toBe(1);
    expect(resumed.events.some((e) => e.text.includes('Melanjutkan task'))).toBe(true);
  });

  it('copies local .env and .env.test from source repo to agent worktree, and excludes them from git', async () => {
    // Write local .env and .env.test.example in source repo svc-a
    await writeFile(join(services, 'svc-a', '.env'), 'APP_PORT=8080\nDB_PASS=secret\n');
    await writeFile(join(services, 'svc-a', '.env.test.example'), 'TEST_TOKEN=xyz\n');

    const { runs } = manager();
    const [run] = await runs.start([req('svc-a', 'Task requiring env')]);
    await until(() => runs.get(run.id)!.status === 'ready', 25_000);

    const r = runs.get(run.id)!;
    // .env should have been copied from source repo
    expect(existsSync(join(r.worktree, '.env'))).toBe(true);
    expect(await readFile(join(r.worktree, '.env'), 'utf8')).toContain('APP_PORT=8080');

    // .env.test should have been copied from .env.test.example fallback
    expect(existsSync(join(r.worktree, '.env.test'))).toBe(true);
    expect(await readFile(join(r.worktree, '.env.test'), 'utf8')).toContain('TEST_TOKEN=xyz');

    // .env should NOT be in changedFiles or git diff
    expect(r.changedFiles?.map((f) => f.path)).not.toContain('.env');
    expect(r.changedFiles?.map((f) => f.path)).not.toContain('.env.test');
  });

  it('saves AI review on a run and records event note', async () => {
    const { runs } = manager();
    const [run] = await runs.start([req('svc-a', 'Task to review')]);
    await until(() => runs.get(run.id)!.status === 'ready', 25_000);

    const review = {
      at: new Date().toISOString(),
      verdict: 'APPROVE' as const,
      text: '## Ringkasan Perubahan\nBagus\n## Kesimpulan\nVERDICT: APPROVE',
      provider: 'claude',
      model: 'sonnet',
      strictness: 'standard' as const,
    };

    const updated = await runs.saveAiReview(run.id, review);
    expect(updated.aiReview).toEqual(review);
    expect(updated.events.some((e) => e.text.includes('AI Review selesai: APPROVE (claude/sonnet)'))).toBe(true);
  });
});

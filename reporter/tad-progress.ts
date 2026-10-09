/**
 * Scheduled progress report, run on the VPS by a Hermes script-only cron job:
 *
 *   hermes cron create "0 17 * * 1-5" --no-agent --script tad-progress.sh --deliver whatsapp:<id>
 *
 * Reads the snapshot Cockpit uploaded, refreshes Jira statuses (Atlassian Cloud is reachable from
 * the VPS; GitLab is not), and prints the message: Hermes delivers stdout verbatim, empty stdout
 * is a silent tick and a non-zero exit becomes an error alert. No AI involved.
 *
 * Files under $TAD_PROGRESS_HOME (default ~/.hermes/tad-progress):
 *   latest.json   snapshot from Cockpit        .env        optional JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 *   state.json    peaks + last report          history/    snapshots that were reported
 *
 * Flags: --preview (print, change nothing), --json (print { text, meta } for Cockpit).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JiraIssue } from '../src/lib/jira/types.ts';
import { applyIssueRefresh, isSnapshot, renderScheduledReport, snapshotJiraKeys, type ProgressSnapshot } from '../src/lib/report/snapshot.ts';

process.env.TZ = 'Asia/Jakarta';

const HOME = process.env.TAD_PROGRESS_HOME || join(homedir(), '.hermes', 'tad-progress');
const KEEP_HISTORY = 60;
const preview = process.argv.includes('--preview');
const asJson = process.argv.includes('--json');

interface State {
  peaks: Record<string, number>;
  lastReport?: { at: string; snapshotFile: string };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** Status, category and assignee for the keys, from Jira Cloud's /search/jql (batched). */
async function fetchJira(env: Record<string, string>, keys: string[]): Promise<Record<string, Pick<JiraIssue, 'status' | 'statusCategory' | 'assignee'>>> {
  const base = env.JIRA_BASE_URL?.replace(/\/+$/, '');
  if (!base || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) throw new Error('kredensial Jira belum diatur di .env');
  const auth = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`;
  const out: Record<string, Pick<JiraIssue, 'status' | 'statusCategory' | 'assignee'>> = {};
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(`key in (${batch.join(',')})`)}&maxResults=100&fields=status,assignee`;
    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Jira HTTP ${res.status}`);
    const data = (await res.json()) as { issues?: { key: string; fields?: { status?: { name?: string; statusCategory?: { key?: string } }; assignee?: { displayName?: string } } }[] };
    for (const it of data.issues ?? []) {
      out[it.key] = {
        status: it.fields?.status?.name ?? 'Unknown',
        statusCategory: it.fields?.status?.statusCategory?.key,
        assignee: it.fields?.assignee?.displayName ? { displayName: it.fields.assignee.displayName } : undefined,
      };
    }
  }
  return out;
}

async function main() {
  const latest = readJson<unknown>(join(HOME, 'latest.json'));
  if (!isSnapshot(latest)) {
    const msg = '⚠️ Laporan progres belum bisa dibuat: belum ada data dari Cockpit di VPS. Buka Cockpit → Proyek → Laporan Terjadwal → Sinkron sekarang.';
    console.log(asJson ? JSON.stringify({ text: msg, meta: { error: 'no-snapshot' } }) : msg);
    return;
  }
  const state: State = readJson<State>(join(HOME, 'state.json')) ?? { peaks: {} };
  const previous = state.lastReport ? readJson<ProgressSnapshot>(join(HOME, 'history', state.lastReport.snapshotFile)) : undefined;
  const env = { ...loadEnv(join(HOME, '.env')), ...process.env } as Record<string, string>;

  let snapshot: ProgressSnapshot = latest;
  let jiraRefreshedAt: string | undefined;
  let jiraError: string | undefined;
  const keys = snapshotJiraKeys(snapshot);
  if (keys.length && env.JIRA_API_TOKEN) {
    try {
      snapshot = applyIssueRefresh(snapshot, await fetchJira(env, keys));
      jiraRefreshedAt = new Date().toISOString();
    } catch (e) {
      jiraError = (e as Error).message;
    }
  }

  const now = new Date();
  const { text, peaks } = renderScheduledReport(snapshot, { now, previous: isSnapshot(previous) ? previous : null, peaks: state.peaks, jiraRefreshedAt, jiraError });

  if (!preview && text) {
    mkdirSync(join(HOME, 'history'), { recursive: true, mode: 0o700 });
    const file = `${now.toISOString().replace(/[:.]/g, '-')}.json`;
    writeAtomic(join(HOME, 'history', file), JSON.stringify(snapshot));
    const old = readdirSync(join(HOME, 'history')).filter((f) => f.endsWith('.json')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_HISTORY))) rmSync(join(HOME, 'history', f), { force: true });
    writeAtomic(join(HOME, 'state.json'), JSON.stringify({ peaks, lastReport: { at: now.toISOString(), snapshotFile: file } } satisfies State, null, 2));
  }

  console.log(asJson ? JSON.stringify({ text, meta: { generatedAt: snapshot.generatedAt, jiraRefreshedAt, jiraError, previousAt: state.lastReport?.at } }) : text);
}

main().catch((e) => {
  console.error(`tad-progress gagal: ${(e as Error).message}`);
  process.exit(1);
});

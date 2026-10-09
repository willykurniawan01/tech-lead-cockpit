/**
 * Jira tickets for TAD tasks that have none yet (tasks added when the scope changed).
 *
 * The defaults for a new ticket copy the tickets the TAD already has (project, issue type, epic,
 * labels, components), so new tasks land where the earlier ones are. Before creating, an issue with
 * the same summary is looked up, so a ticket someone already made by hand is linked, not duplicated.
 */
import type { AuditEvent } from '../src/lib/confluence/api-types.ts';
import type { TadTicketRequest, TadTicketResult, TadTicketTemplate } from '../src/lib/jira/types.ts';
import type { JiraClient } from './jira.ts';

export class TadTicketError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const PROJECT = /^[A-Z][A-Z0-9]{1,9}$/;
const ISSUE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const MAX_ITEMS = 50;

const mostCommon = (values: string[]): string | undefined => {
  const n = new Map<string, number>();
  for (const v of values) if (v) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** Values shared by the TAD's existing tickets: the most common project/type/epic, and labels/components most of them carry. */
export function templateFromIssues(raw: any[]): TadTicketTemplate {
  const f = raw.map((i) => ({ key: String(i.key), ...(i.fields ?? {}) }));
  const projectKey = mostCommon(f.map((x) => x.project?.key ?? String(x.key).split('-')[0]));
  const inProject = f.filter((x) => (x.project?.key ?? x.key.split('-')[0]) === projectKey);
  const issueType = mostCommon(inProject.filter((x) => !x.issuetype?.subtask).map((x) => x.issuetype?.name ?? ''));
  const parentKey = mostCommon(inProject.map((x) => x.parent?.key ?? ''));
  const parentOf = inProject.find((x) => x.parent?.key === parentKey)?.parent;
  const shared = (pick: (x: any) => string[]) => {
    const count = new Map<string, number>();
    for (const x of inProject) for (const v of new Set(pick(x))) count.set(v, (count.get(v) ?? 0) + 1);
    return [...count.entries()].filter(([, c]) => c * 2 > inProject.length).map(([v]) => v);
  };
  return {
    projectKey,
    issueType,
    parent: parentKey ? { key: parentKey, summary: String(parentOf?.fields?.summary ?? '') } : undefined,
    labels: shared((x) => (x.labels ?? []).map(String)),
    components: shared((x) => (x.components ?? []).map((c: any) => String(c.name))),
    basedOn: inProject.map((x) => x.key),
  };
}

export async function ticketTemplate(client: JiraClient, keys: string[]): Promise<TadTicketTemplate> {
  const valid = [...new Set(keys.map((k) => k.trim().toUpperCase()))].filter((k) => ISSUE.test(k)).slice(0, 100);
  if (!valid.length) return { labels: [], components: [], basedOn: [] };
  const raw = await client.searchRaw(`key in (${valid.join(',')})`, ['project', 'issuetype', 'parent', 'labels', 'components'], valid.length);
  return templateFromIssues(raw);
}

const normSummary = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** JQL text search treats these as operators; the exact comparison happens afterwards. */
const jqlText = (s: string) =>
  s
    .replace(/[[\]{}()+\-&|!^~*?:\\/"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

async function existingBySummary(client: JiraClient, projectKey: string, summary: string): Promise<string | undefined> {
  const text = jqlText(summary);
  if (!text) return undefined;
  const raw = await client.searchRaw(`project = ${projectKey} AND summary ~ "${text}" ORDER BY created DESC`, ['summary'], 20);
  return raw.find((i) => normSummary(String(i.fields?.summary ?? '')) === normSummary(summary))?.key;
}

export function validateTicketRequest(body: Partial<TadTicketRequest>): TadTicketRequest {
  const projectKey = String(body.projectKey ?? '')
    .trim()
    .toUpperCase();
  if (!PROJECT.test(projectKey)) throw new TadTicketError('Project key Jira tidak valid.');
  const issueType = String(body.issueType ?? '').trim();
  if (!issueType) throw new TadTicketError('Tipe issue wajib dipilih.');
  const parentKey =
    String(body.parentKey ?? '')
      .trim()
      .toUpperCase() || undefined;
  if (parentKey && !ISSUE.test(parentKey)) throw new TadTicketError(`Parent/epic "${parentKey}" bukan key Jira yang valid.`);
  const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20) : []);
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((i) => ({
      title: String(i?.title ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 255),
      description: String(i?.description ?? '').slice(0, 30_000),
    }))
    .filter((i) => i.title);
  if (!items.length) throw new TadTicketError('Tidak ada task yang dipilih.');
  if (items.length > MAX_ITEMS) throw new TadTicketError(`Maksimal ${MAX_ITEMS} tiket sekali buat.`);
  return {
    projectKey,
    issueType,
    parentKey,
    labels: list(body.labels).map((l) => l.replace(/\s+/g, '-')),
    components: list(body.components),
    items,
  };
}

/** Creates (or links) one ticket per item, one at a time, so a failure stops nothing else. */
export async function createTadTickets(client: JiraClient, req: TadTicketRequest, audit?: (event: AuditEvent) => Promise<void>): Promise<TadTicketResult[]> {
  const out: TadTicketResult[] = [];
  for (const item of req.items) {
    try {
      const found = await existingBySummary(client, req.projectKey, item.title).catch(() => undefined);
      if (found) {
        out.push({
          title: item.title,
          key: found,
          url: client.browseUrl(found),
          existed: true,
        });
        continue;
      }
      const made = await client.createIssue({
        projectKey: req.projectKey,
        issueType: req.issueType,
        summary: item.title,
        description: item.description,
        parentKey: req.parentKey,
        labels: req.labels,
        components: req.components,
      });
      out.push({ title: item.title, key: made.key, url: made.url });
    } catch (e) {
      out.push({ title: item.title, error: (e as Error).message });
    }
  }
  const created = out.filter((r) => r.key && !r.existed).map((r) => r.key!);
  const failed = out.filter((r) => r.error);
  if (audit) {
    await audit({
      ts: new Date().toISOString(),
      action: 'jira.create',
      result: failed.length && !created.length ? 'failure' : 'success',
      spaceKey: 'Jira',
      title: `Tiket task TAD di ${req.projectKey}: ${created.length} dibuat, ${out.length - created.length - failed.length} ditautkan, ${failed.length} gagal`,
      attachments: 0,
      jiraKeys: out.flatMap((r) => (r.key ? [r.key] : [])),
      error: failed[0]?.error,
    }).catch(() => {});
  }
  return out;
}

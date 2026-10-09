export type JiraFlavor = 'cloud' | 'datacenter';

export interface JiraConfig {
  baseUrl: string;
  flavor: JiraFlavor;
  auth: 'basic' | 'bearer';
  email?: string;
  token: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  avatarUrl?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  statusColor?: string;
  issueType: string;
  issueTypeIconUrl?: string;
  priority?: string;
  priorityIconUrl?: string;
  assignee?: {
    displayName: string;
    emailAddress?: string;
    avatarUrl?: string;
  };
  project?: {
    key: string;
    name: string;
  };
  updated: string;
  url: string;
}

export interface JiraIssueDetail extends JiraIssue {
  description?: string;
  comments?: {
    id: string;
    author: string;
    created: string;
    body: string;
  }[];
  labels?: string[];
  components?: string[];
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
  };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
}

export interface JiraStatus {
  configured: boolean;
  flavor?: JiraFlavor;
  baseUrl?: string;
  auth?: 'basic' | 'bearer';
  email?: string;
  tokenPresent: boolean;
  user?: JiraUser;
  error?: string;
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'unauthorized' | 'not-found' | 'network' | 'upstream' | 'bad-request' | 'conflict',
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

function describeNetworkError(err: unknown): string {
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'Host Jira tidak ditemukan. Pastikan VPN aktif atau URL benar.';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'Koneksi ke Jira gagal. Pastikan VPN aktif.';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || (err as Error)?.name === 'TimeoutError') return 'Timeout menghubungi Jira. Cek koneksi internet atau VPN.';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return 'Sertifikat TLS Jira tidak dipercaya Node. Jalankan dengan NODE_EXTRA_CA_CERTS=/path/ke/ca-internal.pem.';
  }
  return `Gagal menghubungi Jira (${code || (err as Error)?.message || 'unknown'}).`;
}

export function extractTextFromAdf(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) {
    const parts = node.content.map(extractTextFromAdf);
    if (node.type === 'paragraph' || node.type === 'heading') return parts.join('') + '\n\n';
    if (node.type === 'bulletList' || node.type === 'orderedList') return parts.join('\n') + '\n';
    if (node.type === 'listItem') return '- ' + parts.join('').trim();
    return parts.join('');
  }
  return '';
}

/**
 * Plain text → Atlassian Document Format: blank lines split paragraphs, ``` fences become code
 * blocks, "- " lines become bullet lists, other line breaks are kept.
 */
export function textToAdf(text: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  const paragraph = (lines: string[]) => {
    const inline: Record<string, unknown>[] = [];
    lines.forEach((l, i) => {
      if (i) inline.push({ type: 'hardBreak' });
      if (l) inline.push({ type: 'text', text: l });
    });
    if (inline.length) content.push({ type: 'paragraph', content: inline });
  };
  const blocks = text.replace(/\r\n/g, '\n').split(/^```[^\n]*\n([\s\S]*?)^```\s*$/m);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      content.push({ type: 'codeBlock', content: block.trim() ? [{ type: 'text', text: block.replace(/\n$/, '') }] : [] });
      return;
    }
    for (const chunk of block.split(/\n\s*\n/)) {
      const lines = chunk.split('\n').filter((l, idx, a) => !(l === '' && (idx === 0 || idx === a.length - 1)));
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        content.push({ type: 'bulletList', content: lines.map((l) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: l.replace(/^\s*[-*] /, '') }] }] })) });
      } else paragraph(lines);
    }
  });
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

export class JiraClient {
  constructor(private readonly cfg: JiraConfig) {}

  private get base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  private authHeader(): string {
    if (this.cfg.auth === 'basic') {
      return 'Basic ' + Buffer.from(`${this.cfg.email ?? ''}:${this.cfg.token}`).toString('base64');
    }
    return `Bearer ${this.cfg.token}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: this.authHeader(),
          ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new JiraError(describeNetworkError(err), 502, 'network');
    }

    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const detail = await res.text().catch(() => '');
    let message = '';
    try {
      const body = JSON.parse(detail);
      message = body.errorMessages?.join(', ') || body.message || Object.values(body.errors || {}).join(', ') || '';
    } catch {
      message = detail.slice(0, 200);
    }

    if (res.status === 401) throw new JiraError('Token ditolak Jira (401). Perbarui API token di Keychain.', 401, 'unauthorized');
    if (res.status === 403) throw new JiraError(`Akses ditolak Jira (403). ${message}`.trim(), 403, 'unauthorized');
    if (res.status === 404) throw new JiraError(`Tidak ditemukan di Jira (404). ${message}`.trim(), 404, 'not-found');
    throw new JiraError(`Jira ${res.status}: ${message || res.statusText}`, res.status >= 500 ? 502 : 400, res.status >= 500 ? 'upstream' : 'bad-request');
  }

  async currentUser(): Promise<JiraUser> {
    const apiPath = this.cfg.flavor === 'cloud' ? '/rest/api/3/myself' : '/rest/api/2/myself';
    const data = await this.request<any>(apiPath);
    return {
      accountId: data.accountId || data.key || '',
      displayName: data.displayName || data.name || 'User',
      emailAddress: data.emailAddress,
      active: data.active,
      avatarUrl: data.avatarUrls?.['48x48'] || data.avatarUrls?.['32x32'],
    };
  }

  async searchIssues(jql?: string, maxResults = 25): Promise<JiraIssue[]> {
    const query = jql?.trim() || 'assignee = currentUser() ORDER BY updated DESC';
    const apiPath = this.cfg.flavor === 'cloud'
      ? // Cloud removed /rest/api/3/search (HTTP 410, CHANGE-2046); /search/jql is its replacement.
        `/rest/api/3/search/jql?jql=${encodeURIComponent(query)}&maxResults=${maxResults}&fields=summary,status,issuetype,priority,assignee,project,updated`
      : `/rest/api/2/search?jql=${encodeURIComponent(query)}&maxResults=${maxResults}&fields=summary,status,issuetype,priority,assignee,project,updated`;

    const data = await this.request<any>(apiPath);
    const issues = data.issues || [];
    return issues.map((item: any) => this.mapIssue(item));
  }

  private mapUser(u: any): JiraUser {
    return {
      // Cloud identifies users by accountId; Data Center by username, which JQL also accepts.
      accountId: u.accountId || u.name || u.key || '',
      displayName: u.displayName || u.name || 'User',
      emailAddress: u.emailAddress,
      active: u.active,
      avatarUrl: u.avatarUrls?.['48x48'] || u.avatarUrls?.['32x32'],
    };
  }

  /** Users matching a name or email (for linking a developer to Jira). */
  async searchUsers(query: string, maxResults = 20): Promise<JiraUser[]> {
    const q = encodeURIComponent(query.trim());
    const apiPath = this.cfg.flavor === 'cloud' ? `/rest/api/3/user/search?query=${q}&maxResults=${maxResults}` : `/rest/api/2/user/search?username=${q}&maxResults=${maxResults}`;
    const data = await this.request<any[]>(apiPath);
    return (data || []).filter((u) => u.active !== false && u.accountType !== 'app').map((u) => this.mapUser(u));
  }

  /** Users who can be assigned issues in all of these projects. */
  async assignableUsers(projectKeys: string[], maxResults = 200): Promise<JiraUser[]> {
    const keys = encodeURIComponent(projectKeys.join(','));
    const apiPath = `/rest/api/${this.cfg.flavor === 'cloud' ? 3 : 2}/user/assignable/multiProjectSearch?projectKeys=${keys}&maxResults=${maxResults}`;
    const data = await this.request<any[]>(apiPath);
    return (data || []).filter((u) => u.active !== false && u.accountType !== 'app').map((u) => this.mapUser(u));
  }

  /** Issue types that can be created in a project (to pick "Bug"). */
  async issueTypes(projectKey: string): Promise<{ id: string; name: string }[]> {
    const v = this.cfg.flavor === 'cloud' ? 3 : 2;
    const data = await this.request<any>(`/rest/api/${v}/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=50`);
    const list = data?.issueTypes ?? data?.values ?? [];
    return list.filter((t: any) => !t.subtask).map((t: any) => ({ id: String(t.id), name: String(t.name) }));
  }

  /** Creates an issue; the description is plain text (converted to ADF on Cloud). */
  async createIssue(input: {
    projectKey: string;
    issueType: string;
    summary: string;
    description: string;
    priority?: string;
    /** Epic or parent issue. */
    parentKey?: string;
    labels?: string[];
    components?: string[];
  }): Promise<{ key: string; url: string }> {
    const cloud = this.cfg.flavor === 'cloud';
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary,
      description: cloud ? textToAdf(input.description) : input.description,
    };
    if (input.priority) fields.priority = { name: input.priority };
    if (input.parentKey) fields.parent = { key: input.parentKey };
    if (input.labels?.length) fields.labels = input.labels;
    if (input.components?.length) fields.components = input.components.map((name) => ({ name }));
    const data = await this.request<{ key: string }>(`/rest/api/${cloud ? 3 : 2}/issue`, { method: 'POST', body: JSON.stringify({ fields }) });
    return { key: data.key, url: this.browseUrl(data.key) };
  }

  browseUrl(key: string): string {
    return `${this.base}/browse/${key}`;
  }

  /** Raw issues for a JQL with the given fields, following pagination up to `limit`. */
  async searchRaw(jql: string, fields: string[], limit = 500): Promise<any[]> {
    const out: any[] = [];
    const f = encodeURIComponent(fields.join(','));
    const q = encodeURIComponent(jql);
    if (this.cfg.flavor === 'cloud') {
      let token: string | undefined;
      do {
        const data = await this.request<any>(`/rest/api/3/search/jql?jql=${q}&maxResults=100&fields=${f}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`);
        out.push(...(data.issues || []));
        token = data.isLast === false || data.nextPageToken ? data.nextPageToken : undefined;
      } while (token && out.length < limit);
    } else {
      for (let startAt = 0; out.length < limit; startAt += 100) {
        const data = await this.request<any>(`/rest/api/2/search?jql=${q}&maxResults=100&startAt=${startAt}&fields=${f}`);
        out.push(...(data.issues || []));
        if (!data.issues?.length || startAt + 100 >= (data.total ?? 0)) break;
      }
    }
    return out.slice(0, limit);
  }

  async getIssue(issueKey: string): Promise<JiraIssueDetail> {
    const apiPath = this.cfg.flavor === 'cloud'
      ? `/rest/api/3/issue/${encodeURIComponent(issueKey)}`
      : `/rest/api/2/issue/${encodeURIComponent(issueKey)}`;

    const data = await this.request<any>(apiPath);
    const baseIssue = this.mapIssue(data);

    let description = '';
    if (typeof data.fields?.description === 'string') {
      description = data.fields.description;
    } else if (data.fields?.description?.content) {
      description = extractTextFromAdf(data.fields.description).trim();
    }

    const comments = (data.fields?.comment?.comments || []).map((c: any) => ({
      id: c.id,
      author: c.author?.displayName || 'User',
      created: c.created,
      body: typeof c.body === 'string' ? c.body : extractTextFromAdf(c.body).trim(),
    }));

    return {
      ...baseIssue,
      description,
      comments,
      labels: data.fields?.labels || [],
      components: (data.fields?.components || []).map((comp: any) => comp.name),
    };
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const apiPath = `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`;
    const data = await this.request<any>(apiPath);
    return (data.transitions || []).map((t: any) => ({
      id: t.id,
      name: t.name,
      to: { id: t.to?.id, name: t.to?.name },
    }));
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const apiPath = `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`;
    await this.request(apiPath, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }

  async getProjects(): Promise<JiraProject[]> {
    const data = await this.request<any[]>('/rest/api/2/project');
    return (data || []).map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      projectTypeKey: p.projectTypeKey,
    }));
  }

  private mapIssue(item: any): JiraIssue {
    const f = item.fields || {};
    return {
      id: item.id,
      key: item.key,
      summary: f.summary || '',
      status: f.status?.name || 'Unknown',
      // The key ('new' | 'indeterminate' | 'done') is stable; the name is localized display text.
      statusCategory: f.status?.statusCategory?.key,
      statusColor: f.status?.statusCategory?.colorName,
      issueType: f.issuetype?.name || 'Task',
      issueTypeIconUrl: f.issuetype?.iconUrl,
      priority: f.priority?.name,
      priorityIconUrl: f.priority?.iconUrl,
      assignee: f.assignee
        ? {
            displayName: f.assignee.displayName || '',
            emailAddress: f.assignee.emailAddress,
            avatarUrl: f.assignee.avatarUrls?.['32x32'],
          }
        : undefined,
      project: f.project ? { key: f.project.key, name: f.project.name } : undefined,
      updated: f.updated || new Date().toISOString(),
      url: `${this.base}/browse/${item.key}`,
    };
  }
}

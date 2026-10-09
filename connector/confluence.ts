import type { ConnectorError, Flavor, PageInfo, SpaceInfo } from '../src/lib/confluence/api-types.ts';

export interface ConfluenceConfig {
  /** Data Center: https://confluence.corp; Cloud: https://org.atlassian.net/wiki */
  baseUrl: string;
  flavor: Flavor;
  auth: 'basic' | 'bearer';
  email?: string;
  token: string;
}

export class ConfluenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ConnectorError['code'],
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

function describeNetworkError(err: unknown): string {
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'Host Confluence tidak ditemukan. Pastikan VPN aktif dan DNS internal terjangkau.';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'Koneksi ke Confluence gagal. Pastikan VPN aktif.';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || (err as Error)?.name === 'TimeoutError') return 'Timeout menghubungi Confluence. Cek VPN atau proxy.';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return 'Sertifikat TLS Confluence tidak dipercaya Node. Jalankan dengan NODE_EXTRA_CA_CERTS=/path/ke/ca-internal.pem.';
  }
  return `Gagal menghubungi Confluence (${code || (err as Error)?.message || 'unknown'}).`;
}

export class ConfluenceClient {
  constructor(private readonly cfg: ConfluenceConfig) {}

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
      throw new ConfluenceError(describeNetworkError(err), 502, 'network');
    }
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const detail = await res.text().catch(() => '');
    let message = '';
    try {
      const body = JSON.parse(detail);
      message = body.message ?? body.errors?.[0]?.title ?? body.errors?.[0]?.message?.key ?? '';
    } catch {
      message = detail.slice(0, 200);
    }
    if (res.status === 401) throw new ConfluenceError('Token ditolak Confluence (401). Perbarui token di Keychain.', 401, 'unauthorized');
    if (res.status === 403) throw new ConfluenceError(`Akses ditolak (403). ${message}`.trim(), 403, 'unauthorized');
    if (res.status === 404) throw new ConfluenceError(`Tidak ditemukan (404). ${message}`.trim(), 404, 'not-found');
    if (res.status === 409) throw new ConfluenceError(`Konflik versi di Confluence (409). ${message}`.trim(), 409, 'conflict');
    throw new ConfluenceError(`Confluence ${res.status}: ${message || res.statusText}`, res.status >= 500 ? 502 : 400, res.status >= 500 ? 'upstream' : 'bad-request');
  }

  private pageUrl(webui: string | undefined, linksBase?: string): string {
    if (!webui) return this.base;
    const root = (linksBase ?? this.base).replace(/\/+$/, '');
    return root + webui;
  }

  async currentUser(): Promise<string> {
    const u = await this.request<{ displayName?: string; publicName?: string; username?: string }>('/rest/api/user/current');
    return u.displayName ?? u.publicName ?? u.username ?? 'unknown';
  }

  async getSpace(key: string): Promise<SpaceInfo & { id: string }> {
    if (this.cfg.flavor === 'cloud') {
      const r = await this.request<{ results: { id: string; key: string; name: string }[] }>(`/api/v2/spaces?keys=${encodeURIComponent(key)}`);
      const s = r.results[0];
      if (!s) throw new ConfluenceError(`Space "${key}" tidak ditemukan atau tidak bisa diakses.`, 404, 'not-found');
      return { id: s.id, key: s.key, name: s.name };
    }
    const s = await this.request<{ id: number; key: string; name: string }>(`/rest/api/space/${encodeURIComponent(key)}`);
    return { id: String(s.id), key: s.key, name: s.name };
  }

  async getPage(id: string, spaceKey = ''): Promise<PageInfo> {
    if (this.cfg.flavor === 'cloud') {
      const p = await this.request<CloudPage>(`/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`);
      return this.fromCloud(p, spaceKey);
    }
    const p = await this.request<DcPage>(`/rest/api/content/${encodeURIComponent(id)}?expand=version,body.storage,space`);
    return this.fromDc(p);
  }

  /** Current version only (cheap: no body), to notice edits made directly in Confluence. Same v1 API on Cloud and DC. */
  async pageVersion(id: string): Promise<{ version: number; when?: string; by?: string }> {
    const p = await this.request<{ version?: { number?: number; when?: string; by?: { displayName?: string; publicName?: string } } }>(
      `/rest/api/content/${encodeURIComponent(id)}?expand=version`,
    );
    return { version: Number(p.version?.number ?? 0), when: p.version?.when, by: p.version?.by?.displayName ?? p.version?.by?.publicName };
  }

  /** The page body as it was at `version` (the base for merging Confluence edits into a draft). */
  async pageAtVersion(id: string, version: number): Promise<{ version: number; storage: string }> {
    const p = await this.request<{ version?: { number?: number }; body?: { storage?: { value?: string } } }>(
      `/rest/api/content/${encodeURIComponent(id)}?status=historical&version=${version}&expand=body.storage,version`,
    );
    return { version: Number(p.version?.number ?? version), storage: p.body?.storage?.value ?? '' };
  }

  async findPage(spaceKey: string, title: string): Promise<PageInfo | null> {
    if (this.cfg.flavor === 'cloud') {
      const space = await this.getSpace(spaceKey);
      const r = await this.request<{ results: CloudPage[]; _links?: { base?: string } }>(
        `/api/v2/pages?space-id=${space.id}&title=${encodeURIComponent(title)}&body-format=storage&status=current`,
      );
      return r.results[0] ? this.fromCloud(r.results[0], spaceKey, r._links?.base) : null;
    }
    const r = await this.request<{ results: DcPage[] }>(
      `/rest/api/content?type=page&spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&expand=version,body.storage,space`,
    );
    return r.results[0] ? this.fromDc(r.results[0]) : null;
  }

  async createPage(input: { spaceKey: string; title: string; parentId?: string; storage: string }): Promise<PageInfo> {
    if (this.cfg.flavor === 'cloud') {
      const space = await this.getSpace(input.spaceKey);
      const p = await this.request<CloudPage>('/api/v2/pages', {
        method: 'POST',
        body: JSON.stringify({
          spaceId: space.id,
          status: 'current',
          title: input.title,
          ...(input.parentId ? { parentId: input.parentId } : {}),
          body: { representation: 'storage', value: input.storage },
        }),
      });
      return this.fromCloud(p, input.spaceKey);
    }
    const p = await this.request<DcPage>('/rest/api/content?expand=version,space', {
      method: 'POST',
      body: JSON.stringify({
        type: 'page',
        title: input.title,
        space: { key: input.spaceKey },
        ...(input.parentId ? { ancestors: [{ id: input.parentId }] } : {}),
        body: { storage: { value: input.storage, representation: 'storage' } },
      }),
    });
    return this.fromDc(p);
  }

  async updatePage(input: { id: string; spaceKey: string; title: string; storage: string; version: number; message?: string }): Promise<PageInfo> {
    const version = { number: input.version, message: input.message ?? '' };
    if (this.cfg.flavor === 'cloud') {
      const p = await this.request<CloudPage>(`/api/v2/pages/${encodeURIComponent(input.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ id: input.id, status: 'current', title: input.title, body: { representation: 'storage', value: input.storage }, version }),
      });
      return this.fromCloud(p, input.spaceKey);
    }
    const p = await this.request<DcPage>(`/rest/api/content/${encodeURIComponent(input.id)}?expand=version,space`, {
      method: 'PUT',
      body: JSON.stringify({ id: input.id, type: 'page', title: input.title, version, body: { storage: { value: input.storage, representation: 'storage' } } }),
    });
    return this.fromDc(p);
  }

  /** Pages whose title contains `query` (CQL, same v1 endpoint on Cloud and Data Center), newest first. */
  async searchPages(query: string, spaceKey?: string): Promise<PageInfo[]> {
    const esc = (v: string) => v.replace(/["\\]/g, '\\$&');
    let cql = `type=page and title ~ "${esc(query.trim())}"`;
    if (spaceKey?.trim()) cql += ` and space="${esc(spaceKey.trim())}"`;
    cql += ' order by lastmodified desc';
    const r = await this.request<{ results: DcPage[]; _links?: { base?: string } }>(
      `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=20&expand=space,version`,
    );
    return r.results.map((p) => ({ ...this.fromDc({ ...p, _links: { ...p._links, base: p._links?.base ?? r._links?.base } }), storage: undefined }));
  }

  /**
   * Mentions are stored as account ids; look up display names so an imported TAD reads
   * "@Willy kurniawan" instead of an opaque id. Failures leave the mention as-is.
   */
  async withMentionNames(storage: string): Promise<string> {
    const ids = [...new Set([...storage.matchAll(/<ri:user\s+ri:(account-id|userkey)="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`))].slice(0, 25);
    const names = new Map<string, string>();
    await Promise.all(
      ids.map(async (pair) => {
        const [kind, id] = pair.split('=');
        const q = kind === 'account-id' ? `accountId=${encodeURIComponent(id)}` : `key=${encodeURIComponent(id)}`;
        try {
          const u = await this.request<{ displayName?: string; publicName?: string }>(`/rest/api/user?${q}`);
          if (u.displayName || u.publicName) names.set(id, (u.displayName ?? u.publicName)!);
        } catch {
          /* keep the id */
        }
      }),
    );
    return storage.replace(/<ri:user\s+ri:(account-id|userkey)="([^"]+)"/g, (m, _k, id: string) => {
      const n = names.get(id);
      return n ? `${m} data-display-name="${n.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"` : m;
    });
  }

  /**
   * Account ids for exact display names (case-insensitive), to restore `@Name` text as mentions.
   * Cloud only (user search by full name); names with no single exact match are left out.
   */
  async resolveUserNames(names: string[]): Promise<Record<string, string>> {
    if (this.cfg.flavor !== 'cloud') return {};
    const out: Record<string, string> = {};
    await Promise.all(
      [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2 && n.length <= 80 && !/["\\]/.test(n)))].slice(0, 40).map(async (name) => {
        try {
          const cql = encodeURIComponent(`user.fullname~"${name}"`);
          const r = await this.request<{ results?: { user?: { accountId?: string; displayName?: string; publicName?: string } }[] }>(`/rest/api/search/user?cql=${cql}&limit=10`);
          const exact = (r.results ?? []).map((x) => x.user).filter((u) => u?.accountId && [u.displayName, u.publicName].some((n) => n?.trim().toLowerCase() === name.toLowerCase()));
          if (exact.length === 1) out[name] = exact[0]!.accountId!;
        } catch {
          /* unknown name: stays text */
        }
      }),
    );
    return out;
  }

  /** Creates the attachment, or adds a new version if one with the same filename exists. Same v1 API on Cloud and DC. */
  async upsertAttachment(pageId: string, filename: string, data: Buffer, contentType: string): Promise<void> {
    const existing = await this.request<{ results: { id: string }[] }>(
      `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?filename=${encodeURIComponent(filename)}`,
    );
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), filename);
    form.append('minorEdit', 'true');
    const path = existing.results[0]
      ? `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${existing.results[0].id}/data`
      : `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
    await this.request(path, { method: 'POST', body: form, headers: { 'X-Atlassian-Token': 'no-check' } });
  }

  private fromCloud(p: CloudPage, spaceKey: string, linksBase?: string): PageInfo {
    let resolvedSpace = spaceKey;
    if (!resolvedSpace && p._links?.webui) {
      const m = p._links.webui.match(/\/spaces\/([^/]+)/);
      if (m) resolvedSpace = m[1];
    }
    return {
      id: String(p.id),
      title: p.title,
      version: p.version?.number ?? 1,
      url: this.pageUrl(p._links?.webui, linksBase ?? p._links?.base),
      spaceKey: resolvedSpace,
      storage: p.body?.storage?.value,
    };
  }

  private fromDc(p: DcPage): PageInfo {
    return {
      id: String(p.id),
      title: p.title,
      version: p.version?.number ?? 1,
      url: this.pageUrl(p._links?.webui, p._links?.base),
      spaceKey: p.space?.key ?? '',
      storage: p.body?.storage?.value,
    };
  }
}

interface CloudPage {
  id: string;
  title: string;
  version?: { number: number };
  body?: { storage?: { value: string } };
  _links?: { webui?: string; base?: string };
}

interface DcPage {
  id: string;
  title: string;
  version?: { number: number };
  body?: { storage?: { value: string } };
  space?: { key: string };
  _links?: { webui?: string; base?: string };
}

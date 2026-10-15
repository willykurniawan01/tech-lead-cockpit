import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FigmaFetchedSet, FigmaScreen, FigmaScreenList, FigmaUser } from '../src/lib/figma/types.ts';

/**
 * Figma for the TAD generator: Cockpit itself reads the design through the Figma REST API (personal
 * access token in the Keychain) and writes screenshots plus the on-screen text into the draft's AI
 * workspace under figma/. The AI then reads plain files, so it needs no Figma tool permission and it
 * works the same for every provider. Read-only: nothing is ever written to Figma.
 */

export const FIGMA_API = 'https://api.figma.com';
/** More screens per fetch costs tokens and Figma's render quota; pick the relevant ones instead. */
export const MAX_SCREENS_PER_FETCH = 30;
/** Long edge of a rendered screen; vision models downscale anything larger anyway. */
export const TARGET_LONG_EDGE = 1568;
const IMAGE_BATCH = 8;
const NODE_BATCH = 5;
const MAX_TEXT_LINES = 400;
const MAX_TEXT_CHARS = 300;
const MAX_RETRY_WAIT_MS = 30_000;
/** A link map is reused this long (Figma's API quota per seat can be tiny). */
const MAP_TTL_MS = 24 * 60 * 60 * 1000;

export class FigmaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'unauthorized' | 'not-found' | 'bad-request' | 'network' | 'upstream' | 'not-configured' = 'upstream',
  ) {
    super(message);
  }
}

// URL --------------------------------------------------------------------------------------

export interface FigmaRef {
  fileKey: string;
  /** API form (1:2); undefined when the link points at the whole file. */
  nodeId?: string;
}

/**
 * Accepts figma.com/file|design|proto|board/<key>/…, including branch links
 * (/design/<key>/branch/<branchKey>/…, where the branch key is the file to read). node-id comes as
 * 1-2 in new links and 1:2 (often %3A) in old ones.
 */
export function parseFigmaUrl(raw: string): FigmaRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/(^|\.)figma\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !['file', 'design', 'proto', 'board'].includes(parts[0])) return null;
  let fileKey = parts[1];
  if (parts[2] === 'branch' && parts[3]) fileKey = parts[3];
  if (!/^[A-Za-z0-9]{10,64}$/.test(fileKey)) return null;
  const rawNode = u.searchParams.get('node-id')?.trim();
  const nodeId = rawNode ? rawNode.replace(/-/g, ':') : undefined;
  if (nodeId && !/^[A-Za-z0-9:;]+$/.test(nodeId)) return null;
  return { fileKey, nodeId };
}

// Client -----------------------------------------------------------------------------------

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  characters?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  children?: FigmaNode[];
}

interface NodesResponse {
  name: string;
  lastModified: string;
  version: string;
  nodes: Record<string, { document: FigmaNode } | null>;
}

interface FileResponse {
  name: string;
  lastModified: string;
  version: string;
  document: FigmaNode;
}

export interface FigmaClientOptions {
  token: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export class FigmaClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: FigmaClientOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  me(): Promise<FigmaUser> {
    return this.get<{ id: string; handle: string; email?: string }>('/v1/me').then((u) => ({ id: u.id, handle: u.handle, email: u.email }));
  }

  /** depth limits how far below each node the tree goes (undefined = everything). */
  nodes(fileKey: string, ids: string[], depth?: number): Promise<NodesResponse> {
    const q = new URLSearchParams({ ids: ids.join(',') });
    if (depth !== undefined) q.set('depth', String(depth));
    return this.get<NodesResponse>(`/v1/files/${fileKey}/nodes?${q}`);
  }

  file(fileKey: string, depth: number): Promise<FileResponse> {
    return this.get<FileResponse>(`/v1/files/${fileKey}?depth=${depth}`);
  }

  /** The document trimmed to the path from the root to `ids` (and their children, within depth). */
  fileAround(fileKey: string, ids: string[], depth: number): Promise<FileResponse> {
    return this.get<FileResponse>(`/v1/files/${fileKey}?${new URLSearchParams({ ids: ids.join(','), depth: String(depth) })}`);
  }

  /** Temporary render URLs (PNG) per node id; null where Figma could not render the node. */
  images(fileKey: string, ids: string[], scale: number): Promise<Record<string, string | null>> {
    const q = new URLSearchParams({ ids: ids.join(','), format: 'png', scale: String(scale) });
    return this.get<{ err?: string | null; images: Record<string, string | null> }>(`/v1/images/${fileKey}?${q}`).then((r) => {
      if (r.err) throw new FigmaError(`Figma gagal merender layar: ${r.err}`, 502, 'upstream');
      return r.images ?? {};
    });
  }

  /** Downloads a render (a pre-signed URL: no token is sent to it). */
  async download(url: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch {
      throw new FigmaError('Gagal mengunduh gambar layar dari Figma.', 502, 'network');
    }
    if (!res.ok) throw new FigmaError(`Gagal mengunduh gambar layar (HTTP ${res.status}).`, 502, 'upstream');
    return Buffer.from(await res.arrayBuffer());
  }

  private async get<T>(path: string, attempt = 0): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${FIGMA_API}${path}`, { headers: { 'X-Figma-Token': this.opts.token } });
    } catch {
      throw new FigmaError('Tidak bisa menghubungi api.figma.com. Periksa koneksi internet.', 502, 'network');
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    // A short burst limit is waited out; a quota that resets in hours is reported at once.
    if (res.status === 429 && attempt < 2 && !(retryAfter * 1000 > MAX_RETRY_WAIT_MS)) {
      const after = retryAfter;
      await this.sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 5_000 * (attempt + 1), MAX_RETRY_WAIT_MS));
      return this.get<T>(path, attempt + 1);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { err?: string; message?: string };
      const detail = body.err ?? body.message ?? '';
      if (res.status === 401 || res.status === 403) {
        throw new FigmaError(
          /token/i.test(detail) || res.status === 401
            ? 'Token Figma tidak valid atau sudah kedaluwarsa. Buat token baru lalu simpan lewat Setup.'
            : 'Token Figma tidak punya akses ke file ini. Pastikan akun pemilik token bisa membuka file tersebut.',
          401,
          'unauthorized',
        );
      }
      if (res.status === 404) throw new FigmaError('File atau frame Figma tidak ditemukan. Periksa link-nya.', 404, 'not-found');
      if (res.status === 429) {
        // Figma says which limit and for how long; a long wait means a plan/seat quota, not a burst.
        const after = Number(res.headers.get('retry-after'));
        const kind = [res.headers.get('x-figma-rate-limit-type'), res.headers.get('x-figma-plan-tier')].filter(Boolean).join(', ');
        const wait = Number.isFinite(after) && after > 0 ? (after >= 3600 ? `sekitar ${Math.ceil(after / 3600)} jam` : `${Math.ceil(after / 60)} menit`) : 'beberapa menit';
        throw new FigmaError(`Batas request Figma tercapai${kind ? ` (${kind})` : ''}. Coba lagi ${wait} lagi, atau ambil lebih sedikit layar.`, 429, 'upstream');
      }
      throw new FigmaError(`Figma API error (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`, 502, 'upstream');
    }
    return (await res.json()) as T;
  }
}

// Screens ----------------------------------------------------------------------------------

const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
const CONTAINER_TYPES = new Set(['CANVAS', 'SECTION', 'GROUP']);
/** A child frame at least this big inside a frame reads as a screen, not a layout box. */
const MIN_SCREEN_EDGE = 320;

function toScreen(n: FigmaNode, parent?: string): FigmaScreen {
  const box = n.absoluteBoundingBox;
  return { id: n.id, name: n.name, type: n.type, width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0), parent };
}

function looksLikeScreen(n: FigmaNode): boolean {
  const box = n.absoluteBoundingBox;
  return SCREEN_TYPES.has(n.type) && n.visible !== false && Boolean(box && box.width >= MIN_SCREEN_EDGE && box.height >= MIN_SCREEN_EDGE);
}

/** Frames directly under a container, opening nested sections and groups. */
function screensUnder(node: FigmaNode, parent?: string, out: FigmaScreen[] = []): FigmaScreen[] {
  for (const c of node.children ?? []) {
    if (c.visible === false) continue;
    if (CONTAINER_TYPES.has(c.type)) screensUnder(c, c.name, out);
    else if (SCREEN_TYPES.has(c.type)) out.push(toScreen(c, parent));
  }
  return out;
}

/**
 * The choices offered for a link: the node itself plus the screens inside it. Pages, sections and
 * groups preselect their frames; a frame preselects its child frames only when they look like
 * screens (two or more, each at least 320px), otherwise the frame itself.
 */
export function screenChoices(node: FigmaNode): { screens: FigmaScreen[]; selected: string[] } {
  if (CONTAINER_TYPES.has(node.type)) {
    const screens = screensUnder(node, node.type === 'CANVAS' ? undefined : node.name);
    return { screens, selected: screens.map((s) => s.id) };
  }
  const self = toScreen(node);
  const inner = (node.children ?? []).filter(looksLikeScreen).map((c) => toScreen(c, node.name));
  if (inner.length >= 2) return { screens: [self, ...inner], selected: inner.map((s) => s.id) };
  return { screens: [self], selected: [self.id] };
}

/** Visible text in reading order (top to bottom, then left to right), deduplicated and capped. */
export function extractTexts(node: FigmaNode): string[] {
  const found: { text: string; x: number; y: number }[] = [];
  const walk = (n: FigmaNode) => {
    if (n.visible === false) return;
    if (n.type === 'TEXT' && n.characters?.trim()) {
      found.push({ text: n.characters.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS), x: n.absoluteBoundingBox?.x ?? 0, y: n.absoluteBoundingBox?.y ?? 0 });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  found.sort((a, b) => (Math.abs(a.y - b.y) <= 8 ? a.x - b.x : a.y - b.y));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    if (seen.has(f.text)) continue;
    seen.add(f.text);
    out.push(f.text);
    if (out.length >= MAX_TEXT_LINES) break;
  }
  return out;
}

/** Render scale so the long edge lands near TARGET_LONG_EDGE (Figma accepts 0.01–4). */
export function scaleFor(width: number, height: number): number {
  const edge = Math.max(width, height);
  if (!edge) return 1;
  const raw = TARGET_LONG_EDGE / edge;
  const steps = [0.25, 0.5, 0.75, 1, 1.5, 2];
  return steps.reduce((best, s) => (s <= raw && s > best ? s : best), 0.25);
}

export function slug(text: string, max = 50): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'layar';
}

export function setIdFor(ref: FigmaRef): string {
  return `${ref.fileKey}_${(ref.nodeId ?? 'file').replace(/[:;]/g, '-')}`.replace(/[^A-Za-z0-9_-]/g, '');
}

const isSetId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id);
const isImageName = (name: string) => /^\d{2}-[a-z0-9-]{1,60}\.png$/.test(name);

// Map around a link ------------------------------------------------------------------------

/** Root → … → the node, or null when it is not in the (trimmed) tree. */
export function findPath(root: FigmaNode, id: string): FigmaNode[] | null {
  if (root.id === id) return [root];
  for (const c of root.children ?? []) {
    const p = findPath(c, id);
    if (p) return [root, ...p];
  }
  return null;
}

const center = (n: FigmaNode) => (n.absoluteBoundingBox ? { x: n.absoluteBoundingBox.x + n.absoluteBoundingBox.width / 2, y: n.absoluteBoundingBox.y + n.absoluteBoundingBox.height / 2 } : undefined);

/** Siblings nearest to the target on the canvas first (a flow title sits above or beside its screens). */
export function nearestSiblings(siblings: FigmaNode[], target: FigmaNode, max: number): FigmaNode[] {
  const t = center(target);
  const dist = (n: FigmaNode) => {
    const c = center(n);
    return t && c ? Math.hypot(c.x - t.x, c.y - t.y) : Number.MAX_SAFE_INTEGER;
  };
  return siblings.filter((s) => s.visible !== false).sort((a, b) => dist(a) - dist(b)).slice(0, max);
}

export interface FigmaLinkMap {
  fileKey: string;
  fileName: string;
  version: string;
  nodeId?: string;
  path: { id: string; name: string; type: string }[];
  /** The node's own children (screens under a section/frame). */
  inside: FigmaNode[];
  /** Nodes next to it under the same parent, nearest first. */
  around: FigmaNode[];
  /** Pages of the file (for a whole-file link). */
  pages?: { id: string; name: string; frames: FigmaNode[] }[];
}

const size = (n: FigmaNode) => (n.absoluteBoundingBox ? ` ${Math.round(n.absoluteBoundingBox.width)}×${Math.round(n.absoluteBoundingBox.height)}` : '');
const nodeUrl = (fileKey: string, id: string) => `https://www.figma.com/design/${fileKey}/?node-id=${id.replace(/:/g, '-')}`;

function nodeLines(fileKey: string, nodes: FigmaNode[], indent = ''): string[] {
  return nodes.flatMap((n) => {
    const kids = (n.children ?? []).filter((c) => c.visible !== false);
    const screens = kids.filter((c) => SCREEN_TYPES.has(c.type) || CONTAINER_TYPES.has(c.type));
    return [
      `${indent}- ${n.type} "${n.name}" — node-id \`${n.id}\`${size(n)}${kids.length ? `, ${kids.length} anak` : ''} (${nodeUrl(fileKey, n.id)})`,
      ...screens.slice(0, 12).map((c) => `${indent}  - ${c.type} "${c.name}" — node-id \`${c.id}\`${size(c)}`),
      ...(screens.length > 12 ? [`${indent}  - … ${screens.length - 12} lainnya (buka node induknya dengan get_metadata)`] : []),
    ];
  });
}

export function linkMapMarkdown(title: string, url: string, m: FigmaLinkMap): string {
  const target = m.path.at(-1);
  return [
    `# Peta Figma: ${title}`,
    '',
    `Link: ${url}`,
    `File: ${m.fileName} · fileKey \`${m.fileKey}\` · versi ${m.version}`,
    '',
    'Dibuat Cockpit lewat Figma REST API (hanya baca). Pakai fileKey dan node-id di bawah dengan get_metadata / get_screenshot / get_design_context untuk membuka layar mana pun.',
    ...(m.pages
      ? ['', '## Halaman & frame teratas', ...m.pages.flatMap((p) => [`### ${p.name} (node-id \`${p.id}\`)`, ...nodeLines(m.fileKey, p.frames)])]
      : [
          '',
          '## Letak node di link',
          m.path.map((p) => `${p.type} "${p.name}" (\`${p.id}\`)`).join(' → '),
          '',
          `## Isi node "${target?.name ?? ''}"`,
          ...(m.inside.length ? nodeLines(m.fileKey, m.inside) : ['(tidak ada anak; node ini kemungkinan hanya judul/label, cari layarnya di bagian berikut)']),
          '',
          `## Di sekitarnya (anak dari "${m.path.at(-2)?.name ?? ''}", terdekat dulu)`,
          ...(m.around.length ? nodeLines(m.fileKey, m.around) : ['(tidak ada)']),
        ]),
    '',
  ].join('\n');
}

// Manager ----------------------------------------------------------------------------------

export interface FigmaManagerOptions {
  readToken: () => Promise<string | null>;
  /** Draft AI workspace (validated draft id); figma/ goes inside it. */
  workspaceFor: (draftId: string) => string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface FetchScreensInput {
  draftId: string;
  url: string;
  title?: string;
  screenIds: string[];
}

export class FigmaManager {
  constructor(private readonly opts: FigmaManagerOptions) {}

  async client(token?: string): Promise<FigmaClient> {
    const t = token ?? (await this.opts.readToken());
    if (!t) throw new FigmaError('Token Figma belum disimpan. Buka Setup → Figma.', 400, 'not-configured');
    return new FigmaClient({ token: t, fetch: this.opts.fetch, sleep: this.opts.sleep });
  }

  async status(): Promise<{ configured: boolean; tokenPresent: boolean; user?: FigmaUser; error?: string }> {
    const token = await this.opts.readToken();
    if (!token) return { configured: false, tokenPresent: false, error: 'Token Figma belum disimpan.' };
    try {
      return { configured: true, tokenPresent: true, user: await (await this.client(token)).me() };
    } catch (e) {
      return { configured: false, tokenPresent: true, error: (e as Error).message };
    }
  }

  /** Validates a token against Figma; the caller saves it only when this succeeds. */
  async verifyToken(token: string): Promise<FigmaUser> {
    return (await this.client(token)).me();
  }

  /**
   * The structure around a link: where the node sits (page → section → …), what is inside it and
   * what lies next to it. A link to a flow's title bar still leads the AI to the screens below it.
   */
  async mapLink(url: string): Promise<FigmaLinkMap> {
    const ref = parseFigmaUrl(url);
    if (!ref) throw new FigmaError('Link Figma tidak dikenali.', 400, 'bad-request');
    const client = await this.client();
    if (!ref.nodeId) {
      const file = await client.file(ref.fileKey, 2);
      const pages = (file.document.children ?? []).map((p) => ({ id: p.id, name: p.name, frames: (p.children ?? []).filter((c) => c.visible !== false).slice(0, 40) }));
      return { fileKey: ref.fileKey, fileName: file.name, version: file.version, path: [], inside: [], around: [], pages };
    }
    // The trimmed tree only reaches the node within `depth` levels; go deeper until it shows.
    let path: FigmaNode[] | null = null;
    let meta: { name: string; version: string } = { name: '', version: '' };
    for (const depth of [4, 7, 11]) {
      const res = await client.fileAround(ref.fileKey, [ref.nodeId], depth);
      meta = res;
      path = findPath(res.document, ref.nodeId);
      if (path) break;
    }
    if (!path) throw new FigmaError('Node di link itu tidak ditemukan di file (mungkin sudah dihapus atau dipindah).', 404, 'not-found');
    const target = path.at(-1)!;
    const parent = path.at(-2);
    const self = (await client.nodes(ref.fileKey, [ref.nodeId], 2)).nodes[ref.nodeId]?.document ?? target;
    // A page can hold hundreds of frames: only one level there, two under a section or frame.
    const siblings = parent && parent.type !== 'DOCUMENT' ? ((await client.nodes(ref.fileKey, [parent.id], parent.type === 'CANVAS' ? 1 : 2)).nodes[parent.id]?.document?.children ?? []) : [];
    return {
      fileKey: ref.fileKey,
      fileName: meta.name,
      version: meta.version,
      nodeId: ref.nodeId,
      path: path.filter((n) => n.type !== 'DOCUMENT').map((n) => ({ id: n.id, name: n.name, type: n.type })),
      inside: (self.children ?? []).filter((c) => c.visible !== false).slice(0, 40),
      around: nearestSiblings(siblings.filter((s) => s.id !== ref.nodeId), self, 30),
    };
  }

  /**
   * Writes figma-map/<set>.md into the draft's AI workspace for each link (best effort: a link that
   * fails gets a note instead). Returns the files written.
   */
  async writeLinkMaps(draftId: string, links: { title?: string; url: string }[]): Promise<string[]> {
    if (!(await this.opts.readToken())) return [];
    const dir = join(this.opts.workspaceFor(draftId), 'figma-map');
    await mkdir(dir, { recursive: true });
    const wanted = new Map<string, { title?: string; url: string }>(links.slice(0, 10).flatMap((l) => (parseFigmaUrl(l.url) ? [[`${setIdFor(parseFigmaUrl(l.url)!)}.md`, l] as const] : [])));
    // Maps of links no longer in the draft go.
    for (const old of await readdir(dir).catch(() => [] as string[])) if (!wanted.has(old)) await rm(join(dir, old), { force: true });
    const written: string[] = [];
    let limited = '';
    for (const [name, link] of wanted) {
      const file = join(dir, name);
      // Figma's API quota is small (a View/Collab seat gets a handful of calls): a map is reused for a day.
      const age = await stat(file).then((s) => (this.opts.now?.() ?? new Date()).getTime() - s.mtimeMs).catch(() => Infinity);
      const current = age < MAP_TTL_MS && !(await readFile(file, 'utf-8').catch(() => '')).includes('Gagal dipetakan');
      if (!current) {
        let body: string;
        try {
          if (limited) throw new FigmaError(limited, 429, 'upstream');
          body = linkMapMarkdown(link.title || name, link.url, await this.mapLink(link.url));
        } catch (e) {
          // Once Figma says the quota is used up, the other links are not tried.
          if (e instanceof FigmaError && e.status === 429) limited = e.message;
          body = `# Peta Figma: ${link.title || name}\n\nLink: ${link.url}\n\nGagal dipetakan: ${(e as Error).message}\n`;
        }
        await writeFile(file, body, 'utf-8');
      }
      written.push(`figma-map/${name}`);
    }
    return written;
  }

  async listScreens(url: string): Promise<FigmaScreenList> {
    const ref = parseFigmaUrl(url);
    if (!ref) throw new FigmaError('Link Figma tidak dikenali. Salin link file atau frame dari Figma (Share → Copy link).', 400, 'bad-request');
    const client = await this.client();
    if (!ref.nodeId) {
      // Whole file: every page's top-level frames (pages themselves cannot be rendered).
      const file = await client.file(ref.fileKey, 2);
      const screens = (file.document.children ?? []).flatMap((page) => screensUnder(page, page.name));
      return { fileKey: ref.fileKey, fileName: file.name, nodeName: file.name, version: file.version, lastModified: file.lastModified, screens, selected: [], wholeFile: true };
    }
    const res = await client.nodes(ref.fileKey, [ref.nodeId], 3);
    const node = res.nodes[ref.nodeId]?.document;
    if (!node) throw new FigmaError('Frame di link itu tidak ditemukan (mungkin sudah dihapus atau dipindah).', 404, 'not-found');
    const { screens, selected } = screenChoices(node);
    return { fileKey: ref.fileKey, nodeId: ref.nodeId, fileName: res.name, nodeName: node.name, version: res.version, lastModified: res.lastModified, screens, selected };
  }

  /** Renders the chosen screens and writes figma/<set>/ (replacing an earlier fetch of the same link). */
  async fetchScreens(input: FetchScreensInput): Promise<FigmaFetchedSet> {
    const ref = parseFigmaUrl(input.url);
    if (!ref) throw new FigmaError('Link Figma tidak dikenali.', 400, 'bad-request');
    const ids = [...new Set((input.screenIds ?? []).map(String).filter((id) => /^[A-Za-z0-9:;]+$/.test(id)))];
    if (!ids.length) throw new FigmaError('Pilih minimal satu layar.', 400, 'bad-request');
    if (ids.length > MAX_SCREENS_PER_FETCH) throw new FigmaError(`Maksimal ${MAX_SCREENS_PER_FETCH} layar sekali ambil. Pilih layar yang relevan saja.`, 400, 'bad-request');
    const client = await this.client();

    let meta: { name: string; version: string; lastModified: string } | undefined;
    const nodes = new Map<string, FigmaNode>();
    for (let i = 0; i < ids.length; i += NODE_BATCH) {
      const res = await client.nodes(ref.fileKey, ids.slice(i, i + NODE_BATCH));
      meta ??= { name: res.name, version: res.version, lastModified: res.lastModified };
      for (const [id, n] of Object.entries(res.nodes)) if (n?.document) nodes.set(id, n.document);
    }
    const ordered = ids.map((id) => nodes.get(id)).filter((n): n is FigmaNode => Boolean(n));
    if (!ordered.length) throw new FigmaError('Layar yang dipilih tidak ditemukan di Figma.', 404, 'not-found');

    const byScale = new Map<number, string[]>();
    for (const n of ordered) {
      const s = scaleFor(n.absoluteBoundingBox?.width ?? 0, n.absoluteBoundingBox?.height ?? 0);
      byScale.set(s, [...(byScale.get(s) ?? []), n.id]);
    }
    const renders: Record<string, string | null> = {};
    for (const [scale, group] of byScale) {
      for (let i = 0; i < group.length; i += IMAGE_BATCH) Object.assign(renders, await client.images(ref.fileKey, group.slice(i, i + IMAGE_BATCH), scale));
    }

    const setId = setIdFor(ref);
    const dir = join(this.figmaRoot(input.draftId), setId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const screens: FigmaFetchedSet['screens'] = [];
    const sections: string[] = [];
    for (const [i, n] of ordered.entries()) {
      const texts = extractTexts(n);
      const url = renders[n.id];
      let image: string | undefined;
      if (url) {
        image = `${String(i + 1).padStart(2, '0')}-${slug(n.name)}.png`;
        await writeFile(join(dir, image), await client.download(url), { mode: 0o600 });
      }
      const s = toScreen(n);
      screens.push({ id: n.id, name: n.name, width: s.width, height: s.height, image, textCount: texts.length });
      sections.push(
        [
          `## ${i + 1}. ${n.name}`,
          '',
          image ? `Gambar: figma/${setId}/${image} (${s.width}×${s.height})` : 'Gambar: tidak bisa dirender oleh Figma.',
          '',
          texts.length ? 'Teks di layar (urut dari atas ke bawah):' : 'Tidak ada teks di layar ini.',
          ...texts.map((t) => `- ${t}`),
        ].join('\n'),
      );
    }

    const set: FigmaFetchedSet = {
      id: setId,
      url: input.url.trim(),
      title: input.title?.trim() || undefined,
      fileKey: ref.fileKey,
      nodeId: ref.nodeId,
      fileName: meta?.name ?? '',
      version: meta?.version ?? '',
      lastModified: meta?.lastModified ?? '',
      fetchedAt: (this.opts.now?.() ?? new Date()).toISOString(),
      screens,
    };
    const heading = set.title ? `${set.title} (${set.fileName})` : set.fileName;
    const index = [
      `# Figma: ${heading}`,
      '',
      `- Link: ${set.url}`,
      `- File terakhir diubah: ${set.lastModified} (versi ${set.version})`,
      `- Diambil Cockpit: ${set.fetchedAt}`,
      `- Jumlah layar: ${screens.length}`,
      '',
      'Setiap bagian di bawah adalah satu layar. Buka file gambarnya untuk melihat tampilan; teks di bawahnya adalah seluruh teks yang terlihat di layar itu.',
      '',
      ...sections.flatMap((s) => [s, '']),
    ].join('\n');
    await writeFile(join(dir, 'index.md'), index, { mode: 0o600 });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(set, null, 2), { mode: 0o600 });
    return set;
  }

  async listFetched(draftId: string): Promise<FigmaFetchedSet[]> {
    return readFetchedSets(this.figmaRoot(draftId));
  }

  /** Marks sets whose Figma file changed since the fetch (one light request per file). */
  async checkStale(draftId: string): Promise<FigmaFetchedSet[]> {
    const sets = await this.listFetched(draftId);
    if (!sets.length) return sets;
    const client = await this.client();
    const versions = new Map<string, string | undefined>();
    for (const key of new Set(sets.map((s) => s.fileKey))) {
      versions.set(key, await client.file(key, 1).then((f) => f.version).catch(() => undefined));
    }
    return sets.map((s) => {
      const current = versions.get(s.fileKey);
      return current && current !== s.version ? { ...s, stale: true, currentVersion: current } : s;
    });
  }

  async deleteFetched(draftId: string, setId: string): Promise<FigmaFetchedSet[]> {
    if (!isSetId(setId)) throw new FigmaError('Set Figma tidak valid.', 400, 'bad-request');
    await rm(join(this.figmaRoot(draftId), setId), { recursive: true, force: true });
    return this.listFetched(draftId);
  }

  /** A rendered screen for the thumbnails in the UI. */
  async image(draftId: string, setId: string, name: string): Promise<Buffer> {
    if (!isSetId(setId) || !isImageName(name)) throw new FigmaError('Gambar tidak valid.', 400, 'bad-request');
    try {
      return await readFile(join(this.figmaRoot(draftId), setId, name));
    } catch {
      throw new FigmaError('Gambar tidak ditemukan.', 404, 'not-found');
    }
  }

  private figmaRoot(draftId: string): string {
    return join(this.opts.workspaceFor(draftId), 'figma');
  }
}

/** Sets already in a workspace's figma/ folder (also used by the generator prompt). */
export async function readFetchedSets(figmaDir: string): Promise<FigmaFetchedSet[]> {
  let names: string[];
  try {
    names = await readdir(figmaDir);
  } catch {
    return [];
  }
  const sets: FigmaFetchedSet[] = [];
  for (const name of names) {
    if (!isSetId(name)) continue;
    try {
      sets.push(JSON.parse(await readFile(join(figmaDir, name, 'manifest.json'), 'utf8')) as FigmaFetchedSet);
    } catch {
      /* half-written or foreign folder */
    }
  }
  return sets.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}

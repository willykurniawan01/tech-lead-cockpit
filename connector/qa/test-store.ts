import { ConfluenceError } from '../confluence.ts';
import { ConfluenceQaStore, type ConfluenceApi } from './confluence-store.ts';

/**
 * Tests only: an in-memory Confluence (pages with versions that refuse a stale update with 409,
 * and attachments), and the API Testing store on top of it. Several stores on one fake behave
 * like several laptops sharing the same Confluence space.
 */

/** An in-memory Confluence: pages with versions (409 on a stale update) and attachments. */
export function fakeConfluence() {
  let seq = 100;
  const pages = new Map<string, { id: string; title: string; parent?: string; version: number; storage: string; labels: string[] }>();
  const files = new Map<string, Map<string, { id: string; text: string }>>();
  pages.set('1', { id: '1', title: 'QA', version: 1, storage: '', labels: [] });
  const page = (id: string) => {
    const p = pages.get(id);
    if (!p) throw new ConfluenceError('Tidak ditemukan (404).', 404, 'not-found');
    return p;
  };
  const api: ConfluenceApi & { pages: typeof pages; files: typeof files; calls: number } = {
    pages,
    files,
    calls: 0,
    async getPage(id) {
      api.calls++;
      const p = page(id);
      return { id: p.id, title: p.title, version: p.version, storage: p.storage };
    },
    async childPages(id) {
      api.calls++;
      return [...pages.values()].filter((p) => p.parent === id).map((p) => ({ id: p.id, title: p.title, version: p.version, labels: [...p.labels] }));
    },
    async createPage(input) {
      if ([...pages.values()].some((p) => p.title === input.title)) throw new ConfluenceError('A page with this title already exists.', 400, 'bad-request');
      const id = String(seq++);
      pages.set(id, { id, title: input.title, parent: input.parentId, version: 1, storage: input.storage, labels: [] });
      return { id, version: 1 };
    },
    async updatePage(input) {
      const p = page(input.id);
      if (input.version !== p.version + 1) throw new ConfluenceError('Konflik versi di Confluence (409).', 409, 'conflict');
      if ([...pages.values()].some((x) => x.id !== p.id && x.title === input.title)) throw new ConfluenceError('A page with this title already exists.', 400, 'bad-request');
      p.version = input.version;
      p.storage = input.storage;
      p.title = input.title;
      return { version: p.version };
    },
    async addLabel(id, label) {
      const p = page(id);
      if (!p.labels.includes(label)) p.labels.push(label);
    },
    async attachments(id, filename) {
      return [...(files.get(id)?.entries() ?? [])].filter(([name]) => !filename || name === filename).map(([name, f]) => ({ id: f.id, title: name }));
    },
    async readAttachment(id, filename) {
      return files.get(id)?.get(filename)?.text ?? null;
    },
    async putAttachment(id, filename, data) {
      page(id);
      const map = files.get(id) ?? new Map();
      files.set(id, map);
      map.set(filename, { id: map.get(filename)?.id ?? `att-${seq++}`, text: data.toString('utf8') });
    },
    async deleteAttachment(attId) {
      for (const map of files.values()) for (const [name, f] of map) if (f.id === attId) map.delete(name);
    },
  };
  return api;
}


export const TEST_LOCATION = { spaceKey: 'QA', parentPageId: '1' };

/** A fresh shared Confluence; `store()` is one more app using it. */
export function memoryStore() {
  const confluence = fakeConfluence();
  return { confluence, store: () => new ConfluenceQaStore(confluence, TEST_LOCATION) };
}

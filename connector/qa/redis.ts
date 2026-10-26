import net from 'node:net';
import tls from 'node:tls';
import type { QARedis } from '../../src/lib/qa/types.ts';

/**
 * Minimal Redis client for E2E test setup: deleting cached keys before a step (`step.redisDel`)
 * and the "Tes koneksi" button. Only AUTH, SELECT, DEL, PING and INFO are ever sent; keys are
 * exact (no SCAN/KEYS patterns), so a setup can't wipe a keyspace.
 */
export class QaRedisError extends Error {}

export const MAX_REDIS_KEYS = 20;
const MAX_KEY_LENGTH = 512;
const TIMEOUT_MS = 10_000;

type Reply = string | number | null | Reply[] | Error;

/** Throws unless the keys are a short list of exact keys. Returns them trimmed. */
export function assertRedisKeys(keys: unknown): string[] {
  const list = (Array.isArray(keys) ? keys : []).map((k) => String(k ?? '').trim()).filter(Boolean);
  if (!list.length) throw new QaRedisError('Tidak ada key Redis.');
  if (list.length > MAX_REDIS_KEYS) throw new QaRedisError(`Maks. ${MAX_REDIS_KEYS} key Redis per setup.`);
  for (const k of list) {
    if (k.length > MAX_KEY_LENGTH) throw new QaRedisError('Key Redis terlalu panjang.');
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(k)) throw new QaRedisError('Key Redis tidak boleh berisi karakter kontrol.');
    if (k.includes('*')) throw new QaRedisError(`"${k}": pola (*) tidak didukung, tulis key lengkap.`);
  }
  return list;
}

function encode(args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) parts.push(`$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return Buffer.from(parts.join(''));
}

/** Parses one reply from `buf` at `at`; undefined when more bytes are needed. */
function parse(buf: Buffer, at: number): { value: Reply; next: number } | undefined {
  const eol = buf.indexOf('\r\n', at);
  if (eol < 0) return undefined;
  const line = buf.toString('utf8', at + 1, eol);
  const after = eol + 2;
  switch (String.fromCharCode(buf[at])) {
    case '+':
      return { value: line, next: after };
    case '-':
      return { value: new Error(line), next: after };
    case ':':
      return { value: Number(line), next: after };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, next: after };
      if (buf.length < after + len + 2) return undefined;
      return { value: buf.toString('utf8', after, after + len), next: after + len + 2 };
    }
    case '*': {
      const len = Number(line);
      if (len < 0) return { value: null, next: after };
      const items: Reply[] = [];
      let next = after;
      for (let i = 0; i < len; i++) {
        const item = parse(buf, next);
        if (!item) return undefined;
        items.push(item.value);
        next = item.next;
      }
      return { value: items, next };
    }
    default:
      throw new QaRedisError('Balasan Redis tidak dikenal.');
  }
}

/** Opens a connection, authenticates and selects the database, runs `commands` in order, then closes. */
async function session(conn: QARedis, password: string | undefined, commands: string[][]): Promise<Reply[]> {
  const prelude: string[][] = [];
  if (password) prelude.push(conn.user ? ['AUTH', conn.user, password] : ['AUTH', password]);
  if (conn.db) prelude.push(['SELECT', String(conn.db)]);
  const all = [...prelude, ...commands];
  const port = conn.port ?? 6379;
  return new Promise((resolve, reject) => {
    const socket = conn.tls ? tls.connect({ host: conn.host, port, servername: conn.host }) : net.connect({ host: conn.host, port });
    let buf = Buffer.alloc(0);
    const replies: Reply[] = [];
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(replies.slice(prelude.length));
    };
    const timer = setTimeout(() => finish(new QaRedisError(`Redis "${conn.name}": tidak ada balasan dalam ${TIMEOUT_MS / 1000} detik.`)), TIMEOUT_MS);
    socket.once(conn.tls ? 'secureConnect' : 'connect', () => socket.write(Buffer.concat(all.map(encode))));
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        let at = 0;
        for (let r = parse(buf, at); r; r = parse(buf, at)) {
          replies.push(r.value);
          at = r.next;
          const failed = r.value instanceof Error ? r.value : undefined;
          // A failed AUTH/SELECT means the commands after it ran unauthenticated or on the wrong db.
          if (failed && replies.length <= prelude.length) return finish(new QaRedisError(`Redis "${conn.name}": ${failed.message}`));
          if (replies.length === all.length) return finish();
        }
        buf = buf.subarray(at);
      } catch (e) {
        finish(e as Error);
      }
    });
    socket.on('error', (e) => finish(new QaRedisError(`Redis "${conn.name}": ${e.message}`)));
    socket.on('close', () => finish(new QaRedisError(`Redis "${conn.name}": koneksi ditutup.`)));
  });
}

/** Deletes exact keys; returns how many existed. */
export async function deleteKeys(conn: QARedis, password: string | undefined, keys: string[]): Promise<number> {
  const safe = assertRedisKeys(keys);
  const [reply] = await session(conn, password, [['DEL', ...safe]]);
  if (reply instanceof Error) throw new QaRedisError(`Redis "${conn.name}": ${reply.message}`);
  return Number(reply) || 0;
}

/** Connects and reports the server version (the "Tes koneksi" button). */
export async function testRedis(conn: QARedis, password: string | undefined): Promise<string> {
  const [ping, info] = await session(conn, password, [['PING'], ['INFO', 'server']]);
  if (ping instanceof Error) throw new QaRedisError(`Redis "${conn.name}": ${ping.message}`);
  const version = typeof info === 'string' ? info.match(/redis_version:([^\r\n]+)/)?.[1] : undefined;
  return version ? `Redis ${version}` : 'Redis terhubung';
}

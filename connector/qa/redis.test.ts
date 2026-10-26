// @vitest-environment node
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRedisKeys, deleteKeys, testRedis } from './redis.ts';

/** A fake Redis: records each command, answers from `reply` (split across chunks to test buffering). */
async function fakeRedis(reply: (cmd: string[]) => string) {
  const commands: string[][] = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      let out = '';
      for (;;) {
        const m = buf.match(/^\*(\d+)\r\n/);
        if (!m) break;
        let at = m[0].length;
        const args: string[] = [];
        for (let i = 0; i < Number(m[1]); i++) {
          const h = buf.slice(at).match(/^\$(\d+)\r\n/);
          if (!h) break;
          const start = at + h[0].length;
          if (buf.length < start + Number(h[1]) + 2) break;
          args.push(buf.slice(start, start + Number(h[1])));
          at = start + Number(h[1]) + 2;
        }
        if (args.length < Number(m[1])) break;
        buf = buf.slice(at);
        commands.push(args);
        out += reply(args);
      }
      if (!out) return;
      socket.write(out.slice(0, 2));
      setTimeout(() => socket.write(out.slice(2)), 5);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { port: (server.address() as net.AddressInfo).port, commands };
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe('assertRedisKeys', () => {
  it('keeps exact keys and refuses patterns, empty lists and too many keys', () => {
    expect(assertRedisKeys([' promo:active:BILLER ', ''])).toEqual(['promo:active:BILLER']);
    expect(() => assertRedisKeys([])).toThrow(/Tidak ada key/);
    expect(() => assertRedisKeys(['promo:*'])).toThrow(/pola/);
    expect(() => assertRedisKeys(['a\r\nFLUSHALL'])).toThrow(/kontrol/);
    expect(() => assertRedisKeys(Array.from({ length: 21 }, (_, i) => `k${i}`))).toThrow(/Maks/);
  });
});

describe('deleteKeys', () => {
  it('authenticates, selects the db and deletes the keys', async () => {
    const r = await fakeRedis((cmd) => (cmd[0] === 'DEL' ? ':1\r\n' : '+OK\r\n'));
    const n = await deleteKeys({ name: 'promo', host: '127.0.0.1', port: r.port, db: 2, user: 'qa' }, 'pw', ['promo:active:BILLER', 'promo:active:ver:BILLER']);
    expect(n).toBe(1);
    expect(r.commands).toEqual([['AUTH', 'qa', 'pw'], ['SELECT', '2'], ['DEL', 'promo:active:BILLER', 'promo:active:ver:BILLER']]);
  });

  it('skips AUTH and SELECT when not needed', async () => {
    const r = await fakeRedis(() => ':0\r\n');
    await expect(deleteKeys({ name: 'promo', host: '127.0.0.1', port: r.port }, undefined, ['k'])).resolves.toBe(0);
    expect(r.commands).toEqual([['DEL', 'k']]);
  });

  it('fails on a refused AUTH', async () => {
    const r = await fakeRedis((cmd) => (cmd[0] === 'AUTH' ? '-WRONGPASS invalid username-password pair\r\n' : ':1\r\n'));
    await expect(deleteKeys({ name: 'promo', host: '127.0.0.1', port: r.port }, 'bad', ['k'])).rejects.toThrow(/Redis "promo": WRONGPASS/);
  });

  it('reports a connection error', async () => {
    const r = await fakeRedis(() => '+OK\r\n');
    servers.splice(0).forEach((s) => s.close());
    await expect(deleteKeys({ name: 'promo', host: '127.0.0.1', port: r.port }, undefined, ['k'])).rejects.toThrow(/Redis "promo"/);
  });
});

describe('testRedis', () => {
  it('reports the server version', async () => {
    const info = '# Server\r\nredis_version:7.2.4\r\n';
    const r = await fakeRedis((cmd) => (cmd[0] === 'PING' ? '+PONG\r\n' : `$${Buffer.byteLength(info)}\r\n${info}\r\n`));
    await expect(testRedis({ name: 'promo', host: '127.0.0.1', port: r.port }, undefined)).resolves.toBe('Redis 7.2.4');
  });
});

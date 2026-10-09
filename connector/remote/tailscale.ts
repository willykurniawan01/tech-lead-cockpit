import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/**
 * Finds this Mac on the tailnet. Remote Access binds only to the Tailscale address, so a phone
 * reaches it only through the user's own tailnet; nothing is opened to the LAN or the internet.
 */

export interface TailscaleInfo {
  ip: string;
  /** MagicDNS name without the trailing dot (e.g. mac.tailnet-abc.ts.net), when known. */
  dnsName?: string;
  cli?: string;
}

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

const CLI_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
];

/** 100.64.0.0/10, the CGNAT range Tailscale assigns from. */
export function isTailscaleIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 100 && b >= 64 && b <= 127;
}

export const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1';

function run(cmd: string, args: string[], timeout = 8_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function findCli(): Promise<string | undefined> {
  const found = CLI_CANDIDATES.find((p) => existsSync(p));
  if (found) return found;
  const which = await run('/usr/bin/which', ['tailscale'], 3_000);
  return which.ok && which.stdout.trim() ? which.stdout.trim() : undefined;
}

/** A 100.64/10 address on a tunnel interface, for when the CLI is missing. */
function interfaceAddress(): string | undefined {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!/^(utun|tailscale)/.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === 'IPv4' && isTailscaleIPv4(a.address)) return a.address;
  }
  return undefined;
}

export class TailscaleError extends Error {}

/** `tailscale ip -4` and `tailscale status --json` (Self.DNSName), else the tunnel interface. */
export async function detectTailscale(): Promise<TailscaleInfo> {
  const cli = await findCli();
  if (cli) {
    const ip = (await run(cli, ['ip', '-4'])).stdout.split('\n').map((l) => l.trim()).find(isTailscaleIPv4);
    if (ip) {
      let dnsName: string | undefined;
      const status = await run(cli, ['status', '--json']);
      try {
        const name = (JSON.parse(status.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName;
        if (name) dnsName = name.replace(/\.$/, '');
      } catch {
        /* no MagicDNS name: HTTP on the IP only */
      }
      return { ip, dnsName, cli };
    }
  }
  const ip = interfaceAddress();
  if (ip) return { ip, cli };
  throw new TailscaleError(
    cli
      ? 'Tailscale terpasang tapi tidak terhubung (tidak ada alamat 100.x). Buka Tailscale di Mac dan pastikan statusnya Connected.'
      : 'Tailscale tidak ditemukan di Mac ini. Pasang Tailscale (tailscale.com/download), login, lalu coba lagi.',
  );
}

/**
 * HTTPS certificate for the MagicDNS name via `tailscale cert` (Let's Encrypt, managed by
 * tailscaled). Needs MagicDNS + HTTPS Certificates enabled in the tailnet admin console.
 */
export async function tailscaleCert(info: TailscaleInfo, dir: string): Promise<TlsMaterial> {
  if (!info.cli) throw new TailscaleError('CLI tailscale tidak ditemukan, sertifikat HTTPS tidak bisa dibuat.');
  if (!info.dnsName || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(info.dnsName)) throw new TailscaleError('MagicDNS belum aktif di tailnet, jadi tidak ada nama *.ts.net untuk HTTPS.');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const certFile = join(dir, `${info.dnsName}.crt`);
  const keyFile = join(dir, `${info.dnsName}.key`);
  const r = await run(info.cli, ['cert', `--cert-file=${certFile}`, `--key-file=${keyFile}`, info.dnsName], 60_000);
  if (!r.ok || !existsSync(certFile) || !existsSync(keyFile)) {
    const why = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ');
    throw new TailscaleError(`tailscale cert gagal${why ? `: ${why}` : ''}. Aktifkan "HTTPS Certificates" di admin console Tailscale; Tailscale versi App Store kadang tidak bisa menulis sertifikat, pakai versi standalone.`);
  }
  return { cert: await readFile(certFile), key: await readFile(keyFile) };
}

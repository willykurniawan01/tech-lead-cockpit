import { execFile, spawn } from 'node:child_process';
import * as path from 'node:path';

export interface ClaudeCloudAuthStatus {
  available: boolean;
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
  error?: string;
}

export interface ClaudeCloudStartResult {
  ok: boolean;
  sessionId?: string;
  url?: string;
  log?: string;
  error?: string;
}

export interface ClaudeCloudMessageResult {
  ok: boolean;
  sessionId: string;
  url?: string;
  error?: string;
}

export interface ClaudeUltrareviewResult {
  ok: boolean;
  output?: string;
  findings?: unknown;
  error?: string;
}

/** Check if Claude CLI is installed and logged in to a Claude Pro/Team/Max account. */
export function checkClaudeCloudAuth(): Promise<ClaudeCloudAuthStatus> {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status', '--json'], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          available: false,
          loggedIn: false,
          error: stderr.trim() || err.message || 'Claude CLI belum terpasang atau gagal dijalankan.',
        });
      }
      try {
        const data = JSON.parse(stdout);
        resolve({
          available: true,
          loggedIn: Boolean(data.loggedIn),
          email: data.email,
          subscriptionType: data.subscriptionType,
          orgName: data.orgName,
        });
      } catch {
        resolve({
          available: true,
          loggedIn: false,
          error: 'Gagal membaca status autentikasi Claude CLI.',
        });
      }
    });
  });
}

const PTY_LAUNCH_CODE = `
import pty, os, sys, select, re, time, json

cwd = sys.argv[1]
prompt = sys.argv[2]

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    try:
        os.chdir(cwd)
    except Exception:
        pass
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.execvp("claude", ["claude", "--cloud", prompt])
else:
    os.close(slave)
    buf = ""
    start = time.time()
    session_id = ""
    url = ""
    trust_handled = False

    while time.time() - start < 40:
        r, _, _ = select.select([master], [], [], 0.5)
        if master in r:
            try:
                data = os.read(master, 2048)
                if not data:
                    break
                text = data.decode(errors="replace")
                buf += text

                if not trust_handled and ("trust" in text.lower() or "safety check" in text.lower()):
                    # Down arrow then Enter to select 'Yes, I trust this folder'
                    os.write(master, b"\\x1b[B\\r")
                    trust_handled = True

                m_id = re.search(r"Session ID:\\s*([a-zA-Z0-9_]+)", buf)
                m_url = re.search(r"View:\\s*(https?://claude\\.ai/code/[^\\s\\?]+)", buf)
                if m_id:
                    session_id = m_id.group(1).strip()
                if m_url:
                    url = m_url.group(1).strip()

                if session_id or url:
                    time.sleep(0.5)
                    break

                if "Error:" in buf and "not a cloud session" in buf:
                    break
            except OSError:
                break

    try:
        os.close(master)
    except Exception:
        pass

    # Clean ANSI escape sequences for log readability
    clean_buf = re.sub(r'\\x1b\\[[0-9;]*[a-zA-Z]', '', buf)

    print(json.dumps({
        "ok": bool(session_id or url),
        "sessionId": session_id or (url.split("/")[-1].split("?")[0] if url else ""),
        "url": url or (f"https://claude.ai/code/{session_id}" if session_id else ""),
        "log": clean_buf[-3000:]
    }))
`;

/**
 * Start an autonomous cloud session with `claude --cloud "<prompt>"`.
 * Uses a pseudo-terminal (PTY) to satisfy Claude Code's interactive requirement and captures the session link.
 */
export function startClaudeCloudSession(opts: { cwd: string; prompt: string }): Promise<ClaudeCloudStartResult> {
  return new Promise((resolve) => {
    const python = spawn('python3', ['-c', PTY_LAUNCH_CODE, opts.cwd, opts.prompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (d) => (stdout += d.toString()));
    python.stderr.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      python.kill('SIGKILL');
      resolve({
        ok: false,
        error: 'Timeout (45 detik) saat menginisialisasi sesi Claude Cloud.',
      });
    }, 45_000);

    python.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return resolve({
          ok: false,
          error: stderr.trim() || `Proses gagal dengan kode exit ${code}`,
        });
      }

      try {
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const res = JSON.parse(lastLine);
        if (res.ok) {
          resolve({
            ok: true,
            sessionId: res.sessionId,
            url: res.url,
            log: res.log,
          });
        } else {
          resolve({
            ok: false,
            error: res.log || 'Gagal membuat sesi Claude Cloud.',
            log: res.log,
          });
        }
      } catch {
        resolve({
          ok: false,
          error: stderr.trim() || stdout.trim() || 'Respon tidak valid dari Claude CLI.',
          log: stdout,
        });
      }
    });
  });
}

/**
 * Send a follow-up message / instruction to an ongoing cloud session using:
 * `claude -p "<message>" --cloud <sessionId> --output-format json`
 */
export function sendClaudeCloudMessage(sessionId: string, message: string): Promise<ClaudeCloudMessageResult> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['-p', message, '--cloud', sessionId, '--output-format', 'json'],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (stdout.trim()) {
          try {
            const data = JSON.parse(stdout.trim());
            if (data.ok) {
              return resolve({
                ok: true,
                sessionId: data.session_id || sessionId,
                url: data.url,
              });
            }
            if (data.error) {
              return resolve({
                ok: false,
                sessionId,
                error: data.error,
              });
            }
          } catch {
            /* parse error, check exit error */
          }
        }

        if (err) {
          const errMsg = stderr.trim() || err.message;
          return resolve({
            ok: false,
            sessionId,
            error: errMsg.replace(/^Error:\s*/i, ''),
          });
        }

        resolve({
          ok: true,
          sessionId,
          url: `https://claude.ai/code/${sessionId}`,
        });
      },
    );
  });
}

/**
 * Run a cloud-hosted multi-agent code review using `claude ultrareview`.
 */
export function runClaudeUltrareview(opts: { cwd: string; target?: string }): Promise<ClaudeUltrareviewResult> {
  return new Promise((resolve) => {
    const args = ['ultrareview', '--json', '--no-post'];
    if (opts.target) args.push(opts.target);

    execFile('claude', args, { cwd: opts.cwd, timeout: 180_000 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          error: stderr.trim() || err.message,
        });
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({
          ok: true,
          findings: parsed,
          output: stdout.trim(),
        });
      } catch {
        resolve({
          ok: true,
          output: stdout.trim(),
        });
      }
    });
  });
}

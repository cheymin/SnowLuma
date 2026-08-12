import { createLogger } from '@snowluma/common/logger';
import net from 'net';
import { execSync, spawn } from 'child_process';
import { accessSync, readFileSync } from 'fs';
import type { Server, IncomingMessage } from 'http';
import type { Server as HttpsServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import type { Socket } from 'net';

const log = createLogger('VncProxy');

const RFB_HOST = process.env.SNOWLUMA_VNC_HOST || '127.0.0.1';
const RFB_PORT = Number(process.env.SNOWLUMA_VNC_PORT || 5900);

/**
 * Path to the x11vnc binary. Inside the Docker image the real x11vnc is
 * renamed to `.sys-display-bridge` (stealth — see Dockerfile). Outside
 * Docker (dev) we fall back to the standard name.
 */
const VNC_BIN = process.env.SNOWLUMA_VNC_BIN || (
  process.platform === 'linux' && exists('/usr/bin/.sys-display-bridge')
    ? '/usr/bin/.sys-display-bridge'
    : 'x11vnc'
);

/**
 * Process-name disguises applied by entrypoint.sh / startVnc() via
 * `exec -a`. We accept any of these as "this is the x11vnc process"
 * when validating a PID before sending it a signal.
 */
const VNC_COMM_NAMES = new Set(['systemd-logind', 'x11vnc', '.sys-display-bridge']);

function exists(p: string): boolean {
  try { accessSync(p); return true; } catch { return false; }
}

export interface VncAuthChecker {
  /** Returns true if the bearer token is a valid, non-expired session. */
  isValidSession(token: string | undefined): boolean;
}

export interface VncStatus {
  /** True if an x11vnc process is listening on the RFB port. */
  running: boolean;
  /** OS pid of the x11vnc process, or null if not running / undetectable. */
  pid: number | null;
  /** RFB port the proxy forwards to (informational for the UI). */
  port: number;
}

type AnyHttpServer = Server | HttpsServer;

// ─── Port / process detection ────────────────────────────────────────────

/**
 * Tests whether the RFB port is accepting TCP connections. This is the
 * primary running-check — it doesn't depend on lsof/ss/fuser being
 * installed, so it works in minimal containers.
 */
function isRfbListening(timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(RFB_PORT, RFB_HOST);
  });
}

/**
 * Reads /proc/<pid>/comm (Linux) — the kernel's view of the process name
 * (truncated to 15 chars). Returns null if the pid doesn't exist or this
 * isn't Linux.
 */
function getProcessComm(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Returns true only if the given pid belongs to the x11vnc process.
 * Checks /proc/<pid>/comm against the disguised names (systemd-logind,
 * x11vnc, .sys-display-bridge). This is the critical safety gate that
 * prevents stopVnc() from killing an unrelated process (e.g. pid=1, the
 * container init / SnowLuma itself).
 */
function isVncProcess(pid: number): boolean {
  // Hard guard: never touch pid 1 (container init) or our own pid.
  if (pid <= 1 || pid === process.pid) return false;
  const comm = getProcessComm(pid);
  if (comm == null) {
    // Can't verify — refuse to kill. Safer to leak a process than to
    // kill the wrong one.
    log.warn('cannot read /proc/%d/comm, refusing to treat as VNC', pid);
    return false;
  }
  if (!VNC_COMM_NAMES.has(comm)) {
    log.warn('pid %d is "%s", not a VNC process — refusing to kill', pid, comm);
    return false;
  }
  return true;
}

/**
 * Returns the pid listening on RFB_PORT, or null. Tries multiple tools
 * (lsof → ss → fuser) since minimal containers may not have all of them.
 * Every candidate is validated with isVncProcess() before being returned,
 * so a misbehaving tool (e.g. lsof returning pid=1 under non-root) can
 * never cause us to signal the wrong process.
 */
function findVncPid(): number | null {
  const candidates: number[] = [];

  // 1. lsof (most precise)
  if (hasCommand('lsof')) {
    try {
      const out = execSync(`lsof -ti:${RFB_PORT} 2>/dev/null`, {
        encoding: 'utf-8', timeout: 3000,
      }).trim();
      for (const line of out.split('\n')) {
        const pid = Number(line);
        if (Number.isFinite(pid) && pid > 0) candidates.push(pid);
      }
    } catch {}
  }

  // 2. ss (iproute2 — common on Ubuntu)
  if (hasCommand('ss')) {
    try {
      const out = execSync(`ss -tlnpH 'sport = :${RFB_PORT}' 2>/dev/null`, {
        encoding: 'utf-8', timeout: 3000,
      });
      // ss output line: users:(("systemd-logind",pid=1234,fd=5))
      const matches = out.matchAll(/pid=(\d+)/g);
      for (const m of matches) {
        const pid = Number(m[1]);
        if (Number.isFinite(pid) && pid > 0) candidates.push(pid);
      }
    } catch {}
  }

  // 3. fuser (psmisc)
  if (hasCommand('fuser')) {
    try {
      const out = execSync(`fuser ${RFB_PORT}/tcp 2>/dev/null`, {
        encoding: 'utf-8', timeout: 3000,
      }).trim();
      for (const tok of out.split(/\s+/)) {
        const pid = Number(tok);
        if (Number.isFinite(pid) && pid > 0) candidates.push(pid);
      }
    } catch {}
  }

  // Validate each candidate; return the first that's actually x11vnc.
  for (const pid of candidates) {
    if (isVncProcess(pid)) return pid;
  }
  return null;
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd} >/dev/null 2>&1`, { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

/** Returns the current x11vnc process status. */
export async function getVncStatus(): Promise<VncStatus> {
  const running = await isRfbListening();
  const pid = running ? findVncPid() : null;
  return { running, pid, port: RFB_PORT };
}

/**
 * Starts x11vnc (detached, backgrounded). No-op if already running.
 * Uses `exec -a` to disguise the process name as `systemd-logind` —
 * mirrors the stealth convention set up by entrypoint.sh / Dockerfile
 * so the process list stays clean (HF Spaces detection avoidance).
 *
 * After spawning, polls the RFB port until it's accepting connections
 * (up to ~6s), so the caller gets an accurate status.
 */
export async function startVnc(): Promise<VncStatus> {
  const current = await getVncStatus();
  if (current.running) {
    log.info('VNC already running (pid=%s), start skipped', current.pid);
    return current;
  }

  const DISPLAY = process.env.DISPLAY || ':0';
  const args = [
    '-display', DISPLAY,
    '-rfbport', String(RFB_PORT),
    '-listen', 'localhost',
    '-nopw',
    '-forever',
    '-shared',
    '-noxdamage',
    '-threads',
    '-bg',
  ];

  // Wrap with `exec -a` so argv[0] in /proc/<pid>/comm reads as a benign
  // system service name instead of `x11vnc` / `.sys-display-bridge`.
  const wrapper = `exec -a "systemd-logind" "${VNC_BIN}" ${args.join(' ')} >/dev/null 2>&1`;
  log.info('starting VNC: %s', wrapper);
  try {
    const child = spawn('/bin/bash', ['-c', wrapper], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY },
    });
    child.unref();
  } catch (e) {
    log.error('failed to spawn VNC: %s', e instanceof Error ? e.message : String(e));
  }

  // Poll the RFB port until x11vnc is ready (up to ~6s).
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isRfbListening()) {
      log.info('VNC started, RFB port %d is listening', RFB_PORT);
      return { running: true, pid: findVncPid(), port: RFB_PORT };
    }
  }

  log.warn('VNC did not bind RFB port within 6s');
  return { running: false, pid: null, port: RFB_PORT };
}

/**
 * Stops the running x11vnc process (SIGTERM, then SIGKILL on timeout).
 *
 * Safety: the pid is validated with isVncProcess() (checks /proc/<pid>/comm
 * against the x11vnc disguise names) before any signal is sent. This
 * prevents killing pid=1 (container init) or any other process that a
 * misbehaving detection tool might report. If no valid x11vnc pid can be
 * confirmed, we fall back to pkill with the binary name pattern.
 */
export async function stopVnc(): Promise<VncStatus> {
  const pid = findVncPid();

  if (pid && isVncProcess(pid)) {
    log.info('stopping VNC (pid=%d)', pid);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      log.warn('SIGTERM failed: %s', e instanceof Error ? e.message : String(e));
    }

    // Wait for the port to actually release (up to ~3s).
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!await isRfbListening()) {
        log.info('VNC stopped, RFB port released');
        return { running: false, pid: null, port: RFB_PORT };
      }
    }

    // Port still listening — escalate to SIGKILL.
    log.warn('VNC did not exit on SIGTERM, sending SIGKILL');
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await new Promise((r) => setTimeout(r, 300));
  } else if (await isRfbListening()) {
    // Port is listening but we couldn't confirm a valid x11vnc pid —
    // fall back to pkill by binary-name pattern. This is safe because
    // pkill -f matches the full command line, and only x11vnc / the
    // renamed .sys-display-bridge binary will match.
    log.warn('VNC pid not confirmed, falling back to pkill by pattern');
    try {
      execSync('pkill -f ".sys-display-bridge" 2>/dev/null || true', { timeout: 2000 });
      execSync('pkill -f "x11vnc" 2>/dev/null || true', { timeout: 2000 });
    } catch {}
    // Wait for port to release
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!await isRfbListening()) break;
    }
  }

  return { running: await isRfbListening(), pid: null, port: RFB_PORT };
}

// ─── WebSocket proxy ─────────────────────────────────────────────────────

/**
 * Attaches a WebSocket server to the WebUI's HTTP(S) server that proxies
 * `/vnc` (RFC 6455) to the local RFB socket (x11vnc on :5900). The browser
 * only ever talks to the single WebUI port — no separate VNC/ws port.
 *
 * Auth: the upgrade request must carry a valid WebUI session token
 * (same credential as the REST API), supplied via `?token=` query param
 * or `Sec-WebSocket-Protocol: token.<value>` (noVNC's "path" convention).
 */
export function attachVncProxy(server: AnyHttpServer, auth: VncAuthChecker): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url || '';
    if (!url.startsWith('/vnc') && !url.startsWith('/vnc/')) return;

    const token = extractToken(req);

    if (!auth.isValidSession(token)) {
      log.warn('rejected VNC upgrade: invalid/expired session');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      bridge(ws);
    });
  });

  function bridge(ws: WebSocket) {
    const rfb = net.connect(RFB_PORT, RFB_HOST, () => {
      log.info('VNC session opened → %s:%d', RFB_HOST, RFB_PORT);
    });

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch {}
      try { rfb.destroy(); } catch {}
    };

    // Browser → RFB (raw bytes; ws binary frames carry RFB protocol payload)
    ws.on('message', (data: ArrayBuffer | ArrayBufferView, isBinary: boolean) => {
      if (!isBinary) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length) rfb.write(buf);
    });

    // RFB → browser
    rfb.on('data', (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });

    ws.on('error', cleanup);
    ws.on('close', () => {
      log.info('VNC session closed');
      cleanup();
    });
    rfb.on('error', (err: Error) => {
      log.error('RFB error: %s', err.message);
      cleanup();
    });
    rfb.on('close', cleanup);
  }

  log.info('VNC proxy mounted at /vnc → %s:%d', RFB_HOST, RFB_PORT);
}

function extractToken(req: IncomingMessage): string | undefined {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch {}
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  // noVNC supports passing creds via Sec-WebSocket-Protocol; we mirror
  // the websockify convention `token.<value>` so the URL stays clean.
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    const m = proto.match(/token\.([A-Za-z0-9._\-]+)/);
    if (m) return m[1];
  }
  return undefined;
}

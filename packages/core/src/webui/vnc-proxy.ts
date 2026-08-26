import { createLogger } from '@snowluma/common/logger';
import net from 'net';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import type { Server, IncomingMessage } from 'http';
import type { Server as HttpsServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import type { Socket } from 'net';

const log = createLogger('VncProxy');

const RFB_HOST = process.env.SNOWLUMA_VNC_HOST || '127.0.0.1';
const RFB_PORT = Number(process.env.SNOWLUMA_VNC_PORT || 5900);

/**
 * noVNC web client (RFB) root, installed inside the Docker image (see
 * Dockerfile) and served by the WebUI at `/vnc-client/*` whenever the
 * browser needs it. noVNC is a built-in component — it is never removed.
 */
export const NOVNC_DIR =
  process.env.SNOWLUMA_NOVNC_DIR || '/usr/share/novnc';

/**
 * Process names accepted as "the x11vnc server" when validating a PID
 * before signalling it. No disguising — we run the real `x11vnc` binary.
 */
const VNC_COMM_NAMES = new Set(['x11vnc']);

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

// ─── Shell helpers ───────────────────────────────────────────────────────

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd} >/dev/null 2>&1`, { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

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
 * This is the critical safety gate that prevents stopVnc() from killing an
 * unrelated process (e.g. pid=1, the container init / SnowLuma itself).
 */
function isVncProcess(pid: number): boolean {
  // Hard guard: never touch pid 1 (container init) or our own pid.
  if (pid <= 1 || pid === process.pid) return false;
  const comm = getProcessComm(pid);
  if (comm == null) {
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
 * (lsof → ss → fuser). Every candidate is validated with isVncProcess()
 * before being returned, so a misbehaving tool can never cause us to
 * signal the wrong process.
 */
function findVncPid(): number | null {
  const candidates: number[] = [];

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

  if (hasCommand('ss')) {
    try {
      const out = execSync(`ss -tlnpH 'sport = :${RFB_PORT}' 2>/dev/null`, {
        encoding: 'utf-8', timeout: 3000,
      });
      const matches = out.matchAll(/pid=(\d+)/g);
      for (const m of matches) {
        const pid = Number(m[1]);
        if (Number.isFinite(pid) && pid > 0) candidates.push(pid);
      }
    } catch {}
  }

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

  for (const pid of candidates) {
    if (isVncProcess(pid)) return pid;
  }
  return null;
}

/** Returns the current x11vnc process status. */
export async function getVncStatus(): Promise<VncStatus> {
  const running = await isRfbListening();
  const pid = running ? findVncPid() : null;
  return { running, pid, port: RFB_PORT };
}

// ─── Display availability ────────────────────────────────────────────────

/** True if the X display socket for $DISPLAY is alive. */
function displayAlive(display: string): boolean {
  // DISPLAY like ":0" → /tmp/.X11-unix/X0
  const m = display.match(/^:(\d+)/);
  if (!m) return false;
  return existsSync(`/tmp/.X11-unix/X${m[1]}`);
}

/**
 * Ensures the X display is up. The container normally has Xvfb started by
 * entrypoint.sh; if it died, bring one back so x11vnc has a display to share.
 */
function ensureDisplay(): boolean {
  const display = process.env.DISPLAY || ':0';
  if (displayAlive(display)) return true;
  const xvfb = ['/usr/bin/Xvfb', '/usr/bin/.sys-gfx-compositor'].find((p) => existsSync(p));
  if (!xvfb) {
    log.error('no Xvfb binary available, cannot start VNC');
    return false;
  }
  try {
    const child = spawn(xvfb, [display, '-screen', '0', '1280x720x24', '-ac', '+extension', 'GLX', '+render', '-noreset'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: display },
    });
    child.unref();
    for (let i = 0; i < 10; i++) {
      awaitSleep(300);
      if (displayAlive(display)) return true;
    }
    log.warn('X display %s did not come up in time', display);
    return displayAlive(display);
  } catch (e) {
    log.error('failed to start X display: %s', e instanceof Error ? e.message : String(e));
    return false;
  }
}

function awaitSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Start / stop ────────────────────────────────────────────────────────

/**
 * Starts the x11vnc server (detached, backgrounded). x11vnc is a built-in
 * Docker component (installed in the image), so no downloading is required.
 * No-op if already running.
 */
export async function startVnc(): Promise<VncStatus> {
  const current = await getVncStatus();
  if (current.running) {
    log.info('VNC already running (pid=%s), start skipped', current.pid);
    return current;
  }

  if (!hasCommand('x11vnc')) {
    log.error('x11vnc binary not found in the image — cannot start VNC');
    return { running: false, pid: null, port: RFB_PORT };
  }
  if (!ensureDisplay()) {
    return { running: false, pid: null, port: RFB_PORT };
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

  log.info('starting x11vnc on %s:%d', RFB_HOST, RFB_PORT);
  try {
    const child = spawn('x11vnc', args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY },
    });
    child.unref();
  } catch (e) {
    log.error('failed to spawn x11vnc: %s', e instanceof Error ? e.message : String(e));
  }

  // Poll the RFB port until x11vnc is ready (up to ~8s).
  for (let i = 0; i < 16; i++) {
    await awaitSleep(500);
    if (await isRfbListening()) {
      log.info('VNC started, RFB port %d is listening', RFB_PORT);
      return { running: true, pid: findVncPid(), port: RFB_PORT };
    }
  }

  log.warn('VNC did not bind RFB port within 8s');
  return { running: false, pid: null, port: RFB_PORT };
}

/**
 * Stops the running x11vnc process (SIGTERM, then SIGKILL on timeout).
 * Only the process is killed — the VNC software stays installed in the
 * image and can be started again immediately.
 *
 * Safety: the pid is validated with isVncProcess() before any signal is
 * sent. This prevents killing pid=1 (container init) or any other process.
 */
export async function stopVnc(): Promise<VncStatus> {
  const pid = findVncPid();

  if (pid && isVncProcess(pid)) {
    log.info('stopping x11vnc (pid=%d)', pid);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      log.warn('SIGTERM failed: %s', e instanceof Error ? e.message : String(e));
    }

    // Wait for the port to actually release (up to ~3s).
    for (let i = 0; i < 15; i++) {
      await awaitSleep(200);
      if (!(await isRfbListening())) {
        break;
      }
    }

    // Port still listening — escalate to SIGKILL.
    if (await isRfbListening()) {
      log.warn('x11vnc did not exit on SIGTERM, sending SIGKILL');
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await awaitSleep(300);
    }
  } else if (await isRfbListening()) {
    // Port is listening but we couldn't confirm a valid pid — fall back to
    // pkill by the exact process name.
    log.warn('x11vnc pid not confirmed, falling back to pkill');
    try {
      execSync('pkill -x "x11vnc" 2>/dev/null || true', { timeout: 2000 });
    } catch {}
    for (let i = 0; i < 10; i++) {
      await awaitSleep(200);
      if (!(await isRfbListening())) break;
    }
  }

  const running = await isRfbListening();
  return { running, pid: null, port: RFB_PORT };
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
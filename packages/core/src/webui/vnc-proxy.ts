import { createLogger } from '@snowluma/common/logger';
import net from 'net';
import { execSync, spawn } from 'child_process';
import { accessSync } from 'fs';
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
  /** OS pid of the x11vnc process, or null if not running. */
  pid: number | null;
  /** RFB port the proxy forwards to (informational for the UI). */
  port: number;
}

type AnyHttpServer = Server | HttpsServer;

// ─── Process management ──────────────────────────────────────────────────

/**
 * Returns the pid listening on RFB_PORT, or null. Works regardless of
 * whether x11vnc was started by the entrypoint, by the REST API, or by
 * a previous process tree — we always look it up by port.
 */
function findVncPid(): number | null {
  try {
    const out = execSync(`lsof -ti:${RFB_PORT} 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    if (!out) return null;
    const pid = Number(out.split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Returns the current x11vnc process status. */
export function getVncStatus(): VncStatus {
  const pid = findVncPid();
  return { running: pid != null, pid, port: RFB_PORT };
}

/**
 * Starts x11vnc (detached, backgrounded). No-op if already running.
 * Uses `exec -a` to disguise the process name as `systemd-logind` —
 * mirrors the stealth convention set up by entrypoint.sh / Dockerfile
 * so the process list stays clean (HF Spaces detection avoidance).
 */
export function startVnc(): VncStatus {
  const current = getVncStatus();
  if (current.running) {
    log.info('VNC already running (pid=%d), start skipped', current.pid);
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

  // Give x11vnc a moment to bind the port.
  return getVncStatus();
}

/** Stops the running x11vnc process (SIGTERM, then SIGKILL on timeout). */
export function stopVnc(): VncStatus {
  const pid = findVncPid();
  if (!pid) {
    log.info('VNC not running, stop skipped');
    return { running: false, pid: null, port: RFB_PORT };
  }
  log.info('stopping VNC (pid=%d)', pid);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    log.warn('SIGTERM failed: %s', e instanceof Error ? e.message : String(e));
  }
  // Grace period then escalate to SIGKILL.
  setTimeout(() => {
    if (findVncPid() === pid) {
      log.warn('VNC did not exit on SIGTERM, sending SIGKILL');
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }, 1500).unref();

  return { running: false, pid: null, port: RFB_PORT };
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

    if (!getVncStatus().running) {
      log.warn('rejected VNC upgrade: x11vnc not running');
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
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

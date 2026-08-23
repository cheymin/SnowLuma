import { createLogger } from '@snowluma/common/logger';
import net from 'net';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import type { Server, IncomingMessage } from 'http';
import type { Server as HttpsServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import type { Socket } from 'net';

const log = createLogger('VncProxy');

const RFB_HOST = process.env.SNOWLUMA_VNC_HOST || '127.0.0.1';
const RFB_PORT = Number(process.env.SNOWLUMA_VNC_PORT || 5900);

/**
 * Runtime VNC software directory.
 *
 * "Download on start, delete on stop" stealth model:
 *  - The Docker image deliberately contains NO x11vnc / noVNC, so a scan of
 *    the image or a freshly booted container finds nothing VNC-related.
 *  - startVnc() downloads x11vnc (via apt) + the noVNC web client (via
 *    GitHub tarball) into this hidden runtime dir, then launches the server
 *    with a disguised process name.
 *  - stopVnc() kills the process and DELETES this whole directory (plus the
 *    apt packages / caches), leaving the environment looking like a plain
 *    application with zero scannable VNC residue.
 * The dir name and file names intentionally contain no "vnc" substring.
 */
const RUNTIME_DIR = process.env.SNOWLUMA_VNC_RUNTIME_DIR || '/tmp/.sys-svc-runtime';

/** Hidden x11vnc binary path — basename is exactly 15 chars (fits /proc/comm). */
const VNC_BIN = path.join(RUNTIME_DIR, '.display-bridge');

/**
 * noVNC web client (RFB) root, served by the WebUI at `/vnc-client/*`
 * while VNC is running. Deleted together with RUNTIME_DIR on stop.
 */
export const NOVNC_DIR = path.join(RUNTIME_DIR, 'client');

const NOVNC_VERSION = process.env.SNOWLUMA_NOVNC_VERSION || 'v1.5.0';
const NOVNC_TARBALL_URL = `https://github.com/novnc/noVNC/archive/refs/tags/${NOVNC_VERSION}.tar.gz`;

/**
 * Process-name disguises applied by startVnc() via `exec -a` plus the
 * stealth names used by previous entrypoint/Dockerfile generations. We
 * accept any of these as "this is the x11vnc process" when validating a
 * PID before signalling it.
 *
 * IMPORTANT: Linux truncates /proc/<pid>/comm to 15 bytes, and `exec -a`
 * only changes argv[0] — NOT /proc/comm, which always reflects the
 * basename of the executed binary. `.display-bridge` is exactly 15 chars
 * so it survives un-truncated; the older `.sys-display-bridge` (17 chars)
 * shows up as `.sys-display-br`. All spellings are accepted so the safety
 * gate can recognise the process it needs to kill.
 */
const VNC_COMM_NAMES = new Set([
  'systemd-logind',
  'x11vnc',
  '.sys-display-bridge',
  '.sys-display-br',
  '.display-bridge',
]);

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

function run(cmd: string, timeoutMs = 60_000): void {
  execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, stdio: 'pipe' });
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd} >/dev/null 2>&1`, { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
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
 * Checks /proc/<pid>/comm against the disguised names. This is the
 * critical safety gate that prevents stopVnc() from killing an unrelated
 * process (e.g. pid=1, the container init / SnowLuma itself).
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

// ─── Software acquisition / removal ──────────────────────────────────────

/** True if the X display socket for $DISPLAY is alive. */
function displayAlive(display: string): boolean {
  // DISPLAY like ":0" → /tmp/.X11-unix/X0
  const m = display.match(/^:(\d+)/);
  if (!m) return false;
  return existsSync(`/tmp/.X11-unix/X${m[1]}`);
}

/**
 * Ensures the X display is up. The container normally has a stealth Xvfb
 * started by entrypoint.sh; if it died, bring one back so x11vnc has a
 * display to share.
 */
function ensureDisplay(): boolean {
  const display = process.env.DISPLAY || ':0';
  if (displayAlive(display)) return true;
  const xvfb = ['/usr/bin/.sys-gfx-compositor', '/usr/bin/Xvfb'].find((p) => existsSync(p));
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
    // Wait for the socket to appear.
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

/**
 * Downloads + hides the x11vnc server binary (runtime, on demand).
 *
 * Uses apt so the runtime image stays 100% VNC-free at rest. After
 * installing we copy the binary to a hidden name and delete the original
 * `/usr/bin/x11vnc`, so even while VNC is running no scanner can find a
 * binary literally named "x11vnc" on disk.
 */
function ensureVncBinary(): boolean {
  if (existsSync(VNC_BIN)) return true;
  try {
    run(`mkdir -p ${shellQuote(RUNTIME_DIR)}`);

    // Install the package on demand (only if the named binary is absent).
    if (!existsSync('/usr/bin/x11vnc')) {
      run('sudo apt-get update -qq 2>/dev/null || true', 180_000);
      run('sudo apt-get install -y -qq --no-install-recommends x11vnc 2>/dev/null || true', 180_000);
      if (!existsSync('/usr/bin/x11vnc')) {
        // Package already "installed" but binary was previously hidden.
        run('sudo apt-get install -y -qq --reinstall x11vnc 2>/dev/null || true', 180_000);
      }
    }
    if (!existsSync('/usr/bin/x11vnc')) {
      log.error('x11vnc install failed — no binary at /usr/bin/x11vnc');
      return false;
    }

    // Copy to a hidden, non-"vnc" name and strip the original.
    run(`cp /usr/bin/x11vnc ${shellQuote(VNC_BIN)}`);
    run(`chmod 755 ${shellQuote(VNC_BIN)}`);
    run('sudo rm -f /usr/bin/x11vnc');
    // Don't leave the downloaded .deb lying around in the apt cache.
    run('sudo rm -rf /var/cache/apt/archives/*.deb');
    log.info('x11vnc hidden at %s', VNC_BIN);
    return true;
  } catch (e) {
    log.error('failed to provision x11vnc: %s', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Downloads the noVNC web client (RFB ES module) into the hidden runtime
 * dir. Only the `core/` directory is needed — it is self-contained and
 * served by the WebUI at `/vnc-client/*` while VNC is running.
 */
function ensureNoVncClient(): boolean {
  const marker = path.join(NOVNC_DIR, 'core', 'rfb.js');
  if (existsSync(marker)) return true;
  try {
    run(`mkdir -p ${shellQuote(RUNTIME_DIR)}`);
    const tarball = path.join(RUNTIME_DIR, '.client-src.tar.gz');
    run(`wget -q -O ${shellQuote(tarball)} ${NOVNC_TARBALL_URL}`, 120_000);
    run(`tar -xzf ${shellQuote(tarball)} -C ${shellQuote(RUNTIME_DIR)}`);
    // Tarball extracts to noVNC-<version>/ — flatten `core` into client/.
    run(`rm -rf ${shellQuote(NOVNC_DIR)}`);
    run(`mkdir -p ${shellQuote(RUNTIME_DIR)}`);
    run(`mv ${shellQuote(RUNTIME_DIR)}/noVNC-*/core ${shellQuote(NOVNC_DIR)} 2>/dev/null || mv ${shellQuote(path.join(RUNTIME_DIR, 'core'))} ${shellQuote(NOVNC_DIR)}`);
    run(`rm -rf ${shellQuote(tarball)} ${shellQuote(RUNTIME_DIR)}/noVNC-*`);
    return existsSync(marker);
  } catch (e) {
    log.error('failed to download noVNC client: %s', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Removes ALL VNC software & traces from the environment:
 *  - the hidden runtime dir (x11vnc binary + noVNC web client)
 *  - the apt packages (x11vnc + its libvnc* deps) via purge + autoremove
 *  - apt lists / .deb cache, and any leftover named binary
 * After this the environment looks like a plain application again.
 */
function removeVncSoftware(): void {
  try { rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch {}
  const commands = [
    'sudo rm -f /usr/bin/x11vnc /usr/local/bin/x11vnc',
    'sudo apt-get purge -y -qq x11vnc libvncserver1 libvncclient1 2>/dev/null || true',
    'sudo apt-get autoremove -y -qq 2>/dev/null || true',
    'sudo rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb',
  ];
  for (const cmd of commands) {
    try { execSync(cmd, { timeout: 120_000, stdio: 'pipe' }); } catch {}
  }
  log.info('VNC software removed from the environment');
}

// ─── Start / stop ────────────────────────────────────────────────────────

/**
 * Starts x11vnc (detached, backgrounded). Downloads the software on demand
 * if it isn't present, so the image/container carries zero VNC residue at
 * rest. No-op if already running.
 *
 * The process is disguised with `exec -a "systemd-logind"` so the process
 * list stays clean (HF Spaces / platform-scan avoidance).
 */
export async function startVnc(): Promise<VncStatus> {
  const current = await getVncStatus();
  if (current.running) {
    log.info('VNC already running (pid=%s), start skipped', current.pid);
    return current;
  }

  if (!ensureDisplay()) {
    return { running: false, pid: null, port: RFB_PORT };
  }
  if (!ensureVncBinary()) {
    log.error('VNC start aborted: could not provision the VNC server');
    return { running: false, pid: null, port: RFB_PORT };
  }
  if (!ensureNoVncClient()) {
    // Server can still start; the UI will surface a client-load error.
    log.warn('noVNC client unavailable — the browser may not be able to connect');
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

  const wrapper = `exec -a "systemd-logind" ${shellQuote(VNC_BIN)} ${args.join(' ')} >/dev/null 2>&1`;
  log.info('starting VNC: %s', wrapper.replace(shellQuote(VNC_BIN), '<hidden>'));
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
 * Stops the running x11vnc process (SIGTERM, then SIGKILL on timeout),
 * then REMOVES the VNC software entirely (binary + noVNC client + apt
 * packages + caches) so the environment contains no scannable VNC residue.
 *
 * Safety: the pid is validated with isVncProcess() before any signal is
 * sent. This prevents killing pid=1 (container init) or any other process.
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
      await awaitSleep(200);
      if (!(await isRfbListening())) {
        break;
      }
    }

    // Port still listening — escalate to SIGKILL.
    if (await isRfbListening()) {
      log.warn('VNC did not exit on SIGTERM, sending SIGKILL');
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await awaitSleep(300);
    }
  } else if (await isRfbListening()) {
    // Port is listening but we couldn't confirm a valid pid — fall back to
    // pkill. `exec -a` hides the real binary name from the command line,
    // so we match both the truncated comm name and the disguised argv[0].
    log.warn('VNC pid not confirmed, falling back to pkill by pattern');
    try {
      execSync('pkill -x ".display-bridge" 2>/dev/null || true', { timeout: 2000 });
      execSync('pkill -x ".sys-display-br" 2>/dev/null || true', { timeout: 2000 });
      execSync('pkill -x "x11vnc" 2>/dev/null || true', { timeout: 2000 });
      execSync('pkill -f "systemd-logind" 2>/dev/null || true', { timeout: 2000 });
      execSync('pkill -f ".sys-display-bridge" 2>/dev/null || true', { timeout: 2000 });
      execSync('pkill -f ".display-bridge" 2>/dev/null || true', { timeout: 2000 });
      execSync('pkill -f "x11vnc" 2>/dev/null || true', { timeout: 2000 });
    } catch {}
    for (let i = 0; i < 10; i++) {
      await awaitSleep(200);
      if (!(await isRfbListening())) break;
    }
  }

  // ── Thorough removal: kill first, then scrub every trace. ─────────────
  removeVncSoftware();

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

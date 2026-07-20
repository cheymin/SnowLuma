import net from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import { createLogger } from '@snowluma/common/logger';

const log = createLogger('VNC');

const VNC_HOST = '127.0.0.1';
const VNC_PORT = 5900;

export interface VncStatus {
  running: boolean;
  host: string;
  port: number;
}

/** Probe whether x11vnc is listening on localhost:5900. */
export async function probeVnc(): Promise<VncStatus> {
  return new Promise((resolve) => {
    const socket = net.connect(VNC_PORT, VNC_HOST);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ running: false, host: VNC_HOST, port: VNC_PORT });
    }, 1000);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ running: true, host: VNC_HOST, port: VNC_PORT });
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve({ running: false, host: VNC_HOST, port: VNC_PORT });
    });
  });
}

/**
 * Attach a WebSocket upgrade handler to the HTTP(S) server that proxies
 * RFB traffic to the local x11vnc instance. Authenticated via the panel's
 * session token — no separate VNC password.
 *
 * The handler only intercepts `/api/vnc/ws`; all other upgrade requests
 * are ignored (Hono / @hono/node-server don't use WS upgrades).
 */
export function attachVncProxy(
  server: HttpServer | HttpsServer,
  authenticate: (token: string) => boolean,
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/api/vnc/ws') return;

    const token = url.searchParams.get('token') ?? '';
    if (!authenticate(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      connectVnc(ws);
    });
  });

  function connectVnc(ws: WebSocket): void {
    const vnc = net.connect(VNC_PORT, VNC_HOST);
    let connected = false;

    vnc.on('connect', () => {
      connected = true;
      log.info('RFB client connected → %s:%d', VNC_HOST, VNC_PORT);
    });

    // VNC → WebSocket
    vnc.on('data', (data: Buffer) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    vnc.on('close', () => {
      log.info('RFB TCP closed');
      if (ws.readyState === ws.OPEN) ws.close();
    });

    vnc.on('error', (err) => {
      log.error('RFB TCP error: %s', err.message);
      if (ws.readyState === ws.OPEN) {
        ws.close(1011, 'VNC connection failed');
      }
    });

    // WebSocket → VNC
    ws.on('message', (data: RawData) => {
      if (connected) {
        vnc.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      }
    });

    ws.on('close', () => {
      log.info('RFB client disconnected');
      vnc.destroy();
    });

    ws.on('error', () => {
      vnc.destroy();
    });
  }

  log.info('VNC WebSocket proxy attached on /api/vnc/ws → %s:%d', VNC_HOST, VNC_PORT);
}

// RawData type from ws — inline to avoid importing the entire ws type surface.
type RawData = Buffer | ArrayBuffer | Buffer[];

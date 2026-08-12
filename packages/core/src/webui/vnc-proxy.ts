import { createLogger } from '@snowluma/common/logger';
import net from 'net';
import type { Server, IncomingMessage } from 'http';
import type { Server as HttpsServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import type { Socket } from 'net';

const log = createLogger('VncProxy');

const RFB_HOST = process.env.SNOWLUMA_VNC_HOST || '127.0.0.1';
const RFB_PORT = Number(process.env.SNOWLUMA_VNC_PORT || 5900);

export interface VncAuthChecker {
  /** Returns true if the bearer token is a valid, non-expired session. */
  isValidSession(token: string | undefined): boolean;
}

type AnyHttpServer = Server | HttpsServer;

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

import { WebSocket, WebSocketServer } from '@snowluma/websocket';
import type { IncomingMessage } from 'http';
import { createLogger } from '@snowluma/common/logger';
import {
  pickDispatchJson,
  resolveReportOptions,
  type DispatchPayload,
  type EventReportOptions,
} from '../event-filter';
import type { JsonObject, WsRole, WsServerNetwork } from '../types';
import { IOneBotNetworkAdapter, type AdapterStatus, type NetworkAdapterContext } from './adapter';
import { isAuthorized, normalizePath, parseRequestPath, rawDataToString, safeClose, safeSend, safeSendAsync, startHeartbeat } from './utils';

const moduleLog = createLogger('OneBot.WS-Server');
// Transport keepalive for each attached client, symmetric with the ws-client
// adapter: ping every 15s, reap a client only after 2 consecutive pings go
// unanswered — ~45s of total silence. Aggressive for reverse-proxy
// environments (HF Space, Cloudflare, etc.) where idle connections get
// torn down silently. Any inbound frame resets the counter.
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_MAX_MISSED = 2;
const HEARTBEAT_DEAD_AFTER_S = (HEARTBEAT_INTERVAL_MS * (HEARTBEAT_MAX_MISSED + 1)) / 1000;

interface ForwardConn {
  socket: WebSocket;
  role: WsRole;
  options: EventReportOptions;
  stopHeartbeat: () => void;
}

export class WsServerAdapter extends IOneBotNetworkAdapter<WsServerNetwork> {
  private wss: WebSocketServer | null = null;
  private listening = false;
  private closePromise: Promise<void> | null = null;
  private acceptingActions = false;
  private readonly inFlightActions = new Set<Promise<void>>();
  private connections = new Map<WebSocket, ForwardConn>();
  private options: EventReportOptions;

  constructor(name: string, config: WsServerNetwork, ctx: NetworkAdapterContext) {
    super(name, config, ctx, moduleLog);
    this.options = resolveReportOptions(config);
  }

  async open(): Promise<void> {
    if (this.isEnabled && this.listening) return;
    if (this.config.enabled === false) return;
    if (this.wss) throw new Error(`WebSocket adapter [${this.name}] still owns a previous server`);
    await this.startServer();
    this.isEnabled = true;
    this.clearApplyFailure();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!this.isEnabled && this.connections.size === 0 && !this.wss && this.inFlightActions.size === 0) return;
    const wasEnabled = this.isEnabled;
    const wasListening = this.listening;
    const wasAcceptingActions = this.acceptingActions;
    this.acceptingActions = false;
    // Final lifecycle broadcast before tearing down so attached event clients
    // see the disable transition.
    const lifecycle = this.ctx.buildLifecycleEvent('disable');
    for (const conn of this.connections.values()) {
      if (conn.role === 'Api') continue;
      const frame = this.metaFrame(lifecycle, conn.options);
      if (frame) safeSend(conn.socket, frame);
    }

    this.isEnabled = false;
    this.listening = false;
    for (const conn of this.connections.values()) {
      conn.stopHeartbeat();
      safeClose(conn.socket);
    }
    this.connections.clear();
    const wss = this.wss;
    const releaseResult: Promise<{ error?: Error }> = wss
      ? new Promise<{ error?: Error }>((resolve) => {
        wss.close((error) => resolve(error && !isAlreadyClosedError(error) ? { error } : {}));
      })
      : Promise.resolve({});
    const attempt = (async () => {
      await Promise.all(this.inFlightActions);
      const release = await releaseResult;
      if (release.error) throw release.error;
    })();
    this.closePromise = attempt;
    try {
      await attempt;
      if (wss && this.wss === wss) this.wss = null;
    } catch (error) {
      // A failed close callback leaves release ambiguous. Retain the server
      // reference and active binding state so a later shutdown can retry.
      this.isEnabled = wasEnabled;
      this.listening = wasListening;
      this.acceptingActions = wasAcceptingActions;
      throw error;
    } finally {
      this.closePromise = null;
    }
  }

  override describeStatus(): AdapterStatus {
    if (!this.isEnabled) return { name: this.name, kind: 'wsServer', status: 'disabled', detail: '未启用' };
    if (!this.listening) return { name: this.name, kind: 'wsServer', status: 'down', detail: '未监听（端口被占用？）' };
    return { name: this.name, kind: 'wsServer', status: 'ok', detail: `${this.connections.size} 个客户端` };
  }

  protected override bindingSignature(config: WsServerNetwork): string {
    return `${config.host ?? '0.0.0.0'}:${config.port}${normalizePath(config.path)}#${config.role ?? 'auto'}#${config.accessToken ?? ''}`;
  }

  protected override onConfigReplaced(next: WsServerNetwork): void {
    this.options = resolveReportOptions(next);
    for (const conn of this.connections.values()) conn.options = this.options;
  }

  onEvent(_event: JsonObject, payload: DispatchPayload): void {
    if (!this.isEnabled || this.connections.size === 0) return;
    for (const conn of this.connections.values()) {
      if (conn.role !== 'Event' && conn.role !== 'Universal') continue;
      const json = pickDispatchJson(payload, conn.options);
      if (json === null) continue;
      safeSend(conn.socket, json);
    }
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      let wss: WebSocketServer;
      try {
        wss = new WebSocketServer({
          host: this.config.host ?? '0.0.0.0',
          port: this.config.port,
          path: normalizePath(this.config.path),
        });
      } catch (error) {
        this.recordTransportFailure(error);
        reject(error);
        return;
      }
      this.wss = wss;
      let opening = true;

      wss.once('listening', () => {
        opening = false;
        if (this.wss !== wss || this.closePromise) {
          wss.close();
          reject(new Error(`WebSocket adapter [${this.name}] was closed while binding`));
          return;
        }
        this.listening = true;
        this.isEnabled = true;
        this.acceptingActions = true;
        this.log.success(
          '[%s] listening %s:%d%s',
          this.name,
          this.config.host ?? '0.0.0.0',
          this.config.port,
          this.config.path ?? '/',
        );
        resolve();
      });

      wss.on('error', (error: Error) => {
        if (this.wss === wss) {
          this.listening = false;
          this.isEnabled = false;
          this.acceptingActions = false;
          this.recordTransportFailure(error);
          if (opening) this.wss = null;
        }
        this.log.error('[%s] server error: %s', this.name, error instanceof Error ? error.message : String(error));
        if (opening) {
          opening = false;
          reject(error);
        }
      });

      wss.on('connection', (socket: WebSocket, request: IncomingMessage) => this.onConnection(socket, request));
    });
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    if (!this.acceptingActions || this.ctx.api.isAcceptingActions === false) {
      safeClose(socket, 1012, 'server closing');
      return;
    }
    if (!isAuthorized(request, this.config.accessToken ?? '')) {
      safeClose(socket, 1008, 'invalid access token');
      return;
    }

    const role = this.config.role ?? classifyForwardRole(request);
    const stopHeartbeat = startHeartbeat(
      socket,
      { intervalMs: HEARTBEAT_INTERVAL_MS, maxMissed: HEARTBEAT_MAX_MISSED },
      () => {
        this.log.warn('[%s] client silent for ~%ds, terminating half-open connection', this.name, HEARTBEAT_DEAD_AFTER_S);
        socket.terminate(); // → 'close' → connections.delete; the client reconnects on its own
      },
    );
    const conn: ForwardConn = { socket, role, options: this.options, stopHeartbeat };
    this.connections.set(socket, conn);

    socket.on('message', (raw: Buffer) => {
      this.trackInboundAction(() => this.handleApiMessage(socket, role, raw));
    });
    socket.on('close', () => {
      stopHeartbeat();
      this.connections.delete(socket);
    });
    socket.on('error', (err: Error) => {
      this.log.warn('[%s] socket error: %s', this.name, err instanceof Error ? err.message : String(err));
    });

    if (role === 'Event' || role === 'Universal') {
      this.sendBootstrapMetaEvents(socket);
    }
  }

  private async handleApiMessage(socket: WebSocket, role: WsRole, raw: Buffer | string): Promise<void> {
    if (role !== 'Api' && role !== 'Universal') return;
    const text = rawDataToString(raw);
    if (!text) return;
    // Stream API (#163) emits multiple frames per request; processStreamRequest
    // sends one frame for a normal action and N for a streaming one. The async
    // send applies backpressure (awaits flush); the liveness check aborts a
    // streaming action once the client goes away.
    await this.ctx.api.processStreamRequest(
      text,
      (frame) => safeSendAsync(socket, frame),
      () => socket.readyState === 1,
    );
  }

  private trackInboundAction(start: () => Promise<void>): void {
    if (!this.acceptingActions || this.ctx.api.isAcceptingActions === false) {
      this.log.warn('[%s] rejected inbound action while adapter is closing', this.name);
      return;
    }
    let action: Promise<void>;
    try {
      action = start();
    } catch (error) {
      this.log.error('[%s] inbound action start failed: %s', this.name, error instanceof Error ? (error.stack ?? error.message) : String(error));
      return;
    }
    const tracked = action.then(
      () => undefined,
      (error) => {
        this.log.error('[%s] inbound action failed: %s', this.name, error instanceof Error ? (error.stack ?? error.message) : String(error));
      },
    );
    this.inFlightActions.add(tracked);
    void tracked.then(() => { this.inFlightActions.delete(tracked); });
  }

  private sendBootstrapMetaEvents(socket: WebSocket): void {
    for (const frame of this.bootstrapMetaFrames(this.options)) safeSend(socket, frame);
  }
}

function isAlreadyClosedError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING';
}

function classifyForwardRole(request: IncomingMessage): WsRole {
  const path = parseRequestPath(request.url ?? '/');
  if (path.endsWith('/api')) return 'Api';
  if (path.endsWith('/event')) return 'Event';
  return 'Universal';
}

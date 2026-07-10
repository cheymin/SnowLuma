import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { HttpServerNetwork } from '../src/types';

describe('HttpServerAdapter inbound Action ownership', () => {
  let adapter: HttpServerAdapter | null = null;

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
  });

  it('waits for a detached Action after the HTTP client disconnects', async () => {
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    let actionStarted!: () => void;
    const started = new Promise<void>((resolve) => { actionStarted = resolve; });
    const apiHandle = vi.fn(async () => {
      actionStarted();
      await actionGate;
      return { status: 'ok' as const, retcode: 0, data: { done: true } };
    });
    const ctx: NetworkAdapterContext = {
      uin: '10001',
      api: { handle: apiHandle, isStreamAction: () => false } as never,
      buildLifecycleEvent: () => ({}),
      buildHeartbeatEvent: () => ({}),
    };
    const config: HttpServerNetwork = {
      name: 'http-action-drain',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter(config.name, config, ctx);
    await adapter.open();
    const server = (adapter as unknown as { server: http.Server }).server;
    const port = (server.address() as AddressInfo).port;
    const serverSocketClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => {
        socket.once('close', () => resolve());
      });
    });

    const request = http.request({ host: '127.0.0.1', port, path: '/slow', method: 'GET' });
    request.on('error', () => { /* expected after destroy */ });
    request.end();
    await started;
    request.destroy();
    // Prove the transport socket is already gone before close(). Otherwise
    // server.close() itself could be the thing keeping this test pending and
    // hide a missing detached-Action drain.
    await serverSocketClosed;

    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    releaseAction();
    await closing;
    expect(closed).toBe(true);
    expect(apiHandle).toHaveBeenCalledOnce();
    adapter = null;
  });
});

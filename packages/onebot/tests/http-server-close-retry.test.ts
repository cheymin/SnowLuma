import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { HttpServerNetwork } from '../src/types';

let apiAccepting = true;
const CTX: NetworkAdapterContext = {
  uin: '10001',
  api: {
    get isAcceptingActions() { return apiAccepting; },
  } as never,
  buildLifecycleEvent: () => ({}),
  buildHeartbeatEvent: () => ({}),
};

describe('HttpServerAdapter close ownership', () => {
  it('retains the server reference after callback failure and retries it', async () => {
    apiAccepting = true;
    const config: HttpServerNetwork = {
      name: 'http',
      host: '127.0.0.1',
      port: 3000,
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    const adapter = new HttpServerAdapter('http', config, CTX);
    let callback: ((error?: Error) => void) | null = null;
    const server = {
      close(next: (error?: Error) => void) { callback = next; },
    };
    Object.assign(adapter as unknown as Record<string, unknown>, {
      server,
      isEnabled: true,
      listening: true,
      acceptingActions: true,
    });

    const firstClose = adapter.close();
    callback!(new Error('release failed'));
    await expect(firstClose).rejects.toThrow('release failed');
    expect((adapter as unknown as { server: unknown }).server).toBe(server);
    expect(adapter.describeStatus().status).toBe('ok');

    expect((adapter as unknown as { acceptingActions: boolean }).acceptingActions).toBe(true);
    apiAccepting = false;
    const response = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    (adapter as unknown as {
      trackInboundAction(req: IncomingMessage, res: ServerResponse): void;
    }).trackInboundAction({} as IncomingMessage, response);
    expect(response.statusCode).toBe(503);
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('server closing'));

    const secondClose = adapter.close();
    callback!();
    await secondClose;
    expect((adapter as unknown as { server: unknown }).server).toBeNull();
    expect(adapter.describeStatus().status).toBe('disabled');
  });
});

import net from 'net';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Duplex } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listLiveLinuxPipePids, QqHookClient } from '../src/qq-hook-client';

let tmpDir: string | null = null;

async function makeRuntimeDir(): Promise<string> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snowluma-hook-'));
  return tmpDir;
}

afterEach(async () => {
  if (!tmpDir) return;
  await rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('listLiveLinuxPipePids', () => {
  it('ignores stale-looking control socket names when the probe rejects them', async () => {
    const runtimeDir = await makeRuntimeDir();
    await writeFile(path.join(runtimeDir, 'mojo.55.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.55.recv.sock'), '');

    const pids = await listLiveLinuxPipePids(runtimeDir, async () => false);

    expect([...pids]).toEqual([]);
  });

  it('returns only connectable control sockets', async () => {
    const runtimeDir = await makeRuntimeDir();
    await writeFile(path.join(runtimeDir, 'mojo.55.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.56.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.56.recv.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.not-a-pid.control.sock'), '');

    const probe = vi.fn(async (socketPath: string) => socketPath.endsWith('mojo.56.control.sock'));
    const pids = await listLiveLinuxPipePids(runtimeDir, probe);

    expect([...pids]).toEqual([56]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('QqHookClient — pipe close mid-send', () => {
  // Regression: when the control pipe closes while a send() is awaiting its
  // ack, rejectControlPending() rejects BOTH the ack and reply deferreds. The
  // reply is only `await`ed after the ack, so if the ack rejects first the
  // reply promise is rejected with NO awaiter — an UNHANDLED rejection that
  // crashes the Node process (Docker: supervisor restarts it ~1s later; on
  // Windows it just dies → "connection pipe closed", bot down). The .catch()
  // guard on each deferred prevents it; without the guard this test trips the
  // unhandledRejection assertion below.
  it('does not raise an unhandled rejection', async () => {
    const PID = 778899;
    const helloFrame = (): Buffer => {
      const h = Buffer.alloc(40);
      h.writeUInt32LE(0x31504851, 0);       // PIPE_MAGIC
      h.writeUInt16LE(1, 4);                // PIPE_VERSION
      h.writeUInt16LE(1, 6);                // PipeOp.hello
      h.writeBigUInt64LE(BigInt(PID), 32);  // value0 = pid
      return h;
    };

    let controlConn: net.Socket | null = null;
    let signalControlWrite!: () => void;
    const controlWriteStarted = new Promise<void>((resolve) => { signalControlWrite = resolve; });
    const createConnection = vi.spyOn(net, 'createConnection').mockImplementation((() => {
      const socket = new Duplex({
        read() { /* peer data is injected with emit('data') */ },
        write(_chunk, _encoding, callback) {
          signalControlWrite();
          callback();
        },
      }) as net.Socket;
      controlConn = socket;
      queueMicrotask(() => {
        socket.emit('connect');
        queueMicrotask(() => socket.emit('data', helloFrame()));
      });
      return socket;
    }) as typeof net.createConnection);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    const client = new QqHookClient(PID);
    client.on('error', () => { /* socket reset on destroy — ignore */ });
    try {
      await client.connect();

      // Start a reply-expecting send, let it reach the in-flight (awaiting-ack)
      // state, then have the "hook" drop the pipe before it answers.
      const sent = client.send('noop', null, { wantReply: true, ackTimeoutMs: 1000, replyTimeoutMs: 1000 })
        .then(() => 'resolved' as const, (e: unknown) => e);
      await controlWriteStarted;
      controlConn?.destroy();

      const outcome = await sent;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('control pipe closed');
      expect(unhandled, `unhandled rejections leaked: ${unhandled.map(String).join(', ')}`).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      client.close();
      createConnection.mockRestore();
    }
  });
});

// highway-client.uploadHighwayHttp 的连接生命周期测试。
//
// 方案 3（#211）：单连接、按 offset 顺序、流水线上传，跨 chunk 复用同一个
// TCP 连接（HTTP keep-alive）。要点：
//   - 顺序发送 → 天然保序，避开 QQ highway 对乱序块的 error_code=102902；
//   - 复用连接 → TCP 拥塞窗口全程保持，省掉每块新建连接的 slow-start。
// 边缘节点可能在响应后 FIN（#118）；此时自适应地丢弃 socket + 重连 + 重发
// 同一块（重发幂等），最坏退化成“每块一连接”，不比旧实现差，且仍然保序。
//
// 本测试用两种 mock 服务端行为锁定这套自适应逻辑：
//   - keepalive：每个 POST 回一个响应，连接保持 → 整个文件 1 个连接；
//   - closeafter：每个响应后半关闭（readableEnded/emit close）→ 退化成每块
//     一连接，但仍全部成功。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// highway-client 解析响应只关心 errorCode === 0 —— 一个完全空的
// RespDataHighwayHead protobuf 体（0 字节）会被解为 errorCode=undefined，
// 走 falsy 通过分支。
// highway frame：0x28 | head_len(BE32) | body_len(BE32) | head | body | 0x29
function buildEmptyHighwayResponseFrame(): Buffer {
  const frame = Buffer.alloc(10);
  frame[0] = 0x28;
  frame.writeUInt32BE(0, 1); // head_len
  frame.writeUInt32BE(0, 5); // body_len
  frame[9] = 0x29;
  return frame;
}

// errorCode 帧：RespDataHighwayHead.field3 (errorCode) = 921。tag(field3,
// varint)=0x18，varint(921)=0x99 0x07。定义即拒绝（不重试）。
function buildErrorCodeFrame(): Buffer {
  const head = Buffer.from([0x18, 0x99, 0x07]);
  const frame = Buffer.alloc(9 + head.length + 1);
  frame[0] = 0x28;
  frame.writeUInt32BE(head.length, 1);
  frame.writeUInt32BE(0, 5);
  head.copy(frame, 9);
  frame[9 + head.length] = 0x29;
  return frame;
}

function httpWrap(frame: Buffer): Buffer {
  const headers = ['HTTP/1.1 200 OK', `Content-Length: ${frame.length}`, '', ''].join('\r\n');
  return Buffer.concat([Buffer.from(headers, 'ascii'), frame]);
}

type ServerMode = 'keepalive' | 'closeafter';

// FakeSocket 模拟 net.Socket 的最小子集，支持在一个连接上顺序处理多个 POST。
// 累积写入的字节，按 `\r\n\r\n` + Content-Length 切出每个完整 POST，逐个回
// 响应。`mode` 控制响应后是否半关闭；`failOnPost` 用于模拟链路中途断开。
class FakeSocket extends EventEmitter {
  destroyed = false;
  readableEnded = false;
  writable = true;
  posts = 0;
  private buf = Buffer.alloc(0);
  constructor(
    private readonly responseFrame: Buffer,
    private readonly mode: ServerMode,
    private readonly failOnPost = -1,
    private readonly truncateOnPost = -1,
  ) {
    super();
  }

  setTimeout(_ms?: number) { /* no-op */ }

  write(data: unknown, cb?: (err?: Error) => void): boolean {
    if (this.destroyed || !this.writable) {
      const err = new Error('write after socket end');
      if (cb) cb(err);
      setImmediate(() => this.emit('error', err));
      return false;
    }
    this.buf = Buffer.concat([this.buf, Buffer.from(data as Uint8Array)]);
    this.drainPosts();
    if (cb) cb();
    return true;
  }

  private drainPosts(): void {
    for (;;) {
      const s = this.buf.toString('latin1');
      const he = s.indexOf('\r\n\r\n');
      if (he < 0) return;
      const m = s.slice(0, he).match(/content-length:\s*(\d+)/i);
      const cl = m ? parseInt(m[1], 10) : 0;
      const total = he + 4 + cl;
      if (this.buf.length < total) return;
      this.buf = this.buf.subarray(total);
      this.posts += 1;
      const thisPost = this.posts;
      setImmediate(() => {
        if (this.destroyed) return;
        if (thisPost === this.failOnPost) {
          this.writable = false;
          this.readableEnded = true;
          this.emit('error', new Error('ECONNRESET'));
          this.emit('close');
          return;
        }
        if (thisPost === this.truncateOnPost) {
          // Send the HTTP header + only part of the declared body, then FIN —
          // a truncated response. Dropping the last 3 body bytes keeps the
          // header intact so Content-Length parses but is never satisfied.
          const full = httpWrap(this.responseFrame);
          this.emit('data', full.subarray(0, full.length - 3));
          this.writable = false;
          this.readableEnded = true;
          this.emit('close');
          return;
        }
        this.emit('data', httpWrap(this.responseFrame));
        if (this.mode === 'closeafter') {
          this.readableEnded = true;
          this.writable = false;
          this.emit('end');
          this.emit('close');
        }
      });
    }
  }

  destroy() {
    this.destroyed = true;
    this.writable = false;
  }
}

// vitest 把 vi.mock 工厂 hoist 到文件顶部，所以工厂里不能引用普通的顶层
// const。用 vi.hoisted 让这些值跟着 mock 一起 hoist。
const { createdSockets, socketFactoryRef, createConnectionMock } = vi.hoisted(() => ({
  createdSockets: [] as unknown[],
  socketFactoryRef: { make: null as null | ((idx: number) => unknown) },
  createConnectionMock: vi.fn(),
}));

vi.mock('net', () => ({
  default: { createConnection: createConnectionMock },
  createConnection: createConnectionMock,
}));

import {
  uploadHighwayHttp,
  BufferChunkSource,
  type ChunkSource,
  type HighwaySession,
} from '@snowluma/protocol/highway';
import type { BridgeContext } from '@snowluma/protocol/bridge-context';

const HIGHWAY_BLOCK_SIZE = 1024 * 1024;

function makeBridge(): BridgeContext {
  return { identity: { uin: '10001' } as unknown } as unknown as BridgeContext;
}

function makeSession(): HighwaySession {
  return {
    sigSession: new Uint8Array([0xAA]),
    sessionKey: new Uint8Array([0xBB]),
    host: '127.0.0.1',
    port: 80,
  };
}

// 安装一个 socket 工厂：createConnection 每次调用按序号创建一个 FakeSocket。
function installFactory(make: (idx: number) => FakeSocket): void {
  createdSockets.length = 0;
  socketFactoryRef.make = make as (idx: number) => unknown;
  createConnectionMock.mockReset();
  createConnectionMock.mockImplementation((_opts: unknown, listener?: () => void) => {
    const idx = createdSockets.length;
    const sock = socketFactoryRef.make!(idx) as FakeSocket;
    createdSockets.push(sock);
    if (listener) setImmediate(listener); // 握手成功后异步回调 → tcpConnect resolve
    return sock as unknown as ReturnType<typeof createConnectionMock>;
  });
}

// 顺序读取记录：offset/length + 关闭时机，用于数据完整性与 close 语义。
class RecordingChunkSource implements ChunkSource {
  reads: Array<{ offset: number; length: number }> = [];
  inFlight = 0;
  closeCount = 0;
  closedWhileReading = false;
  constructor(readonly size: number) {}
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.inFlight += 1;
    this.reads.push({ offset, length });
    await Promise.resolve();
    this.inFlight -= 1;
    return new Uint8Array(length);
  }
  async close(): Promise<void> {
    if (this.inFlight > 0) this.closedWhileReading = true;
    this.closeCount += 1;
  }
}

describe('uploadHighwayHttp single-connection pipelined upload (#211)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reuses ONE connection for a multi-block payload when keep-alive holds', async () => {
    installFactory(() => new FakeSocket(buildEmptyHighwayResponseFrame(), 'keepalive'));
    const bytes = new Uint8Array(Math.floor(2.5 * HIGHWAY_BLOCK_SIZE)); // 3 blocks
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1004, new BufferChunkSource(bytes), new Uint8Array(16), new Uint8Array(0),
    );
    // The whole file went over a single warm connection — the #211 win.
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('single sub-block payload uses one connection', async () => {
    installFactory(() => new FakeSocket(buildEmptyHighwayResponseFrame(), 'keepalive'));
    const bytes = new Uint8Array(512 * 1024); // 1 block (PTT / small image)
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1003, new BufferChunkSource(bytes), new Uint8Array(16), new Uint8Array(0),
    );
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('a zero-length source opens ZERO connections (empty-input invariant)', async () => {
    installFactory(() => new FakeSocket(buildEmptyHighwayResponseFrame(), 'keepalive'));
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1003, new BufferChunkSource(new Uint8Array(0)), new Uint8Array(16), new Uint8Array(0),
    );
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it('degrades to one connection per block when the server FINs after every response (#118 regime)', async () => {
    installFactory(() => new FakeSocket(buildEmptyHighwayResponseFrame(), 'closeafter'));
    const bytes = new Uint8Array(Math.floor(2.5 * HIGHWAY_BLOCK_SIZE)); // 3 blocks
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1004, new BufferChunkSource(bytes), new Uint8Array(16), new Uint8Array(0),
    );
    // Server closes after each response → adaptively reconnects per block, but
    // the upload still completes. No worse than the old one-conn-per-chunk.
    expect(createConnectionMock).toHaveBeenCalledTimes(3);
  });

  it('reconnects and re-sends the SAME block on a mid-stream transport error', async () => {
    // First connection dies while handling its first POST; a fresh connection
    // must re-send that same block (offset unchanged, idempotent) and finish.
    installFactory((idx) =>
      idx === 0
        ? new FakeSocket(buildEmptyHighwayResponseFrame(), 'keepalive', /* failOnPost */ 1)
        : new FakeSocket(buildEmptyHighwayResponseFrame(), 'keepalive'),
    );
    const bytes = new Uint8Array(Math.floor(2.5 * HIGHWAY_BLOCK_SIZE)); // 3 blocks
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1004, new BufferChunkSource(bytes), new Uint8Array(16), new Uint8Array(0),
    );
    // Connection #0 failed on block 0 → reconnect (#1) resumes and keep-alives
    // the rest: exactly two connections total.
    expect(createConnectionMock).toHaveBeenCalledTimes(2);
  });

  it('reconnects and re-sends the block when a response body is truncated mid-stream', async () => {
    // Peer FINs after the HTTP header but before the highway body is complete.
    // That truncation must be treated as a retryable transport failure (reject
    // in readHttpResponseBody), NOT resolved as a partial frame — otherwise
    // unpackHighwayFrame throws OUTSIDE the retry loop and fails the upload.
    installFactory((idx) =>
      idx === 0
        ? new FakeSocket(buildEmptyHighwayResponseFrame(), 'keepalive', -1, /* truncateOnPost */ 1)
        : new FakeSocket(buildEmptyHighwayResponseFrame(), 'keepalive'),
    );
    const bytes = new Uint8Array(Math.floor(2.5 * HIGHWAY_BLOCK_SIZE)); // 3 blocks
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1004, new BufferChunkSource(bytes), new Uint8Array(16), new Uint8Array(0),
    );
    // conn #0 truncated block 0 → reconnect (#1) re-sends it and finishes.
    expect(createConnectionMock).toHaveBeenCalledTimes(2);
  });

  it('reads every offset exactly once, in order, and closes the source once (data safety)', async () => {
    installFactory(() => new FakeSocket(buildEmptyHighwayResponseFrame(), 'keepalive'));
    const size = 4 * HIGHWAY_BLOCK_SIZE + 4321; // 4 full + 1 ragged
    const source = new RecordingChunkSource(size);
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1004, source, new Uint8Array(16), new Uint8Array(0),
    );
    const offsets = source.reads.map((r) => r.offset);
    // Strictly increasing, gap-free, exactly-once coverage of [0, size).
    expect(offsets).toEqual([0, HIGHWAY_BLOCK_SIZE, 2 * HIGHWAY_BLOCK_SIZE, 3 * HIGHWAY_BLOCK_SIZE, 4 * HIGHWAY_BLOCK_SIZE]);
    expect(source.reads[source.reads.length - 1]!.length).toBe(4321); // ragged tail
    expect(source.reads.reduce((n, r) => n + r.length, 0)).toBe(size);
    expect(source.closeCount).toBe(1);
    expect(source.closedWhileReading).toBe(false);
  });

  it('rejects on a definitive server error_code and closes the source once (no retry)', async () => {
    installFactory(() => new FakeSocket(buildErrorCodeFrame(), 'keepalive'));
    const source = new RecordingChunkSource(3 * HIGHWAY_BLOCK_SIZE);
    await expect(uploadHighwayHttp(
      makeBridge(), makeSession(), 1004, source, new Uint8Array(16), new Uint8Array(0),
    )).rejects.toThrow(/error_code=921/);
    expect(source.closeCount).toBe(1);
    expect(source.closedWhileReading).toBe(false);
    // Definitive reject on block 0 → stop immediately, don't PUT later blocks.
    expect(source.reads.length).toBeLessThan(3);
  });
});

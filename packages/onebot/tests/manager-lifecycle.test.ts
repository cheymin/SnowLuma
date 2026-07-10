import { describe, expect, it, vi } from 'vitest';
import type { AdapterStatus } from '../src/network';
import type { OneBotInstance } from '../src/instance';
import { OneBotManager } from '../src/manager';

function fakeInstance(
  uin: string,
  dispose: () => Promise<unknown>,
  statuses: AdapterStatus[] = [],
  quiesce: () => void = () => {},
): OneBotInstance {
  return {
    uin,
    nickname: `retiring-${uin}`,
    quiesce,
    dispose,
    getConnectionStatuses: () => statuses,
  } as unknown as OneBotInstance;
}

describe('OneBotManager lifecycle failure accounting', () => {
  it('quiesces active instances before waiting for pending lifecycle work', async () => {
    const manager = new OneBotManager();
    let finishLifecycle!: () => void;
    const lifecycleGate = new Promise<void>((resolve) => { finishLifecycle = resolve; });
    const quiesce = vi.fn();
    const dispose = vi.fn(async () => ({ closed: true, errors: [] }));
    const instance = fakeInstance('10001', dispose, [], quiesce);
    const internals = manager as unknown as {
      instances: Map<string, OneBotInstance>;
      trackLifecycle(label: string, operation: Promise<unknown>): void;
    };
    internals.instances.set('10001', instance);
    internals.trackLifecycle('deferred startup', lifecycleGate);

    const disposing = manager.dispose();
    expect(quiesce).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();

    finishLifecycle();
    await disposing;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains a tracked rejection until final dispose reports it', async () => {
    const manager = new OneBotManager();
    (manager as unknown as {
      trackLifecycle(label: string, operation: Promise<unknown>): void;
    }).trackLifecycle('probe shutdown', Promise.reject(new Error('release failed')));

    await expect(manager.dispose()).rejects.toThrow(/failed to dispose OneBot manager cleanly/);
  });

  it('keeps a failed retire visible and blocks a conflicting same-UIN generation', async () => {
    const manager = new OneBotManager();
    const degraded: AdapterStatus = {
      name: 'old-http',
      kind: 'httpServer',
      status: 'degraded',
      detail: 'release failed',
      lastError: 'release failed',
      lastErrorAt: Date.now(),
    };
    const old = fakeInstance('10001', async () => { throw new Error('release failed'); }, [degraded]);
    (manager as unknown as { retiringInstances: Set<OneBotInstance> }).retiringInstances.add(old);
    const bridge = {} as never;

    (manager as unknown as { onSessionStarted(uin: string, bridge: never): void })
      .onSessionStarted('10001', bridge);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.getInstance('10001')).toBeNull();
    expect(manager.getConnectionStatuses()).toEqual([{
      uin: '10001',
      nickname: 'retiring-10001',
      adapters: [degraded],
    }]);
    expect((manager as unknown as { pendingStarts: Map<string, unknown> }).pendingStarts.has('10001')).toBe(false);
  });

  it('allows a later same-UIN start observation to retry a failed handoff', async () => {
    const manager = new OneBotManager();
    let attempts = 0;
    let finishRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { finishRetry = resolve; });
    const old = fakeInstance('10001', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first release failed');
      await retryGate;
      return { closed: true, errors: [] };
    });
    const internals = manager as unknown as {
      retiringInstances: Set<OneBotInstance>;
      onSessionStarted(uin: string, bridge: never): void;
      onSessionClosed(uin: string): void;
      pendingStarts: Map<string, unknown>;
    };
    internals.retiringInstances.add(old);
    internals.onSessionStarted('10001', {} as never);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(internals.pendingStarts.has('10001')).toBe(false);

    internals.onSessionStarted('10001', {} as never);
    expect(internals.pendingStarts.has('10001')).toBe(true);
    // The replacement session disappears while the retry is pending; cancel
    // creation so the test never needs a concrete Bridge.
    internals.onSessionClosed('10001');
    finishRetry();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(manager.getInstance('10001')).toBeNull();
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it('binds a multi-generation handoff failure only to the generation that failed', async () => {
    const manager = new OneBotManager();
    const a = fakeInstance('10001', async () => ({ closed: true, errors: [] }));
    let bAttempts = 0;
    const b = fakeInstance('10001', async () => {
      bAttempts += 1;
      if (bAttempts === 1) throw new Error('B release failed');
      return { closed: true, errors: [] };
    });
    const internals = manager as unknown as {
      retiringInstances: Set<OneBotInstance>;
      onSessionStarted(uin: string, bridge: never): void;
    };
    internals.retiringInstances.add(a);
    internals.retiringInstances.add(b);
    internals.onSessionStarted('10001', {} as never);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(internals.retiringInstances.has(a)).toBe(false);
    expect(internals.retiringInstances.has(b)).toBe(true);
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(bAttempts).toBe(2);
  });

  it('does not let a successful same-UIN generation clear another generation failure', async () => {
    const manager = new OneBotManager();
    const a = fakeInstance('10001', async () => { throw new Error('A still owns port'); });
    const b = fakeInstance('10001', async () => undefined);
    const internals = manager as unknown as {
      retiringInstances: Set<OneBotInstance>;
      trackLifecycle(label: string, operation: Promise<unknown>, instances?: OneBotInstance[]): void;
    };
    internals.retiringInstances.add(a);
    internals.retiringInstances.add(b);
    internals.trackLifecycle(
      'network shutdown UIN=10001',
      Promise.reject(new Error('A previous failure')),
      [a],
    );

    await expect(manager.dispose()).rejects.toThrow(/failed to dispose OneBot manager cleanly/);
  });
});

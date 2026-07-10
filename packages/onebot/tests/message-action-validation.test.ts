import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import type { OneBotInstanceContext } from '../src/instance-context';
import { sendGroupMessage } from '../src/modules/message-actions';

function instanceContext(sendGroup: ReturnType<typeof vi.fn>): OneBotInstanceContext {
  const bridge = {
    apis: { message: { sendGroup } },
    resolveUserUid: vi.fn(async () => 'u_peer'),
  } as unknown as BridgeInterface;

  return {
    uin: '10001',
    selfId: 10001,
    bridge,
    messageStore: {
      resolveReplySequence: () => 0,
      findEvent: () => null,
      findMeta: () => null,
    } as never,
    cacheMessageMeta: vi.fn(),
    mediaStore: {} as never,
    musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
}

describe('outbound message validation at the Action boundary', () => {
  it('returns BAD_REQUEST and performs no send when a later segment is unknown', async () => {
    const bridgeSend = vi.fn();
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [
        { type: 'text', data: { text: 'must not be sent' } },
        { type: 'unknown_late_segment', data: {} },
      ],
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: expect.stringContaining('unknown message segment type'),
    });
    expect(bridgeSend).not.toHaveBeenCalled();
  });

  it('returns BAD_REQUEST and performs no send for malformed JSON cards', async () => {
    const bridgeSend = vi.fn();
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [{ type: 'json', data: { data: 'not-json' } }],
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: expect.stringContaining('must contain a JSON object'),
    });
    expect(bridgeSend).not.toHaveBeenCalled();
  });
});

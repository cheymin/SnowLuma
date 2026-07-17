import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../src/message-id';
import { MessageStore } from '../src/message-store';
import { getFriendHistory, getFriendMsgHistory, getGroupHistory } from '../src/modules/message-actions';

const SELF_ID = 1787882683;
const GROUP_ID = 941657197;
const FRIEND_ID = 123456789;

const converterCtx = {
  selfId: SELF_ID,
  imageUrlResolver: null,
  mediaUrlResolver: null,
  messageIdResolver: null,
  mediaSegmentSink: null,
};

function groupMessage(sequence: number) {
  return {
    kind: 'group_message' as const,
    groupId: GROUP_ID,
    groupName: 'test',
    senderUin: FRIEND_ID,
    senderNick: 'friend',
    senderCard: '',
    senderRole: 'member',
    msgSeq: sequence,
    msgId: sequence,
    time: sequence,
    selfUin: SELF_ID,
    elements: [{ type: 'text' as const, text: String(sequence) }],
  };
}

function friendMessage(sequence: number, senderUin: number) {
  return {
    kind: 'friend_message' as const,
    senderUin,
    senderNick: senderUin === SELF_ID ? 'self' : 'friend',
    msgSeq: sequence,
    msgId: sequence,
    time: sequence,
    selfUin: SELF_ID,
    elements: [{ type: 'text' as const, text: String(sequence) }],
  };
}

describe('history direction plumbing', () => {
  let messageStore: MessageStore;

  beforeEach(() => {
    messageStore = new MessageStore(':memory:');
  });

  afterEach(() => {
    messageStore.close();
  });

  it('returns the group anchor followed by newer server messages', async () => {
    const fetchHistory = vi.fn(async (...args: unknown[]) =>
      args[4] === false ? [groupMessage(500), groupMessage(501)] : [groupMessage(499), groupMessage(500)]);
    messageStore.storeMeta(-123456789, {
      isGroup: true,
      targetId: GROUP_ID,
      sequence: 500,
      eventName: GROUP_MESSAGE_EVENT,
      clientSequence: 0,
      random: 0,
      timestamp: 0,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        apis: { message: { getGroupHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    const messages = await getGroupHistory(ref, GROUP_ID, -123456789, 20, false);

    expect(messages.map((message) => message.message_seq)).toEqual([500, 501]);
  });

  it('keeps self-sent private history in the requested friend conversation', async () => {
    const fetchHistory = vi.fn(async (...args: unknown[]) =>
      args[4] === false
        ? [friendMessage(700, SELF_ID), friendMessage(701, FRIEND_ID)]
        : [friendMessage(699, FRIEND_ID), friendMessage(700, SELF_ID)]);
    messageStore.storeMeta(-987654321, {
      isGroup: false,
      targetId: FRIEND_ID,
      sequence: 700,
      eventName: PRIVATE_MESSAGE_EVENT,
      clientSequence: 0,
      random: 0,
      timestamp: 0,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        resolveUserUid: vi.fn(async () => 'u_friend'),
        apis: { message: { getC2cHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    const messages = await getFriendHistory(ref, FRIEND_ID, -987654321, 20, false);
    const cached = await getFriendMsgHistory(messageStore, FRIEND_ID, 700, 2, false);

    expect(messages.map((message) => message.message_seq)).toEqual([700, 701]);
    expect(messages[0]).toMatchObject({ user_id: SELF_ID, target_id: FRIEND_ID });
    expect(cached.map((message) => message.message_seq)).toEqual([700, 701]);
  });

  it('keeps latest-page group requests backward-compatible without an anchor', async () => {
    const fetchHistory = vi.fn(async (...args: unknown[]) =>
      args[4] === true ? [groupMessage(899), groupMessage(900)] : [groupMessage(900), groupMessage(901)]);
    messageStore.storeEvent(1, true, GROUP_ID, 900, GROUP_MESSAGE_EVENT, {
      post_type: 'message',
      message_type: 'group',
      group_id: GROUP_ID,
      message_id: 1,
      message_seq: 900,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        apis: { message: { getGroupHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    const messages = await getGroupHistory(ref, GROUP_ID, 0, 20, false);

    expect(messages.map((message) => message.message_seq)).toEqual([899, 900]);
  });

  it('rejects a private anchor from a different friend conversation', async () => {
    const fetchHistory = vi.fn(async () => [friendMessage(800, FRIEND_ID)]);
    messageStore.storeMeta(-111111111, {
      isGroup: false,
      targetId: 987654321,
      sequence: 800,
      eventName: PRIVATE_MESSAGE_EVENT,
      clientSequence: 0,
      random: 0,
      timestamp: 0,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        resolveUserUid: vi.fn(async () => 'u_friend'),
        apis: { message: { getC2cHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    await expect(getFriendHistory(ref, FRIEND_ID, -111111111, 20, false)).resolves.toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type {
  OidbBase,
  OidbFriend,
  OidbFriendCategory,
  OidbSvcTrpcTcp0xFD4_1Response,
} from '@snowluma/proto-defs/oidb';
import type { OidbFriendListRequest } from '@snowluma/proto-defs/oidb-actions/base';

import { ContactsApi } from '../../src/bridge/apis/contacts';

function friend(
  uin: number,
  categoryId: number,
  uid: string,
  nickname: string,
  remark = '',
): OidbFriend {
  return {
    uin,
    uid,
    customGroup: categoryId,
    additional: [{
      type: 1,
      layer1: {
        properties: [
          { code: 20002, value: nickname },
          { code: 103, value: remark },
        ],
      },
    }],
  };
}

function category(
  categoryId: number,
  categoryName: string,
  memberCount: number,
  sortId: number,
): OidbFriendCategory {
  return { categoryId, categoryName, memberCount, sortId };
}

function packet(body: OidbSvcTrpcTcp0xFD4_1Response): SendPacketResult {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(
      protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>({ body }),
    ),
  };
}

function apiForPages(pages: OidbSvcTrpcTcp0xFD4_1Response[]) {
  let index = 0;
  const sendRawPacket = vi.fn(async (
    _cmd: string,
    _body: Uint8Array,
  ): Promise<SendPacketResult> => {
    const page = pages[index++];
    if (!page) throw new Error(`unexpected friend-list page ${index}`);
    return packet(page);
  });
  const rememberFriends = vi.fn();
  const api = new ContactsApi({
    sendRawPacket,
    identity: { rememberFriends },
  } as any);
  return { api, sendRawPacket, rememberFriends };
}

describe('apis/contacts / categorized friend roster', () => {
  it('keeps fetchFriendList flat while traversing cookie pages', async () => {
    const cookie = Uint8Array.from([0x01]);
    const { api, sendRawPacket } = apiForPages([
      { cookie, friends: [friend(10001, 0, 'u1', 'Default')] },
      { friends: [friend(10002, 7, 'u2', 'Alice', 'A')] },
    ]);

    await expect(api.fetchFriendList()).resolves.toEqual([
      { uin: 10001, uid: 'u1', nickname: 'Default', remark: '' },
      { uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A' },
    ]);
    expect(sendRawPacket).toHaveBeenCalledTimes(2);
  });

  it('groups a complete multi-page roster and preserves empty categories', async () => {
    const cookie = Uint8Array.from([0xAA, 0xBB]);
    const { api, sendRawPacket, rememberFriends } = apiForPages([
      {
        cookie,
        friends: [friend(10001, 0, 'u1', 'Default')],
        categories: [
          category(0, '我的好友', 1, 0),
          category(7, 'Work', 1, 1),
          category(9, 'Empty', 0, 2),
        ],
      },
      {
        friends: [friend(10002, 7, 'u2', 'Alice', 'A')],
        categories: [category(7, 'Work', 1, 1)],
      },
    ]);

    await expect(api.fetchFriendCategories()).resolves.toEqual([
      {
        categoryId: 0,
        categoryName: '我的好友',
        memberCount: 1,
        sortId: 0,
        friends: [{ uin: 10001, uid: 'u1', nickname: 'Default', remark: '' }],
      },
      {
        categoryId: 7,
        categoryName: 'Work',
        memberCount: 1,
        sortId: 1,
        friends: [{ uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A' }],
      },
      {
        categoryId: 9,
        categoryName: 'Empty',
        memberCount: 0,
        sortId: 2,
        friends: [],
      },
    ]);

    expect(sendRawPacket).toHaveBeenCalledTimes(2);
    const secondRequest = protobuf_decode<OidbBase<OidbFriendListRequest>>(
      sendRawPacket.mock.calls[1]![1],
    );
    expect(secondRequest.body?.cookie).toEqual(cookie);
    expect(rememberFriends).toHaveBeenCalledOnce();
    expect(rememberFriends).toHaveBeenCalledWith([
      { uin: 10001, uid: 'u1', nickname: 'Default', remark: '' },
      { uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A' },
    ]);
  });

  it('rejects a friend whose category metadata never arrives', async () => {
    const { api } = apiForPages([{
      friends: [friend(10001, 99, 'u1', 'Orphan')],
      categories: [],
    }]);

    await expect(api.fetchFriendCategories())
      .rejects.toThrow('missing category 99');
  });

  it('rejects a repeated non-empty pagination cookie', async () => {
    const cookie = Uint8Array.from([0xAA]);
    const { api } = apiForPages([{ cookie }, { cookie }]);

    await expect(api.fetchFriendCategories())
      .rejects.toThrow('repeated friend-list cookie aa');
  });
});

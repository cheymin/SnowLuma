import { describe, expect, it } from 'vitest';
import type { GetMediaListResponse } from '@snowluma/proto-defs/oidb-actions/group-album';
import { protobuf_encode } from '@snowluma/proton';
import { GroupAlbumApi } from '../../src/bridge/apis/group-album';
import { mockBridge } from './_helpers';

describe('apis/group-album', () => {
  it('accepts a successful media-list response with an omitted zero retCode', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(protobuf_encode<GetMediaListResponse>({
        data: {
          mediaList: [{
            type: 1,
            uploader: '10001',
            batchId: 123n,
            uploadTime: 456n,
          }],
          nextAttachInfo: 'next-page',
        },
      })),
    });

    const result = await new GroupAlbumApi(bridge as never).getMediaList(12345, 'album-id');

    expect(result).toEqual({
      mediaList: [{
        type: 1,
        image: null,
        uploader: '10001',
        batchId: '123',
        uploadTime: '456',
      }],
      nextAttachInfo: 'next-page',
    });
  });
});

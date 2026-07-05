import { describe, expect, it } from 'vitest';
import { ELEMENT_CODECS } from '../src/event-converter/element-codecs';
import type { MessageElement } from '@snowluma/protocol/events';

// The receive-side flash_file codec (#199/#200). Sending is a separate action
// (send_flash_msg), so there is no fromSegment.
describe('flash_file element → OneBot segment (#199/#200)', () => {
  it('maps filesetId/fileName/sceneType → file_set_id/title/scene_type', async () => {
    const el: MessageElement = { type: 'flash_file', filesetId: 'fs-1', fileName: 'a.pdf', sceneType: 2 };
    const seg = await ELEMENT_CODECS.flash_file!.toSegment!(el, {} as never);
    expect(seg).toEqual({ type: 'flash_file', data: { title: 'a.pdf', file_set_id: 'fs-1', scene_type: 2 } });
  });

  it('defaults missing fields to empty / 0', async () => {
    const seg = await ELEMENT_CODECS.flash_file!.toSegment!({ type: 'flash_file' } as MessageElement, {} as never);
    expect(seg).toEqual({ type: 'flash_file', data: { title: '', file_set_id: '', scene_type: 0 } });
  });

  it('is receive-only (no fromSegment)', () => {
    expect(ELEMENT_CODECS.flash_file!.fromSegment).toBeUndefined();
  });
});

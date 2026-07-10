import { protobuf_decode } from '@snowluma/proton';
import { inflateSync } from 'zlib';
import type { IdentityService } from '../identity-service';
import type { OperatorInfo } from '@snowluma/proto-defs/notify';

export const MAX_RICH_CARD_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_RICH_CARD_MESSAGE_OUTPUT_BYTES = 8 * 1024 * 1024;

export type DecompressDataResult =
  | { ok: true; text: string; outputBytes: number }
  | { ok: false; reason: string };

export function makeImageUrl(origUrl: string): string {
  if (!origUrl) return '';
  if (origUrl.includes('rkey')) return 'https://multimedia.nt.qq.com.cn' + origUrl;
  return 'http://gchat.qpic.cn' + origUrl;
}

export function decompressData(
  data: Uint8Array,
  maxOutputBytes = MAX_RICH_CARD_OUTPUT_BYTES,
): DecompressDataResult {
  if (!data || data.length === 0) return { ok: false, reason: 'empty_payload' };
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`invalid decompression output limit: ${maxOutputBytes}`);
  }
  if ((data[0] === 0x00 || data[0] === 0x01) && data.length === 1) {
    return { ok: false, reason: 'marker_without_payload' };
  }
  if (data[0] === 0x01) {
    try {
      const inflated = inflateSync(Buffer.from(data.subarray(1)), {
        maxOutputLength: maxOutputBytes,
      });
      return inflated.length > 0
        ? { ok: true, text: inflated.toString('utf8'), outputBytes: inflated.length }
        : { ok: false, reason: 'empty_output' };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : '';
      return {
        ok: false,
        reason: code === 'ERR_BUFFER_TOO_LARGE'
          ? 'output_limit_exceeded'
          : code
            ? `inflate_failed:${code}`
            : 'inflate_failed',
      };
    }
  }
  if (data[0] === 0x00) {
    if (data.length - 1 > maxOutputBytes) return { ok: false, reason: 'output_limit_exceeded' };
    return {
      ok: true,
      text: Buffer.from(data.subarray(1)).toString('utf8'),
      outputBytes: data.length - 1,
    };
  }
  if (data.length > maxOutputBytes) return { ok: false, reason: 'output_limit_exceeded' };
  return { ok: true, text: Buffer.from(data).toString('utf8'), outputBytes: data.length };
}

export function isNumericUin(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}

export function parseU64OrZero(value: string): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

// Cascades group-scoped lookup → in-memory map → SQLite.
// No network fallback on the parse hot path: missing identities fall back to
// `fallback` and downstream events drive a roster refresh asynchronously.
export function resolveUidToUin(identity: IdentityService, groupId: number, uid: string, fallback = 0): number {
  if (!uid) return fallback;
  if (isNumericUin(uid)) {
    const n = parseInt(uid, 10);
    if (!isNaN(n)) return n;
  }
  const uin = identity.findUinByUid(uid, groupId || undefined);
  if (uin !== null) return uin;
  return fallback;
}

export function decodeOperatorUid(bytes: Uint8Array): string {
  if (!bytes || bytes.length === 0) return '';
  const info = protobuf_decode<OperatorInfo>(bytes);
  if (info?.operatorField?.uid) return info.operatorField.uid;
  return Buffer.from(bytes).toString('utf8');
}

export function buildTemplateMap(params: Array<{ name?: string; value?: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of params) {
    if (p.name !== undefined) map.set(p.name, p.value ?? '');
  }
  return map;
}

export function findTemplateValue(map: Map<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = map.get(k);
    if (v) return v;
  }
  return '';
}

export function unwrapGroupNotifyPayload(content: Uint8Array): Uint8Array | null {
  if (content.length <= 7) return null;
  const lenBe = (content[5] << 8) | content[6];
  const lenLe = content[5] | (content[6] << 8);
  if (7 + lenBe <= content.length) return content.subarray(7, 7 + lenBe);
  if (7 + lenLe <= content.length) return content.subarray(7, 7 + lenLe);
  return content.subarray(7);
}

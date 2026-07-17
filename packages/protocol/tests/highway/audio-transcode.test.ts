import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsPromises, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { AUDIO_OUT_FORMATS, convertAudioBytes, isAudioOutFormat } from '@snowluma/protocol/highway/ffmpeg-addon';

// convertAudioBytes is the pure (#165) transcode seam: write input → the
// addon's dedicated audio transcoder → read output as base64 → always clean up
// temp files. Unit tests inject a fake; audio-transcode-native.test.ts covers
// each bundled release-platform addon in the build matrices.

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sl-audio-test-'));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

/** Fake addon: writes deterministic bytes to the output path and reports ok. */
const fakeOk = {
  decodeAudioToFmt: async (_in: string, out: string, format: string) => {
    writeFileSync(out, Buffer.from('WAVDATA')); // stand-in converted payload
    return { result: true, sampleRate: 24_000, channels: 1, format };
  },
};

describe('isAudioOutFormat / AUDIO_OUT_FORMATS', () => {
  it('accepts exactly NapCat\'s allowlist', () => {
    expect([...AUDIO_OUT_FORMATS]).toEqual(['mp3', 'amr', 'wma', 'm4a', 'spx', 'ogg', 'wav', 'flac']);
    expect(isAudioOutFormat('wav')).toBe(true);
    expect(isAudioOutFormat('WAV')).toBe(false); // case-sensitive
    expect(isAudioOutFormat('opus')).toBe(false);
    expect(isAudioOutFormat('')).toBe(false);
  });
});

describe('convertAudioBytes', () => {
  it('transcodes and returns base64 + size of the addon output', async () => {
    const r = await convertAudioBytes(new Uint8Array([1, 2, 3]), 'wav', { addon: fakeOk, tmpDir });
    expect(Buffer.from(r.base64, 'base64').toString()).toBe('WAVDATA');
    expect(r.size).toBe('WAVDATA'.length);
  });

  it('rejects an unsupported format before touching the addon', async () => {
    let called = false;
    const spy = {
      decodeAudioToFmt: async (_in: string, _out: string, format: string) => {
        called = true;
        return { result: true, sampleRate: 24_000, channels: 1, format };
      },
    };
    await expect(convertAudioBytes(new Uint8Array([1]), 'opus', { addon: spy, tmpDir })).rejects.toThrow(/unsupported out_format/);
    expect(called).toBe(false);
  });

  it('propagates a native conversion rejection and cleans up', async () => {
    const fakeFail = {
      decodeAudioToFmt: async () => { throw new Error('native conversion failed'); },
    };
    await expect(convertAudioBytes(new Uint8Array([9]), 'mp3', { addon: fakeFail, tmpDir })).rejects.toThrow(/native conversion failed/);
    // no leftover temp files for this run
    const leftover = readdirSync(tmpDir).filter((n) => n.endsWith('.mp3') || n.endsWith('.in'));
    expect(leftover).toEqual([]);
  });

  it('rejects (and cleans up) when the output exceeds the cap', async () => {
    await expect(
      convertAudioBytes(new Uint8Array([1]), 'wav', { addon: fakeOk, tmpDir, maxOutputBytes: 3 }),
    ).rejects.toThrow(/too large/);
    const leftover = readdirSync(tmpDir).filter((n) => n.endsWith('.wav') || n.endsWith('.in'));
    expect(leftover).toEqual([]);
  });

  it('cleans up the temp input + output on success too', async () => {
    await convertAudioBytes(new Uint8Array([4, 5]), 'flac', { addon: fakeOk, tmpDir });
    const leftover = readdirSync(tmpDir).filter((n) => n.endsWith('.flac') || n.endsWith('.in'));
    expect(leftover).toEqual([]);
  });

  it('surfaces temporary-file cleanup failures', async () => {
    const rmSpy = vi.spyOn(fsPromises, 'rm').mockRejectedValue(new Error('cleanup denied'));
    try {
      await expect(
        convertAudioBytes(new Uint8Array([6]), 'wav', { addon: fakeOk, tmpDir }),
      ).rejects.toThrow(/temporary audio file cleanup failed/);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('reports both the conversion and cleanup causes when both fail', async () => {
    const nativeFailure = {
      decodeAudioToFmt: async () => { throw new Error('native conversion failed'); },
    };
    const rmSpy = vi.spyOn(fsPromises, 'rm').mockRejectedValue(new Error('cleanup denied'));
    try {
      await expect(
        convertAudioBytes(new Uint8Array([7]), 'mp3', { addon: nativeFailure, tmpDir }),
      ).rejects.toThrow(/native conversion failed.*cleanup denied/);
    } finally {
      rmSpy.mockRestore();
    }
  });
});

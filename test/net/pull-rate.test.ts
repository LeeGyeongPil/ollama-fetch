// AC-10(test:net): 실제 소켓에서 합계 속도 상한 — 블롭 3개 합계 3 MiB 를 --limit-rate 1M --connections 3 → 2.7 초 이상
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../../src/main.js';
import { startMockRegistry } from '../../src/mock/registry-server.js';
import { captureCtx, cleanupTempDirs, pseudoRandomBytes, sha256Hex, sha256OfFile, tempDir } from '../support/helpers.js';

after(cleanupTempDirs);

const MiB = 1024 * 1024;

describe('AC-10 net: global cap on real sockets', () => {
  it('3 blobs x 1 MiB at --limit-rate 1M with 3 connections take at least 2.7 s', async () => {
    const blobs = [1, 2, 3].map((seed) => pseudoRandomBytes(MiB, seed));
    const registry = await startMockRegistry({
      models: [
        {
          namespace: 'library',
          repo: 'three',
          tag: 'latest',
          layers: blobs.map((data) => ({ mediaType: 'application/vnd.ollama.image.model', data })),
        },
      ],
    });
    try {
      const modelsDir = await tempDir();
      const cap = captureCtx();
      // 느린 받는 쪽(상한)에 맞춰 서버가 쓰기를 기다릴 때 리스너가 쌓이지 않는지도 본다(MaxListenersExceededWarning)
      const warnings: string[] = [];
      const onWarning = (w: Error) => warnings.push(w.name);
      process.on('warning', onWarning);
      const started = performance.now();
      const code = await main(
        ['pull', 'three', '--registry', registry.url, '--models-dir', modelsDir, '--limit-rate', '1M', '--connections', '3'],
        cap.ctx,
      );
      const seconds = (performance.now() - started) / 1000;
      process.off('warning', onWarning);
      assert.equal(code, 0, cap.err());
      assert.deepEqual(warnings, []);
      // 연결이 3개여도 합계 1 MiB/s: 이론값 (3 MiB - 버스트 0.1 MiB) / 1 MiB/s ≈ 2.9 s. 하한만 단언한다.
      assert.ok(seconds >= 2.7, `elapsed ${seconds.toFixed(2)} s`);
      for (const data of blobs) {
        const hex = sha256Hex(data);
        assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${hex}`)), hex);
      }
      // config + 블롭 3개가 각각 한 번씩만 받아졌다(끊김·재시도 없음)
      assert.equal(registry.requests.filter((r) => r.kind === 'cdn').length, 4);
    } finally {
      await registry.close();
    }
  });
});

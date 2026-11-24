// AC-4: 모의 레지스트리(307 CDN 리다이렉트)에서 pull → 블롭·매니페스트 배치, 쓰기 순서, 재실행 시 블롭 요청 0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../src/main.js';
import { startMockRegistry, tinyModelLayers } from '../src/mock/registry-server.js';
import { encodeModel, synthModel } from '../src/mock/synth-gguf.js';
import { type PullEvent, pullModel } from '../src/pull.js';
import { parseRef } from '../src/ref.js';
import { captureCtx, cleanupTempDirs, listTree, sha256OfFile, tempDir } from './helpers.js';

after(cleanupTempDirs);

describe('AC-4 pull from mock registry', () => {
  it('stores verified blobs, then the raw manifest last; rerun makes 0 blob requests', async () => {
    const registry = await startMockRegistry({
      models: [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(encodeModel(synthModel({ scale: 4 }))) }],
    });
    try {
      const modelsDir = await tempDir();
      const manifestFile = join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', 'tiny', 'latest');

      // 1) 첫 실행 — 이벤트로 쓰기 순서를 기록한다
      const order: string[] = [];
      const onEvent = (e: PullEvent) => {
        if (e.type === 'blob-done') {
          // 블롭이 하나 확정될 때 매니페스트는 아직 없어야 한다
          assert.equal(existsSync(manifestFile), false, 'manifest must not exist before all blobs');
          order.push(`blob:${e.digest}`);
        }
        if (e.type === 'manifest-written') order.push('manifest');
      };
      const result = await pullModel({
        ref: parseRef('library/tiny:latest'),
        modelsDir,
        registry: registry.url,
        rateLimit: 0,
        connections: 2,
        retries: 2,
        onEvent,
      });

      // 매니페스트의 모든 레이어(+config)가 blobs/sha256-<hex> 로 있고 내용 해시 = 이름
      const raw = registry.manifests.get('library/tiny:latest') as Buffer;
      const manifest = JSON.parse(raw.toString()) as { config: { digest: string }; layers: { digest: string }[] };
      const digests = [manifest.config.digest, ...manifest.layers.map((l) => l.digest)];
      assert.equal(digests.length, 4);
      for (const d of digests) {
        const hex = d.slice('sha256:'.length);
        assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${hex}`)), hex);
      }
      // 매니페스트는 원문 그대로, 블롭 4개 뒤에 마지막으로
      assert.ok(readFileSync(manifestFile).equals(raw));
      assert.equal(order.length, 5);
      assert.equal(order[4], 'manifest');
      assert.equal(result.manifestPath, manifestFile);
      // partial·임시 파일이 남지 않는다
      const tree = await listTree(modelsDir);
      assert.deepEqual(tree.filter((p) => p.endsWith('.ollama-fetch.partial') || p.endsWith('.tmp')), []);
      // 실제 레지스트리처럼 307 → CDN 경로를 탔다
      assert.ok(registry.requests.some((r) => r.kind === 'blob' && r.status === 307));
      assert.ok(registry.requests.some((r) => r.kind === 'cdn' && r.status === 200));

      // 2) CLI 로 같은 명령을 다시 — 블롭 GET 0회
      const before = registry.blobRequests();
      const cap = captureCtx();
      const code = await main(['pull', 'library/tiny:latest', '--registry', registry.url, '--models-dir', modelsDir], cap.ctx);
      assert.equal(code, 0, cap.err());
      assert.equal(registry.blobRequests() - before, 0);
      assert.match(cap.out(), /already complete/);
      assert.ok(readFileSync(manifestFile).equals(raw));
    } finally {
      await registry.close();
    }
  });

  it('manifest 404 exits 4, unreachable registry exits 4, bad name exits 2', async () => {
    const registry = await startMockRegistry({ models: [] });
    try {
      const modelsDir = await tempDir();
      let cap = captureCtx();
      assert.equal(await main(['pull', 'nope', '--registry', registry.url, '--models-dir', modelsDir], cap.ctx), 4);
      assert.match(cap.err(), /not found/);
      assert.deepEqual(await listTree(modelsDir), []);

      cap = captureCtx();
      assert.equal(await main(['pull', 'x', '--registry', 'http://127.0.0.1:9', '--models-dir', modelsDir], cap.ctx), 4);

      cap = captureCtx();
      assert.equal(await main(['pull', '../etc/passwd', '--models-dir', modelsDir], cap.ctx), 2);
    } finally {
      await registry.close();
    }
  });
});

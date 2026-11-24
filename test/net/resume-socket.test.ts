// AC-10(test:net): 127.0.0.1 실제 HTTP 소켓에서 끊김 → Range 206 이어받기, Range 무시 200 → 처음부터.
// 단위 테스트(test/unit/resume.test.ts)의 메모리 전송과 같은 모의 처리기를 실제 소켓으로 다시 확인한다(위험 R-2).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../../src/main.js';
import { sha256Digest, startMockRegistry, tinyModelLayers } from '../../src/mock/registry-server.js';
import { encodeModel, synthModel } from '../../src/mock/synth-gguf.js';
import { type PullEvent } from '../../src/pull.js';
import { captureCtx, cleanupTempDirs, listTree, sha256OfFile, tempDir } from '../support/helpers.js';

after(cleanupTempDirs);

const model = encodeModel(synthModel({ scale: 8 })); // 약 2 MiB
const modelDigest = sha256Digest(model);
const modelHex = modelDigest.slice('sha256:'.length);
const models = [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(model) }];
const cdnPath = `/cdn/${modelDigest}`;

describe('AC-10 net: resume over a real socket', () => {
  it('drop at 40% → retry sends Range: bytes=<received>- and completes with 206', async () => {
    const registry = await startMockRegistry({ models, faults: { drop: { digest: modelDigest, fraction: 0.4, times: 1 } } });
    try {
      const modelsDir = await tempDir();
      const events: PullEvent[] = [];
      const cap = captureCtx(undefined, { onPullEvent: (e) => events.push(e) });
      const code = await main(['pull', 'tiny', '--registry', registry.url, '--models-dir', modelsDir], cap.ctx);
      assert.equal(code, 0, cap.err());

      const drop = events.find((e) => e.type === 'drop' && e.digest === modelDigest);
      const resume = events.find((e) => e.type === 'resume');
      assert.ok(drop && drop.type === 'drop', 'a drop happened');
      assert.ok(resume && resume.type === 'resume', 'a resume happened');
      // 실소켓은 운영체제가 아직 읽지 않은 덩어리를 버릴 수 있어 위치가 40% 보다 조금 앞일 수 있다
      assert.ok(resume.at > 0 && resume.at <= Math.floor(model.length * 0.4), `resumed at ${resume.at}`);

      const hits = registry.requests.filter((r) => r.path === cdnPath);
      assert.equal(hits.length, 2);
      assert.equal(hits[0].range, undefined);
      assert.equal(hits[1].range, `bytes=${resume.at}-`);
      assert.equal(hits[1].status, 206);
      assert.match(cap.out(), /UND_ERR_SOCKET/);
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
      assert.deepEqual((await listTree(modelsDir)).filter((p) => p.includes('partial')), []);
    } finally {
      await registry.close();
    }
  });

  it('server ignores Range (200) → partial discarded, restarted from 0, digest matches', async () => {
    const registry = await startMockRegistry({
      models,
      faults: { drop: { digest: modelDigest, fraction: 0.4, times: 1 }, ignoreRange: true },
    });
    try {
      const modelsDir = await tempDir();
      const events: PullEvent[] = [];
      const cap = captureCtx(undefined, { onPullEvent: (e) => events.push(e) });
      assert.equal(await main(['pull', 'tiny', '--registry', registry.url, '--models-dir', modelsDir], cap.ctx), 0, cap.err());
      assert.ok(events.some((e) => e.type === 'range-ignored'));
      const hits = registry.requests.filter((r) => r.path === cdnPath);
      assert.equal(hits[1].status, 200);
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
    } finally {
      await registry.close();
    }
  });
});

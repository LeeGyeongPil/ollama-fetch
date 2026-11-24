// AC-10(test:net): 실제 소켓에서 데이터가 멈추면 정체 시간(1초) 뒤 끊고 이어받는다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { sha256Digest, startMockRegistry, tinyModelLayers } from '../../src/mock/registry-server.js';
import { encodeModel, synthModel } from '../../src/mock/synth-gguf.js';
import { type PullEvent, pullModel } from '../../src/pull.js';
import { parseRef } from '../../src/ref.js';
import { cleanupTempDirs, sha256OfFile, tempDir } from '../support/helpers.js';

after(cleanupTempDirs);

const model = encodeModel(synthModel({ scale: 8 }));
const modelDigest = sha256Digest(model);
const modelHex = modelDigest.slice('sha256:'.length);

describe('AC-10 net: stall detection', () => {
  it('a stalled connection is cut after 1 s without data and resumed', async () => {
    const registry = await startMockRegistry({
      models: [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(model) }],
      faults: { hang: { digest: modelDigest, fraction: 0.3, times: 1 } },
    });
    try {
      const modelsDir = await tempDir();
      const events: PullEvent[] = [];
      await pullModel({
        ref: parseRef('tiny'),
        modelsDir,
        registry: registry.url,
        rateLimit: 0,
        connections: 1,
        retries: 3,
        // 너무 짧으면 붐비는 기계에서 정상 블롭의 덩어리 사이 간격도 정체로 오인할 수 있어 1초로 둔다
        stallTimeoutMs: 1000,
        sleep: async () => undefined,
        onEvent: (e) => events.push(e),
      });
      const drop = events.find((e) => e.type === 'drop' && e.digest === modelDigest);
      assert.ok(drop && drop.type === 'drop');
      assert.match(drop.reason, /no data for 1000 ms/);
      assert.ok(events.some((e) => e.type === 'resume'));
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
    } finally {
      await registry.close();
    }
  });
});

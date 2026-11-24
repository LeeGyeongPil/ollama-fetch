// AC-5: 이어받기와 무결성 — ① 40% 끊김 → Range 206 이어받기 ② Range 무시 200 → 처음부터 ③ 항상 손상 → 종료 코드 3
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../src/main.js';
import { sha256Digest, startMockRegistry, tinyModelLayers } from '../src/mock/registry-server.js';
import { encodeModel, synthModel } from '../src/mock/synth-gguf.js';
import { type PullEvent, pullModel } from '../src/pull.js';
import { parseRef } from '../src/ref.js';
import { captureCtx, cleanupTempDirs, listTree, sha256OfFile, tempDir } from './helpers.js';

after(cleanupTempDirs);

const model = encodeModel(synthModel({ scale: 8 })); // 약 2 MiB
const modelDigest = sha256Digest(model);
const modelHex = modelDigest.slice('sha256:'.length);
const models = [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(model) }];
const cdnPath = `/cdn/${modelDigest}`;

async function pullCollecting(registryUrl: string, modelsDir: string, retries = 3) {
  const events: PullEvent[] = [];
  await pullModel({
    ref: parseRef('tiny'),
    modelsDir,
    registry: registryUrl,
    rateLimit: 0,
    connections: 2,
    retries,
    sleep: async () => undefined,
    onEvent: (e) => events.push(e),
  });
  return events;
}

describe('AC-5 resume and integrity', () => {
  it('① drop at 40% → retry sends Range: bytes=<received>- and completes with 206', async () => {
    const registry = await startMockRegistry({ models, faults: { drop: { digest: modelDigest, fraction: 0.4, times: 1 } } });
    try {
      const modelsDir = await tempDir();
      const events = await pullCollecting(registry.url, modelsDir);

      const drop = events.find((e) => e.type === 'drop');
      const resume = events.find((e) => e.type === 'resume');
      assert.ok(drop && drop.type === 'drop', 'a drop happened');
      assert.ok(resume && resume.type === 'resume', 'a resume happened');
      assert.ok(resume.at > 0 && resume.at <= Math.floor(model.length * 0.4), `resumed at ${resume.at}`);

      // 서버 기록: 같은 블롭에 대한 두 번째 요청이 받은 크기부터의 Range 이고 206 으로 응답
      const hits = registry.requests.filter((r) => r.path === cdnPath);
      assert.equal(hits.length, 2);
      assert.equal(hits[0].range, undefined);
      assert.equal(hits[1].range, `bytes=${resume.at}-`);
      assert.equal(hits[1].status, 206);
      // 307 리다이렉트도 재시도마다 원래 URL 부터 다시 받았다
      assert.equal(registry.requests.filter((r) => r.kind === 'blob' && r.path.endsWith(modelDigest)).length, 2);

      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
      assert.deepEqual((await listTree(modelsDir)).filter((p) => p.includes('partial')), []);
    } finally {
      await registry.close();
    }
  });

  it('② server ignores Range (200) → partial discarded, restarted from 0, digest matches', async () => {
    const registry = await startMockRegistry({
      models,
      faults: { drop: { digest: modelDigest, fraction: 0.4, times: 1 }, ignoreRange: true },
    });
    try {
      const modelsDir = await tempDir();
      const events = await pullCollecting(registry.url, modelsDir);

      const ignored = events.find((e) => e.type === 'range-ignored');
      assert.ok(ignored && ignored.type === 'range-ignored');
      assert.equal(ignored.status, 200);
      assert.equal(events.some((e) => e.type === 'resume'), false);
      const hits = registry.requests.filter((r) => r.path === cdnPath);
      assert.equal(hits.length, 2);
      assert.match(hits[1].range ?? '', /^bytes=\d+-$/);
      assert.equal(hits[1].status, 200);
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
    } finally {
      await registry.close();
    }
  });

  it('③ always-corrupt bytes → exit 3 after retries, no final blob, no manifest', async () => {
    const registry = await startMockRegistry({ models, faults: { corrupt: modelDigest } });
    try {
      const modelsDir = await tempDir();
      const cap = captureCtx();
      const code = await main(
        ['pull', 'tiny', '--registry', registry.url, '--models-dir', modelsDir, '--retries', '2'],
        cap.ctx,
      );
      assert.equal(code, 3, cap.err());
      assert.match(cap.err(), /digest mismatch/);
      assert.match(cap.out(), /sha256 mismatch/);
      // 1번 + 재시도 2번 = 3번 받았다
      assert.equal(registry.requests.filter((r) => r.path === cdnPath).length, 3);
      assert.equal(existsSync(join(modelsDir, 'blobs', `sha256-${modelHex}`)), false);
      assert.equal(existsSync(join(modelsDir, 'manifests')), false);
      assert.deepEqual((await listTree(modelsDir)).filter((p) => p.includes('partial')), []);
    } finally {
      await registry.close();
    }
  });

  it('Ctrl+C (abort) exits 130 and keeps the partial; the next run resumes from it', async () => {
    const registry = await startMockRegistry({ models });
    try {
      const modelsDir = await tempDir();
      const controller = new AbortController();
      const cap = captureCtx(undefined, { signal: controller.signal });
      const timer = setTimeout(() => controller.abort(), 600); // 1 MiB/s 로 받는 중간에 멈춘다
      const code = await main(
        ['pull', 'tiny', '--registry', registry.url, '--models-dir', modelsDir, '--limit-rate', '1M'],
        cap.ctx,
      );
      clearTimeout(timer);
      assert.equal(code, 130, cap.err());
      assert.match(cap.err(), /Interrupted/);
      const partial = join(modelsDir, 'blobs', `sha256-${modelHex}.ollama-fetch.partial`);
      assert.equal(existsSync(partial), true, 'partial kept');
      assert.equal(existsSync(join(modelsDir, 'manifests')), false);

      const events = await pullCollecting(registry.url, modelsDir);
      const resume = events.find((e) => e.type === 'resume');
      assert.ok(resume && resume.type === 'resume' && resume.at > 0, 'resumed from the kept partial');
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
    } finally {
      await registry.close();
    }
  });

  it('a stalled connection is cut after the stall timeout and resumed', async () => {
    const registry = await startMockRegistry({ models, faults: { hang: { digest: modelDigest, fraction: 0.3, times: 1 } } });
    try {
      const modelsDir = await tempDir();
      const events: PullEvent[] = [];
      await pullModel({
        ref: parseRef('tiny'),
        modelsDir,
        registry: registry.url,
        rateLimit: 0,
        connections: 1,
        retries: 2,
        stallTimeoutMs: 300,
        sleep: async () => undefined,
        onEvent: (e) => events.push(e),
      });
      const drop = events.find((e) => e.type === 'drop');
      assert.ok(drop && drop.type === 'drop');
      assert.match(drop.reason, /no data for 300 ms/);
      assert.ok(events.some((e) => e.type === 'resume'));
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
    } finally {
      await registry.close();
    }
  });

  it('stale partial larger than the blob is discarded and the blob is fetched fresh', async () => {
    const registry = await startMockRegistry({ models });
    try {
      const modelsDir = await tempDir();
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(modelsDir, 'blobs'), { recursive: true });
      await writeFile(join(modelsDir, 'blobs', `sha256-${modelHex}.ollama-fetch.partial`), Buffer.alloc(model.length + 10));
      await pullCollecting(registry.url, modelsDir);
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
    } finally {
      await registry.close();
    }
  });
});

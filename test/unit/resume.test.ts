// AC-5: 메모리 전송으로 이어받기와 무결성을 확인한다(소켓·타이머·폴링 없음 — 끊는 위치가 바이트 단위로 정확하다).
//  ① 정확히 40% 에서 끊김 → 두 번째 요청 Range: bytes=<floor(size×0.4)>- 와 206, 해시 일치
//  ② Range 를 무시하는 200 → partial 을 버리고 처음부터, 해시 일치
//  ③ 항상 손상 → 재시도 후 종료 코드 3, 최종 블롭·매니페스트·partial 없음
//  ④ 진행 이벤트가 64 KiB 이상일 때 AbortSignal 로 중단 → 종료 코드 130, partial 유지, 다음 실행이 그 위치부터
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../../src/main.js';
import { createMockRegistry, type MockFaults, sha256Digest, tinyModelLayers } from '../../src/mock/registry-server.js';
import { encodeModel, synthModel } from '../../src/mock/synth-gguf.js';
import { type PullEvent } from '../../src/pull.js';
import { captureCtx, cleanupTempDirs, listTree, sha256OfFile, tempDir } from '../support/helpers.js';

after(cleanupTempDirs);

const model = encodeModel(synthModel({ scale: 8 })); // 약 2 MiB
const modelDigest = sha256Digest(model);
const modelHex = modelDigest.slice('sha256:'.length);
const models = [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(model) }];
const cdnPath = `/cdn/${modelDigest}`;

/** 메모리 레지스트리 + CLI pull 한 번. 이벤트와 출력을 모아 돌려준다 */
async function pullOnce(
  registry: ReturnType<typeof createMockRegistry>,
  modelsDir: string,
  extraArgs: string[] = [],
  ctxExtra: Parameters<typeof captureCtx>[1] = {},
) {
  const events: PullEvent[] = [];
  const cap = captureCtx(undefined, { fetchImpl: registry.fetch, onPullEvent: (e) => events.push(e), ...ctxExtra });
  const code = await main(['pull', 'tiny', '--registry', registry.url, '--models-dir', modelsDir, ...extraArgs], cap.ctx);
  return { code, events, out: cap.out(), err: cap.err() };
}

function memoryRegistry(faults: MockFaults = {}) {
  return createMockRegistry({ models, faults });
}

describe('AC-5 resume and integrity (memory transport)', () => {
  it('① drop at exactly 40% → retry sends Range: bytes=<floor(size*0.4)>- and completes with 206', async () => {
    const registry = memoryRegistry({ drop: { digest: modelDigest, fraction: 0.4, times: 1 } });
    const modelsDir = await tempDir();
    const { code, events, out, err } = await pullOnce(registry, modelsDir);
    assert.equal(code, 0, err);

    const at = Math.floor(model.length * 0.4);
    const drop = events.find((e) => e.type === 'drop' && e.digest === modelDigest);
    const resume = events.find((e) => e.type === 'resume');
    assert.ok(drop && drop.type === 'drop', 'a drop happened');
    assert.equal(drop.at, at, 'the partial holds exactly the bytes the server sent');
    assert.equal(drop.reason, 'UND_ERR_SOCKET');
    assert.ok(resume && resume.type === 'resume', 'a resume happened');
    assert.equal(resume.at, at);

    // 서버 기록: 같은 블롭에 대한 두 번째 요청이 정확한 Range 이고 206 으로 응답
    const hits = registry.requests.filter((r) => r.path === cdnPath);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].range, undefined);
    assert.equal(hits[1].range, `bytes=${at}-`);
    assert.equal(hits[1].status, 206);
    // 307 리다이렉트도 재시도마다 원래 URL 부터 다시 받았다
    assert.equal(registry.requests.filter((r) => r.kind === 'blob' && r.path.endsWith(modelDigest)).length, 2);
    // 화면에는 데모·스크린샷과 같은 줄이 나온다
    const pct = Math.floor((at / model.length) * 100);
    const short = modelHex.slice(0, 12);
    assert.ok(out.includes(`connection lost at ${pct}% (${at} bytes) of sha256:${short}: UND_ERR_SOCKET`), out);
    assert.ok(out.includes(`resumed at ${at} bytes (${pct}%) of sha256:${short} with HTTP 206 Range`), out);

    assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
    assert.deepEqual((await listTree(modelsDir)).filter((p) => p.includes('partial')), []);
  });

  it('② server ignores Range (200) → partial discarded, restarted from 0, digest matches', async () => {
    const registry = memoryRegistry({ drop: { digest: modelDigest, fraction: 0.4, times: 1 }, ignoreRange: true });
    const modelsDir = await tempDir();
    const { code, events, err } = await pullOnce(registry, modelsDir);
    assert.equal(code, 0, err);

    const ignored = events.find((e) => e.type === 'range-ignored');
    assert.ok(ignored && ignored.type === 'range-ignored');
    assert.equal(ignored.status, 200);
    assert.equal(ignored.had, Math.floor(model.length * 0.4));
    assert.equal(events.some((e) => e.type === 'resume'), false);
    const hits = registry.requests.filter((r) => r.path === cdnPath);
    assert.equal(hits.length, 2);
    assert.equal(hits[1].range, `bytes=${Math.floor(model.length * 0.4)}-`);
    assert.equal(hits[1].status, 200);
    assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
  });

  it('③ always-corrupt bytes → exit 3 after retries, no final blob, no manifest, no partial', async () => {
    const registry = memoryRegistry({ corrupt: modelDigest });
    const modelsDir = await tempDir();
    const { code, out, err } = await pullOnce(registry, modelsDir, ['--retries', '2']);
    assert.equal(code, 3, err);
    assert.match(err, /digest mismatch/);
    assert.match(out, /sha256 mismatch/);
    // 1번 + 재시도 2번 = 3번 받았다
    assert.equal(registry.requests.filter((r) => r.path === cdnPath).length, 3);
    assert.equal(existsSync(join(modelsDir, 'blobs', `sha256-${modelHex}`)), false);
    assert.equal(existsSync(join(modelsDir, 'manifests')), false);
    assert.deepEqual((await listTree(modelsDir)).filter((p) => p.includes('partial')), []);
  });

  it('④ abort from a progress event at >= 64 KiB exits 130 and keeps the partial; the next run resumes from it', async () => {
    const registry = memoryRegistry();
    const modelsDir = await tempDir();
    const partial = join(modelsDir, 'blobs', `sha256-${modelHex}.ollama-fetch.partial`);
    const controller = new AbortController();
    let received = 0;
    // 시간이 아니라 상태로 멈춘다: 모델 블롭을 64 KiB 이상 디스크에 쓴 바로 그 이벤트에서 Ctrl+C
    const onPullEvent = (e: PullEvent) => {
      if (e.type === 'progress' && e.digest === modelDigest) {
        received += e.bytes;
        if (received >= 64 * 1024 && !controller.signal.aborted) controller.abort();
      }
    };
    const first = await pullOnce(registry, modelsDir, [], { signal: controller.signal, onPullEvent });
    assert.equal(first.code, 130, first.err);
    assert.match(first.err, /Interrupted/);
    assert.equal(existsSync(partial), true, 'partial kept');
    const kept = statSync(partial).size;
    assert.ok(kept >= 64 * 1024 && kept < model.length, `partial ${kept} bytes`);
    assert.equal(existsSync(join(modelsDir, 'manifests')), false);

    const second = await pullOnce(registry, modelsDir);
    assert.equal(second.code, 0, second.err);
    const resume = second.events.find((e) => e.type === 'resume');
    assert.ok(resume && resume.type === 'resume');
    assert.equal(resume.at, kept, 'resumed exactly from the kept partial');
    assert.equal(registry.requests.filter((r) => r.path === cdnPath).at(-1)?.range, `bytes=${kept}-`);
    assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
  });

  it('stale partial larger than the blob is discarded and the blob is fetched fresh', async () => {
    const registry = memoryRegistry();
    const modelsDir = await tempDir();
    await mkdir(join(modelsDir, 'blobs'), { recursive: true });
    await writeFile(join(modelsDir, 'blobs', `sha256-${modelHex}.ollama-fetch.partial`), Buffer.alloc(model.length + 10));
    const { code, err } = await pullOnce(registry, modelsDir);
    assert.equal(code, 0, err);
    assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
  });

  it('a mirror that sends more than the declared size is cut, the partial is dropped, and nothing is saved', async () => {
    const registry = memoryRegistry({ oversize: modelDigest });
    const modelsDir = await tempDir();
    const { code, err } = await pullOnce(registry, modelsDir, ['--retries', '1']);
    assert.equal(code, 4, err);
    assert.equal(existsSync(join(modelsDir, 'blobs', `sha256-${modelHex}`)), false);
    assert.deepEqual((await listTree(modelsDir)).filter((p) => p.includes('partial')), []);
  });
});

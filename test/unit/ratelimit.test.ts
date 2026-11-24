// AC-3: 속도 상한을 가짜 시계로 증명한다(벽시계 대기 없음).
//  ① 공용 토큰 버킷: 연결 1개·8개 모두 10 MiB 에 9.85~10.1 가상 초, 무제한이면 대기 0
//  ② pull 전체(메모리 모의 레지스트리, 블롭 3개 × 1 MiB + config, --limit-rate 1M --connections 3):
//     가상 경과 = (총 바이트 − 버스트) / rate ± 2%, 실제 경과는 2초 미만
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../../src/main.js';
import { createMockRegistry } from '../../src/mock/registry-server.js';
import { defaultBurst, TokenBucket } from '../../src/ratelimit.js';
import { FakeClock } from '../support/fake-clock.js';
import { captureCtx, cleanupTempDirs, pseudoRandomBytes, sha256Hex, sha256OfFile, tempDir } from '../support/helpers.js';

after(cleanupTempDirs);

const MiB = 1024 * 1024;
const CHUNK = 64 * 1024; // undici 가 주는 덩어리 크기 정도

async function consume(bucket: TokenBucket, total: number, consumers: number): Promise<void> {
  const each = total / consumers;
  await Promise.all(
    Array.from({ length: consumers }, async () => {
      for (let done = 0; done < each; done += CHUNK) await bucket.take(Math.min(CHUNK, each - done));
    }),
  );
}

describe('AC-3 global token bucket (fake clock)', () => {
  it('default burst is 100 ms worth (min 16 KiB)', () => {
    assert.equal(defaultBurst(MiB), Math.round(MiB * 0.1));
    assert.equal(defaultBurst(10 * 1024), 16 * 1024);
  });

  for (const consumers of [1, 8]) {
    it(`10 MiB at 1 MiB/s with ${consumers} connection(s) takes 9.85-10.1 virtual seconds`, async () => {
      const clock = new FakeClock();
      const bucket = new TokenBucket(MiB, { clock });
      await consume(bucket, 10 * MiB, consumers);
      const seconds = clock.now() / 1000;
      // 이론값 = (10 MiB - 버스트 0.1 MiB) / 1 MiB/s = 9.9 s
      assert.ok(seconds >= 9.85 && seconds <= 10.1, `elapsed ${seconds}s`);
    });
  }

  it('never exceeds burst + rate * t at any point', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(MiB, { clock });
    let consumed = 0;
    for (let i = 0; i < 100; i++) {
      await bucket.take(CHUNK);
      consumed += CHUNK;
      const allowed = bucket.burst + (clock.now() / 1000) * MiB;
      assert.ok(consumed <= allowed + 1, `consumed ${consumed} > allowed ${allowed}`);
    }
  });

  it('chunks larger than the burst are split, total time still matches', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(MiB, { clock });
    await bucket.take(3 * MiB); // 한 번에 큰 덩어리
    const seconds = clock.now() / 1000;
    assert.ok(seconds >= 2.85 && seconds <= 3.0, `elapsed ${seconds}s`);
  });

  it('unlimited mode never waits', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(0, { clock });
    assert.equal(bucket.unlimited, true);
    await consume(bucket, 100 * MiB, 8);
    assert.equal(clock.now(), 0);
    assert.equal(clock.sleeps, 0);
  });
});

describe('AC-3 full pull under the cap (memory transport + fake clock)', () => {
  it('3 blobs x 1 MiB at --limit-rate 1M with 3 connections: virtual time (total - burst)/rate +-2%, real time < 2 s', async () => {
    const blobs = [1, 2, 3].map((seed) => pseudoRandomBytes(MiB, seed));
    const registry = createMockRegistry({
      models: [
        {
          namespace: 'library',
          repo: 'three',
          tag: 'latest',
          layers: blobs.map((data) => ({ mediaType: 'application/vnd.ollama.image.model', data })),
        },
      ],
    });
    const modelsDir = await tempDir();
    const clock = new FakeClock();
    const cap = captureCtx(undefined, { fetchImpl: registry.fetch, clock });

    // 실제 경과는 상한(2초)만 본다 — 메모리 전송이라 기다림이 없어야 한다
    const realStart = process.hrtime.bigint();
    const code = await main(
      ['pull', 'three', '--registry', registry.url, '--models-dir', modelsDir, '--limit-rate', '1M', '--connections', '3'],
      cap.ctx,
    );
    const realSeconds = Number(process.hrtime.bigint() - realStart) / 1e9;
    assert.equal(code, 0, cap.err());

    // 가상 경과: 버킷이 기다린 시간의 합. 연결이 3개여도 합계 1 MiB/s 다.
    const manifest = JSON.parse(registry.manifests.get('library/three:latest')!.toString()) as { config: { size: number } };
    const totalBytes = 3 * MiB + manifest.config.size;
    const expected = (totalBytes - defaultBurst(MiB)) / MiB;
    const virtualSeconds = clock.now() / 1000;
    assert.ok(
      Math.abs(virtualSeconds - expected) <= expected * 0.02,
      `virtual ${virtualSeconds.toFixed(3)} s, expected ${expected.toFixed(3)} s +-2%`,
    );
    assert.ok(realSeconds < 2, `real ${realSeconds.toFixed(2)} s`);

    for (const data of blobs) {
      const hex = sha256Hex(data);
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${hex}`)), hex);
    }
    // config + 블롭 3개가 각각 한 번씩만 받아졌다(끊김·재시도 없음)
    assert.equal(registry.requests.filter((r) => r.kind === 'cdn').length, 4);
  });
});

// AC-3: 공용 토큰 버킷(가짜 시계) — 연결 1개·8개 모두 10 MiB 에 9.85~10.1 가상 초, 무제한이면 대기 0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultBurst, TokenBucket } from '../src/ratelimit.js';
import { FakeClock } from './helpers.js';

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

describe('AC-3 global token bucket', () => {
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

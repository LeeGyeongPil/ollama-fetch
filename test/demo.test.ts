// AC-10: 오프라인 데모가 30초 안에 끝나고 이어받기·검증·병합·연습용 mock 고지를 보여 준다
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { main } from '../src/main.js';
import { captureCtx } from './helpers.js';

describe('AC-10 offline demo', () => {
  it('demo --lang en finishes < 30 s with exit 0 and the key lines', async () => {
    // 데모 안의 재시도 대기는 데모가 스스로 정한다(실제 sleep 사용)
    const cap = captureCtx({ LANG: 'ko_KR.UTF-8' }, { sleep: undefined });
    const started = performance.now();
    const code = await main(['demo', '--lang', 'en'], cap.ctx);
    const seconds = (performance.now() - started) / 1000;
    assert.equal(code, 0, cap.err());
    assert.ok(seconds < 30, `took ${seconds.toFixed(1)} s`);
    const out = cap.out();
    for (const text of ['resumed at', 'sha256 OK', 'merged 3 shards', 'practice mock registry']) {
      assert.ok(out.includes(text), `output contains "${text}"`);
    }
    assert.match(out, /blob requests on the second run: 0/);
  });

  it('demo --lang ko prints Korean', async () => {
    const cap = captureCtx({ LANG: 'en_US.UTF-8' }, { sleep: undefined });
    assert.equal(await main(['demo', '--lang', 'ko'], cap.ctx), 0, cap.err());
    assert.match(cap.out(), /연습용 모의\(mock\) 레지스트리/);
    assert.match(cap.out(), /이어받기/);
  });
});

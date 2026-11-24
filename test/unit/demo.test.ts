// AC-10(CI 쪽 절반): 같은 오프라인 데모를 메모리 전송 + 가짜 시계로 실행한다.
// 실제 HTTP(127.0.0.1)로 도는 `npm run demo` 는 로컬 확인(AC-10 명령)에서 본다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runDemo } from '../../src/demo.js';
import { createTranslator } from '../../src/i18n.js';
import { main } from '../../src/main.js';
import { FakeClock } from '../support/fake-clock.js';
import { captureCtx } from '../support/helpers.js';

async function demo(lang: 'en' | 'ko') {
  const cap = captureCtx({ LANG: lang === 'en' ? 'ko_KR.UTF-8' : 'en_US.UTF-8' });
  const clock = new FakeClock();
  const code = await runDemo({ ctx: cap.ctx, t: createTranslator(lang), lang, keep: false, run: main, transport: 'memory', clock });
  return { code, out: cap.out(), err: cap.err(), clock };
}

describe('AC-10 offline demo (memory transport, fake clock)', () => {
  it('demo in English shows resume, verification, merge and the practice-mock notice', async () => {
    const { code, out, err, clock } = await demo('en');
    assert.equal(code, 0, err);
    for (const text of ['resumed at', 'sha256 OK', 'merged 3 shards', 'practice mock registry']) {
      assert.ok(out.includes(text), `output contains "${text}"`);
    }
    assert.match(out, /connection lost at \d+% \(\d+ bytes\) of sha256:[0-9a-f]{12}: UND_ERR_SOCKET/);
    assert.match(out, /with HTTP 206 Range/);
    assert.match(out, /blob requests on the second run: 0/);
    // 2 MiB/s 상한으로 약 2.8 MiB + 재시도 대기 0.5 s 를 가상 시간으로 보냈다
    assert.ok(clock.now() > 1000, `virtual ${clock.now()} ms`);
  });

  it('demo in Korean prints Korean', async () => {
    const { code, out, err } = await demo('ko');
    assert.equal(code, 0, err);
    assert.match(out, /연습용 모의\(mock\) 레지스트리/);
    assert.match(out, /이어받기/);
  });
});

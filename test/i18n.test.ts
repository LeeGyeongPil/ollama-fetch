// AC-9: 영어·한국어 화면 — --lang · OLLAMA_FETCH_LANG · LANG 우선순위, 메시지 키 집합 동일
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MESSAGES, resolveLang } from '../src/i18n.js';
import { main } from '../src/main.js';
import { en } from '../src/messages/en.js';
import { ko } from '../src/messages/ko.js';
import { captureCtx } from './helpers.js';

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('AC-9 bilingual UI', () => {
  it('en and ko have exactly the same keys and the same {placeholders}', () => {
    const enKeys = Object.keys(en).sort();
    const koKeys = Object.keys(ko).sort();
    assert.deepEqual(enKeys.filter((k) => !koKeys.includes(k)), []);
    assert.deepEqual(koKeys.filter((k) => !enKeys.includes(k)), []);
    for (const key of enKeys) {
      const k = key as keyof typeof en;
      assert.deepEqual(placeholders(ko[k]), placeholders(en[k]), `placeholders of ${key}`);
      assert.ok(ko[k].trim() !== '', `ko ${key} not empty`);
    }
    assert.deepEqual(Object.keys(MESSAGES).sort(), ['en', 'ko']);
  });

  it('--lang ko / --lang en switch help text', async () => {
    const koCap = captureCtx();
    assert.equal(await main(['--lang', 'ko', '--help'], koCap.ctx), 0);
    assert.match(koCap.out(), /사용법/);
    const enCap = captureCtx({ LANG: 'ko_KR.UTF-8' });
    assert.equal(await main(['--help', '--lang=en'], enCap.ctx), 0);
    assert.match(enCap.out(), /Usage/);
    assert.doesNotMatch(enCap.out(), /사용법/);
  });

  it('error messages follow the language', async () => {
    const koCap = captureCtx();
    assert.equal(await main(['pull', '--lang', 'ko'], koCap.ctx), 1);
    assert.match(koCap.err(), /오류: pull 에는 모델 이름이 필요합니다/);
    const enCap = captureCtx();
    assert.equal(await main(['pull', '--lang', 'en'], enCap.ctx), 1);
    assert.match(enCap.err(), /error: pull needs a model name/);
    // 잘못된 --lang 값도 사용법 오류
    const bad = captureCtx();
    assert.equal(await main(['--lang', 'fr', '--help'], bad.ctx), 1);
    assert.match(bad.err(), /--lang/);
  });

  it('environment: OLLAMA_FETCH_LANG > LC_ALL > LC_MESSAGES > LANG, ko* means Korean, else English', async () => {
    assert.equal(resolveLang(undefined, { OLLAMA_FETCH_LANG: 'ko' }), 'ko');
    assert.equal(resolveLang(undefined, { LANG: 'ko_KR.UTF-8' }), 'ko');
    assert.equal(resolveLang(undefined, { LANG: 'fr_FR.UTF-8' }), 'en');
    assert.equal(resolveLang(undefined, {}), 'en');
    assert.equal(resolveLang(undefined, { LC_ALL: 'en_US.UTF-8', LANG: 'ko_KR.UTF-8' }), 'en');
    assert.equal(resolveLang(undefined, { LC_MESSAGES: 'ko_KR', LANG: 'en_US' }), 'ko');
    assert.equal(resolveLang(undefined, { OLLAMA_FETCH_LANG: 'en', LANG: 'ko_KR.UTF-8' }), 'en');
    assert.equal(resolveLang('en', { OLLAMA_FETCH_LANG: 'ko' }), 'en'); // --lang 이 이긴다

    const envKo = captureCtx({ OLLAMA_FETCH_LANG: 'ko' });
    await main(['--help'], envKo.ctx);
    assert.match(envKo.out(), /사용법/);
    const langKo = captureCtx({ LANG: 'ko_KR.UTF-8' });
    await main(['--help'], langKo.ctx);
    assert.match(langKo.out(), /사용법/);
    const langFr = captureCtx({ LANG: 'fr_FR.UTF-8' });
    await main(['--help'], langFr.ctx);
    assert.match(langFr.out(), /Usage/);
    const flagWins = captureCtx({ OLLAMA_FETCH_LANG: 'ko' });
    await main(['--lang', 'en', '--help'], flagWins.ctx);
    assert.match(flagWins.out(), /Usage/);
  });
});

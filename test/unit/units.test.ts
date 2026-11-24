// 보조 단위 테스트: 네트워크 오류 이유, 모델 참조 해석, 속도·크기 형식, config 블롭, CLI 기본 동작
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { buildConfig, fileTypeName, humanParams } from '../../src/config.js';
import { InputError } from '../../src/errors.js';
import { GgufType } from '../../src/gguf.js';
import { main, packageVersion } from '../../src/main.js';
import { formatBytes, formatDuration, parseRate } from '../../src/plan.js';
import { manifestPath, parseRef, refShort } from '../../src/ref.js';
import { describeNetError } from '../../src/registry.js';
import { digestHex, resolveModelsDir } from '../../src/store.js';
import { captureCtx, cliPath } from '../support/helpers.js';

describe('network error reasons', () => {
  it('uses the string code of the direct cause, else the innermost message', () => {
    // fetch 연결 거부: TypeError('fetch failed') → cause.code 'ECONNREFUSED'
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) });
    assert.equal(describeNetError(refused), 'ECONNREFUSED');
    // 본문 읽다 끊김: TypeError('terminated') → cause.code 'UND_ERR_SOCKET' (데모 출력과 같은 값)
    const dropped = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    assert.equal(describeNetError(dropped), 'UND_ERR_SOCKET');
    // 코드 없는 원인: 그 메시지
    assert.equal(describeNetError(new TypeError('fetch failed', { cause: new Error('bad port') })), 'bad port');
    // 프록시가 터널을 거절(Node 24+ NODE_USE_ENV_PROXY=1): 바로 아래 code 가 숫자 0 → ': 0' 이 아니라 안쪽 이유를 보여 준다
    const proxied = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Request was cancelled.', {
        cause: Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' }),
      }), { code: 0 }),
    });
    assert.equal(describeNetError(proxied), 'Proxy response (403) !== 200 when HTTP Tunneling');
    // 원인 없는 오류(정체 감지 등)와 문자열
    assert.equal(describeNetError(new Error('no data for 1000 ms')), 'no data for 1000 ms');
    assert.equal(describeNetError('boom'), 'boom');
  });
});

describe('model references', () => {
  it('parses the four accepted forms', () => {
    assert.deepEqual(parseRef('llama3.2'), { host: 'registry.ollama.ai', namespace: 'library', repo: 'llama3.2', tag: 'latest' });
    assert.deepEqual(parseRef('llama3.2:1b'), { host: 'registry.ollama.ai', namespace: 'library', repo: 'llama3.2', tag: '1b' });
    assert.deepEqual(parseRef('me/model:q4'), { host: 'registry.ollama.ai', namespace: 'me', repo: 'model', tag: 'q4' });
    assert.deepEqual(parseRef('hf.co/user/repo:Q4_K_M'), { host: 'hf.co', namespace: 'user', repo: 'repo', tag: 'Q4_K_M' });
    assert.deepEqual(parseRef('localhost:5000/ns/m'), { host: 'localhost:5000', namespace: 'ns', repo: 'm', tag: 'latest' });
    assert.equal(refShort(parseRef('qwen3:8b')), 'qwen3:8b');
    assert.equal(manifestPath('/m', parseRef('tiny')).split(/[\\/]/).slice(-5).join('/'), 'manifests/registry.ollama.ai/library/tiny/latest');
  });

  it('rejects names that could escape the models dir', () => {
    for (const bad of ['', '../x', 'a/../b', 'a/b/c/d', 'x@sha256:00', 'a\\b', '.hidden', 'name:']) {
      assert.throws(() => parseRef(bad), InputError, bad);
    }
    assert.throws(() => digestHex('sha256:../../etc'), InputError);
  });

  it('models dir: flag > OLLAMA_MODELS > ~/.ollama/models', () => {
    assert.equal(resolveModelsDir('/flag', { OLLAMA_MODELS: '/env' }), '/flag');
    assert.equal(resolveModelsDir(undefined, { OLLAMA_MODELS: '/env' }), '/env');
    assert.match(resolveModelsDir(undefined, {}), /\.ollama[\\/]models$/);
  });
});

describe('formatting', () => {
  it('parses curl-style rates (1024 based)', () => {
    assert.equal(parseRate('500K'), 500 * 1024);
    assert.equal(parseRate('3M'), 3 * 1024 * 1024);
    assert.equal(parseRate('1.5m'), 1.5 * 1024 * 1024);
    assert.equal(parseRate('2G'), 2 * 1024 ** 3);
    assert.equal(parseRate('1000'), 1000);
    assert.equal(parseRate('3MiB/s'), 3 * 1024 * 1024);
    assert.equal(parseRate('fast'), null);
    assert.equal(parseRate('-1M'), null);
  });

  it('formats sizes and durations', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KiB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MiB');
    assert.equal(formatDuration(8.2), '9s');
    assert.equal(formatDuration(125), '2m 05s');
    assert.equal(formatDuration(3723), '1h 02m 03s');
  });
});

describe('config blob', () => {
  it('maps GGUF metadata to Ollama config fields', () => {
    assert.equal(fileTypeName(15), 'Q4_K_M');
    assert.equal(fileTypeName(7), 'Q8_0');
    assert.equal(fileTypeName(999), 'unknown');
    assert.equal(humanParams(15_000_000), '15M');
    assert.equal(humanParams(1_240_000_000), '1.2B');
    const json = JSON.parse(
      buildConfig(
        [
          { key: 'general.architecture', type: GgufType.STRING, value: 'qwen3' },
          { key: 'general.file_type', type: GgufType.UINT32, value: 15 },
        ],
        [{ name: 'w', dims: [1000n, 1000n], ggmlType: 0, offset: 0n }],
        'sha256:' + 'a'.repeat(64),
      ).toString(),
    ) as Record<string, unknown>;
    assert.equal(json.model_format, 'gguf');
    assert.equal(json.model_family, 'qwen3');
    assert.equal(json.file_type, 'Q4_K_M');
    assert.equal(json.model_type, '1M');
  });
});

describe('CLI basics', () => {
  it('--help, --version and usage errors (exit 1)', async () => {
    const help = captureCtx();
    assert.equal(await main(['--help'], help.ctx), 0);
    assert.match(help.out(), /Usage:/);
    const version = captureCtx();
    assert.equal(await main(['--version'], version.ctx), 0);
    assert.equal(version.out().trim(), packageVersion());
    const unknown = captureCtx();
    assert.equal(await main(['frobnicate'], unknown.ctx), 1);
    assert.match(unknown.err(), /unknown command/);
    const badRate = captureCtx();
    assert.equal(await main(['pull', 'tiny', '--limit-rate', 'fast'], badRate.ctx), 1);
    assert.match(badRate.err(), /--limit-rate/);
    const negativeRate = captureCtx();
    assert.equal(await main(['pull', 'llama3.2:1b', '--limit-rate', '-5M', '--lang', 'en'], negativeRate.ctx), 1);
    assert.match(negativeRate.err(), /invalid --limit-rate '-5M'/);
    const wrongCmd = captureCtx();
    assert.equal(await main(['merge', 'x.gguf', '--limit-rate', '1M'], wrongCmd.ctx), 1);
    const badOpt = captureCtx();
    assert.equal(await main(['pull', 'tiny', '--nope'], badOpt.ctx), 1);
    assert.match(badOpt.err(), /--nope/);
  });

  it('the installed bin (dist/src/cli.js) starts and prints its version', () => {
    // 자식 프로세스는 파이프만 쓴다(네트워크 없음). bin 의 진입점 연결이 살아 있는지만 본다.
    const r = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), packageVersion());
  });
});

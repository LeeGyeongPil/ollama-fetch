// 보조 단위 테스트: 모델 참조 해석, 속도·크기 형식, config 블롭
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildConfig, fileTypeName, humanParams } from '../src/config.js';
import { InputError } from '../src/errors.js';
import { GgufType } from '../src/gguf.js';
import { formatBytes, formatDuration, parseRate } from '../src/plan.js';
import { manifestPath, parseRef, refShort } from '../src/ref.js';
import { digestHex, resolveModelsDir } from '../src/store.js';

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

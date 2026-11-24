// AC-8: 기본 집합은 밀폐돼 있다 — 네트워크 가드가 정말 켜져 있고, test/unit 소스에 실제 소켓·벽시계 대기가 없다.
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../support/helpers.js';

const guarded = { name: 'NetworkGuardError' };

describe('AC-8 network guard', () => {
  it('is loaded in this test process', () => {
    assert.equal((globalThis as Record<symbol, unknown>)[Symbol.for('ollama-fetch.networkGuard')], true);
  });

  it('blocks fetch, net.connect, listen and dns.lookup', async () => {
    await assert.rejects(async () => fetch('http://127.0.0.1:9'), guarded);
    assert.throws(() => net.connect(9, '127.0.0.1'), guarded);
    // 아래 소스 검사가 "listen" 호출 문자열을 찾으므로, 가드 자체 검사만 call 로 부른다(이 파일의 유일한 예외)
    const server = createServer();
    const openPort = server.listen;
    assert.throws(() => openPort.call(server, 0), guarded);
    assert.throws(() => dns.lookup('example.com', () => undefined), guarded);
    await assert.rejects(async () => dns.promises.lookup('example.com'), guarded);
  });
});

describe('AC-8 unit sources stay hermetic', () => {
  it('no real mock server, no port opening, no wall-clock elapsed measurement and no interval polling under test/unit', () => {
    // 이 파일도 검사 대상이므로 찾는 문자열은 조각을 이어 만든다
    const forbidden = ['startMock' + 'Registry', 'listen' + '(', 'performance.now()' + ' -', 'setInter' + 'val('];
    const dir = join(repoRoot, 'test', 'unit');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 10, `found ${files.length} unit test sources`);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const word of forbidden) if (text.includes(word)) hits.push(`${file}: ${word}`);
    }
    assert.deepEqual(hits, []);
  });
});

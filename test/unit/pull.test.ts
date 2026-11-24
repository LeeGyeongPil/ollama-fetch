// AC-4: 메모리 모의 레지스트리(307 CDN 리다이렉트)에서 pull → 블롭·매니페스트 배치, 쓰기 순서, 재실행 시 블롭 요청 0,
// --dry-run 은 표·합계·예상 시간을 보여 주고 폴더를 바꾸지 않는다. 소켓은 하나도 열지 않는다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../../src/main.js';
import { createMockRegistry, tinyModelLayers } from '../../src/mock/registry-server.js';
import { encodeModel, synthModel } from '../../src/mock/synth-gguf.js';
import { type PullEvent } from '../../src/pull.js';
import { captureCtx, cleanupTempDirs, listTree, sha256OfFile, tempDir } from '../support/helpers.js';

after(cleanupTempDirs);

const tinyModels = () => [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(encodeModel(synthModel({ scale: 4 }))) }];

describe('AC-4 pull from the in-memory mock registry', () => {
  it('stores verified blobs, then the raw manifest last; rerun makes 0 blob requests', async () => {
    const registry = createMockRegistry({ models: tinyModels() });
    const modelsDir = await tempDir();
    const manifestFile = join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', 'tiny', 'latest');

    // 1) 첫 실행 — 이벤트로 쓰기 순서를 기록한다
    const order: string[] = [];
    const onPullEvent = (e: PullEvent) => {
      if (e.type === 'blob-done') {
        // 블롭이 하나 확정될 때 매니페스트는 아직 없어야 한다
        assert.equal(existsSync(manifestFile), false, 'manifest must not exist before all blobs');
        order.push(`blob:${e.digest}`);
      }
      if (e.type === 'manifest-written') order.push('manifest');
    };
    const first = captureCtx(undefined, { fetchImpl: registry.fetch, onPullEvent });
    const code = await main(['pull', 'library/tiny:latest', '--registry', registry.url, '--models-dir', modelsDir], first.ctx);
    assert.equal(code, 0, first.err());

    // 매니페스트의 모든 레이어(+config)가 blobs/sha256-<hex> 로 있고 내용 해시 = 이름
    const raw = registry.manifests.get('library/tiny:latest') as Buffer;
    const manifest = JSON.parse(raw.toString()) as { config: { digest: string }; layers: { digest: string }[] };
    const digests = [manifest.config.digest, ...manifest.layers.map((l) => l.digest)];
    assert.equal(digests.length, 4);
    for (const d of digests) {
      const hex = d.slice('sha256:'.length);
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${hex}`)), hex);
    }
    // 매니페스트는 원문 그대로, 블롭 4개 뒤에 마지막으로
    assert.ok(readFileSync(manifestFile).equals(raw));
    assert.equal(order.length, 5);
    assert.equal(order[4], 'manifest');
    // partial·임시 파일이 남지 않는다
    const tree = await listTree(modelsDir);
    assert.deepEqual(tree.filter((p) => p.endsWith('.ollama-fetch.partial') || p.endsWith('.tmp')), []);
    // 실제 레지스트리처럼 307 → CDN 경로를 탔다
    assert.ok(registry.requests.some((r) => r.kind === 'blob' && r.status === 307));
    assert.ok(registry.requests.some((r) => r.kind === 'cdn' && r.status === 200));

    // 2) 같은 명령을 다시 — 블롭 GET 0회
    const before = registry.blobRequests();
    const again = captureCtx(undefined, { fetchImpl: registry.fetch });
    assert.equal(await main(['pull', 'library/tiny:latest', '--registry', registry.url, '--models-dir', modelsDir], again.ctx), 0, again.err());
    assert.equal(registry.blobRequests() - before, 0);
    assert.match(again.out(), /already complete/);
    assert.ok(readFileSync(manifestFile).equals(raw));
  });

  it('--dry-run prints media type, size, present/missing, total and ETA; writes nothing', async () => {
    const registry = createMockRegistry({ models: tinyModels() });
    const modelsDir = await tempDir();
    // 템플릿 블롭 하나는 이미 있다고 해 둔다 → present 로 보여야 한다
    const manifest = JSON.parse((registry.manifests.get('library/tiny:latest') as Buffer).toString()) as {
      layers: { digest: string; mediaType: string }[];
    };
    const template = manifest.layers.find((l) => l.mediaType.endsWith('.template'))!;
    await mkdir(join(modelsDir, 'blobs'), { recursive: true });
    await writeFile(join(modelsDir, 'blobs', template.digest.replace(':', '-')), '{{ .Prompt }}');
    const before = await listTree(modelsDir);

    const cap = captureCtx(undefined, { fetchImpl: registry.fetch });
    const code = await main(
      ['pull', 'library/tiny:latest', '--registry', registry.url, '--models-dir', modelsDir, '--limit-rate', '2M', '--dry-run', '--lang', 'en'],
      cap.ctx,
    );
    assert.equal(code, 0, cap.err());
    assert.match(cap.out(), /application\/vnd\.ollama\.image\.model/);
    assert.match(cap.out(), /missing/);
    assert.match(cap.out(), /present/);
    assert.match(cap.out(), /Estimated time at 2\.0 MiB\/s: \d+s/);
    assert.match(cap.out(), /to download/);
    assert.deepEqual(await listTree(modelsDir), before, 'models dir unchanged');
    assert.equal(registry.blobRequests(), 0, 'dry run downloads no blobs');

    // 모델 폴더가 아예 없을 때도 만들지 않는다
    const fresh = join(await tempDir(), 'not-created');
    const cap2 = captureCtx(undefined, { fetchImpl: registry.fetch });
    assert.equal(await main(['pull', 'tiny', '--registry', registry.url, '--models-dir', fresh, '--dry-run'], cap2.ctx), 0, cap2.err());
    assert.match(cap2.out(), /depends on your connection/);
    assert.equal(existsSync(fresh), false);
  });

  it('manifest 404 exits 4, unreachable registry exits 4, bad name exits 2', async () => {
    const registry = createMockRegistry({ models: [] });
    const modelsDir = await tempDir();
    let cap = captureCtx(undefined, { fetchImpl: registry.fetch });
    assert.equal(await main(['pull', 'nope', '--registry', registry.url, '--models-dir', modelsDir], cap.ctx), 4);
    assert.match(cap.err(), /not found/);
    assert.deepEqual(await listTree(modelsDir), []);

    // 연결 거부: 실제 fetch 가 내는 것과 같은 모양의 오류를 주는 전송
    const refused = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) });
    };
    cap = captureCtx(undefined, { fetchImpl: refused });
    assert.equal(await main(['pull', 'x', '--registry', 'http://127.0.0.1:9', '--models-dir', modelsDir], cap.ctx), 4);
    assert.match(cap.err(), /ECONNREFUSED/);

    cap = captureCtx();
    assert.equal(await main(['pull', '../etc/passwd', '--models-dir', modelsDir], cap.ctx), 2);
  });
});

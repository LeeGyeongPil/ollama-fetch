// AC-8: merge --register — 병합본이 blobs/sha256-<해시> 로, config·매니페스트의 다이제스트·크기가 실제 파일과 일치
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { mergeAndRegister } from '../src/config.js';
import { main } from '../src/main.js';
import { planMerge } from '../src/merge.js';
import { synthModel, writeSplitModel } from '../src/mock/synth-gguf.js';
import { parseRef } from '../src/ref.js';
import { captureCtx, cleanupTempDirs, listTree, sha256OfFile, tempDir } from './helpers.js';

after(cleanupTempDirs);

interface Manifest {
  schemaVersion: number;
  config: { mediaType: string; digest: string; size: number };
  layers: { mediaType: string; digest: string; size: number }[];
}

function blobFile(modelsDir: string, digest: string): string {
  return join(modelsDir, 'blobs', digest.replace(':', '-'));
}

describe('AC-8 merge --register', () => {
  it('registers the merged model with matching digests and sizes', async () => {
    const work = await tempDir();
    const modelsDir = await tempDir();
    const shards = writeSplitModel(work, 'tiny', synthModel({ alignment: 64 }), 3);

    const cap = captureCtx();
    const code = await main(['merge', shards[0], '--register', 'tiny-merged', '--models-dir', modelsDir], cap.ctx);
    assert.equal(code, 0, cap.err());
    assert.match(cap.out(), /merged 3 shards/);
    assert.match(cap.out(), /ollama run tiny-merged:latest/);

    const manifestPath = join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', 'tiny-merged', 'latest');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.layers.length, 1);
    const layer = manifest.layers[0];
    assert.equal(layer.mediaType, 'application/vnd.ollama.image.model');
    // 레이어 다이제스트·크기 = 실제 블롭 파일
    assert.equal(`sha256:${await sha256OfFile(blobFile(modelsDir, layer.digest))}`, layer.digest);
    assert.equal(statSync(blobFile(modelsDir, layer.digest)).size, layer.size);
    // config 다이제스트·크기 = 실제 config 블롭
    assert.equal(manifest.config.mediaType, 'application/vnd.docker.container.image.v1+json');
    assert.equal(`sha256:${await sha256OfFile(blobFile(modelsDir, manifest.config.digest))}`, manifest.config.digest);
    assert.equal(statSync(blobFile(modelsDir, manifest.config.digest)).size, manifest.config.size);
    const config = JSON.parse(readFileSync(blobFile(modelsDir, manifest.config.digest), 'utf8')) as Record<string, unknown>;
    assert.equal(config.model_format, 'gguf');
    assert.equal(config.model_family, 'llama'); // 합성 파일의 general.architecture
    assert.deepEqual(config.model_families, ['llama']);
    assert.equal(config.file_type, 'F32');
    assert.deepEqual((config.rootfs as { diff_ids: string[] }).diff_ids, [layer.digest]);
    // 임시 파일이 남지 않는다
    assert.deepEqual((await listTree(modelsDir)).filter((p) => p.includes('partial') || p.endsWith('.tmp')), []);
  });

  it('hash computed while merging equals the re-read blob hash; -o also keeps a file', async () => {
    const work = await tempDir();
    const modelsDir = await tempDir();
    const shards = writeSplitModel(work, 'tiny', synthModel(), 3);
    const out = join(work, 'merged.gguf');
    const res = await mergeAndRegister(await planMerge(shards[0]), {
      ref: parseRef('tiny-merged:q'),
      modelsDir,
      output: out,
    });
    const reread = `sha256:${await sha256OfFile(blobFile(modelsDir, res.modelDigest))}`;
    assert.equal(res.modelDigest, reread);
    assert.equal(`sha256:${await sha256OfFile(out)}`, res.modelDigest);
    assert.equal(res.manifestPath, join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', 'tiny-merged', 'q'));
  });
});

// AC-2: 분할 GGUF 병합 — 텐서 수·텐서별 바이트·split 키 제거·정렬·골든 해시, 빠진 샤드는 종료 코드 2
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { buildHeader, getKv, GgufType, readGguf, tensorNbytes, type GgufHeader } from '../src/gguf.js';
import { main } from '../src/main.js';
import { mergeToFile, planMerge } from '../src/merge.js';
import { encodeModel, synthModel, writeSplitModel } from '../src/mock/synth-gguf.js';
import { captureCtx, cleanupTempDirs, repoRoot, sha256Hex, sha256OfFile, tempDir } from './helpers.js';

after(cleanupTempDirs);

const golden = JSON.parse(readFileSync(join(repoRoot, 'test', 'fixtures', 'golden.json'), 'utf8')) as Record<
  string,
  { sha256: string; size: number; tensors: number }
>;

/** 파일에서 텐서 하나의 데이터 바이트 */
function tensorBytes(path: string, header: GgufHeader, name: string): Buffer {
  const t = header.tensors.find((x) => x.name === name);
  assert.ok(t, `tensor ${name} exists`);
  const start = header.dataOffset + Number(t.offset);
  return readFileSync(path).subarray(start, start + (tensorNbytes(t) as number));
}

describe('AC-2 split GGUF merge', () => {
  for (const alignment of [32, 64]) {
    it(`merges 3 shards correctly (alignment ${alignment})`, async () => {
      const dir = await tempDir();
      const model = synthModel({ alignment });
      const shards = writeSplitModel(dir, 'tiny', model, 3);
      const out = join(dir, 'merged.gguf');
      const result = await mergeToFile(await planMerge(shards[0]), out);

      const merged = readGguf(out);
      const shardHeaders = shards.map((s) => readGguf(s));
      // 텐서 수 = split.tensors.count
      assert.equal(merged.tensors.length, getKv(shardHeaders[0], 'split.tensors.count'));
      // split.* 키 0개
      assert.deepEqual(merged.kv.filter((k) => k.key.startsWith('split.')), []);
      // 모든 텐서 오프셋과 데이터 시작이 정렬 배수
      assert.equal(merged.alignment, alignment);
      assert.equal(merged.dataOffset % alignment, 0);
      for (const t of merged.tensors) assert.equal(Number(t.offset) % alignment, 0, `${t.name} aligned`);
      // 텐서마다 데이터 바이트가 원본 샤드와 같다
      for (const t of merged.tensors) {
        const s = shardHeaders.findIndex((h) => h.tensors.some((x) => x.name === t.name));
        assert.ok(s >= 0);
        assert.equal(
          sha256Hex(tensorBytes(out, merged, t.name)),
          sha256Hex(tensorBytes(shards[s], shardHeaders[s], t.name)),
          `${t.name} bytes`,
        );
      }
      // 골든 해시(결정성) + 쓰면서 계산한 해시 = 파일 해시
      const g = golden[`align${alignment}`];
      assert.equal(result.sha256, g.sha256);
      assert.equal(result.size, g.size);
      assert.equal(await sha256OfFile(out), g.sha256);
      assert.equal(merged.tensors.length, g.tensors);
      // 나누기 전의 단일 파일과 바이트가 같다(split 키를 빼고 오프셋을 다시 계산했으므로)
      assert.equal(sha256Hex(encodeModel(model)), g.sha256);
    });
  }

  it('default output name drops the -00001-of-00003 part', async () => {
    const dir = await tempDir();
    const shards = writeSplitModel(dir, 'Qwen3-Tiny-Q4_K_M', synthModel(), 3);
    const cap = captureCtx();
    assert.equal(await main(['merge', shards[0]], cap.ctx), 0, cap.err());
    assert.match(cap.out(), /merged 3 shards/);
    assert.equal(await sha256OfFile(join(dir, 'Qwen3-Tiny-Q4_K_M.gguf')), golden.align32.sha256);
  });

  it('missing shard: exit 2, names the missing file, writes nothing', async () => {
    const dir = await tempDir();
    const shards = writeSplitModel(dir, 'tiny', synthModel(), 3);
    await rm(shards[1]);
    const before = (await readdir(dir)).sort();
    const cap = captureCtx();
    const code = await main(['merge', shards[0], '-o', join(dir, 'out.gguf')], cap.ctx);
    assert.equal(code, 2);
    assert.match(cap.err(), /00002-of-00003/);
    assert.deepEqual((await readdir(dir)).sort(), before, 'no output or temp file left');
  });

  it('split.count mismatch: exit 2, names the bad shard, writes nothing', async () => {
    const dir = await tempDir();
    const shards = writeSplitModel(dir, 'tiny', synthModel(), 3);
    // 3번 샤드의 split.count 를 4 로 바꿔 다시 쓴다
    const bytes = readFileSync(shards[2]);
    const h = readGguf(shards[2]);
    const kv = h.kv.map((k) => (k.key === 'split.count' ? { key: k.key, type: GgufType.UINT16, value: 4 } : k));
    await writeFile(shards[2], Buffer.concat([buildHeader({ ...h, kv }), bytes.subarray(h.dataOffset)]));
    const before = (await readdir(dir)).sort();
    const cap = captureCtx();
    const code = await main(['merge', shards[0], '-o', join(dir, 'out.gguf')], cap.ctx);
    assert.equal(code, 2);
    assert.match(cap.err(), new RegExp(basename(shards[2])));
    assert.match(cap.err(), /split\.count/);
    assert.deepEqual((await readdir(dir)).sort(), before);
  });

  it('non-GGUF input: exit 2', async () => {
    const dir = await tempDir();
    const fake = join(dir, 'fake-00001-of-00001.gguf');
    await writeFile(fake, 'not a gguf at all, just text that is long enough');
    const cap = captureCtx();
    assert.equal(await main(['merge', fake, '-o', join(dir, 'o.gguf')], cap.ctx), 2);
    assert.match(cap.err(), /not a GGUF file/);
  });
});

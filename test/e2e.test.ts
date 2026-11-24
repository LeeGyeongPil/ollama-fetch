// 선택 실측(AC 아님): OLLAMA_FETCH_E2E=1 일 때만 실제 Hugging Face 에서 분할 GGUF 3개(26.7 MB)를
// 같은 다운로더(Range·버킷·sha256)로 받고 병합한다. 프록시 환경이면 NODE_USE_ENV_PROXY=1 도 필요하다.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { downloadBlob } from '../src/download.js';
import { mergeToFile, planMerge } from '../src/merge.js';
import { TokenBucket } from '../src/ratelimit.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

after(cleanupTempDirs);

const REPO = 'ngxson/tinyllama_split_test';
// 같은 샤드를 llama.cpp 로더(Ollama 0.40.15)가 정상 로드한 병합본의 sha256 (2026-11-24 확인)
const MERGED_SHA256 = '2eda49203f2f044f3dddf29a7dd7cc861ef5a0340f518a19613d73ba6d9c06b6';
const enabled = process.env.OLLAMA_FETCH_E2E === '1';

describe('optional real-network E2E', () => {
  it('downloads HF split shards under a rate cap and merges them', { skip: enabled ? false : 'set OLLAMA_FETCH_E2E=1' }, async () => {
    const dir = await tempDir();
    const tree = (await (await fetch(`https://huggingface.co/api/models/${REPO}/tree/main`)).json()) as {
      path: string;
      size: number;
      lfs?: { oid: string };
    }[];
    const shards = tree.filter((f) => /-\d{5}-of-\d{5}\.gguf$/.test(f.path) && f.lfs).sort((a, b) => a.path.localeCompare(b.path));
    assert.equal(shards.length, 3);
    const rate = 2 * 1024 * 1024; // 보통 회선보다 낮게 잡아 상한이 실제로 걸리게 한다
    const bucket = new TokenBucket(rate);
    const total = shards.reduce((s, f) => s + f.size, 0);
    const started = performance.now();
    await Promise.all(
      shards.map((f) =>
        downloadBlob({
          url: `https://huggingface.co/${REPO}/resolve/main/${f.path}`,
          dest: join(dir, f.path),
          digest: `sha256:${f.lfs!.oid}`,
          size: f.size,
          bucket,
          retries: 3,
        }),
      ),
    );
    const seconds = (performance.now() - started) / 1000;
    assert.ok(seconds >= ((total - bucket.burst) / rate) * 0.95, `elapsed ${seconds}s respects the cap`);
    const result = await mergeToFile(await planMerge(join(dir, shards[0].path)), join(dir, 'merged.gguf'));
    assert.equal(result.sha256, MERGED_SHA256);
    console.log(`E2E: ${total} bytes in ${seconds.toFixed(2)} s (${(total / seconds / 1048576).toFixed(2)} MiB/s, cap 2 MiB/s)`);
  });
});

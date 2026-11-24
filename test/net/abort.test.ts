// AC-10(test:net): 실제 Ctrl+C — CLI 를 자식 프로세스로 띄워 받는 중에 SIGINT 를 보낸다.
// 종료 코드 130, partial 유지, 다음 실행이 그 위치부터 Range 로 이어받는다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../../src/main.js';
import { sha256Digest, startMockRegistry, tinyModelLayers } from '../../src/mock/registry-server.js';
import { encodeModel, synthModel } from '../../src/mock/synth-gguf.js';
import { type PullEvent } from '../../src/pull.js';
import { captureCtx, cleanupTempDirs, cliPath, sha256OfFile, tempDir } from '../support/helpers.js';

after(cleanupTempDirs);

const model = encodeModel(synthModel({ scale: 8 })); // 약 2 MiB
const modelDigest = sha256Digest(model);
const modelHex = modelDigest.slice('sha256:'.length);

describe('AC-10 net: Ctrl+C', () => {
  it('SIGINT exits 130 and keeps the partial; the next run resumes from it', async () => {
    const registry = await startMockRegistry({
      models: [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(model) }],
    });
    try {
      const modelsDir = await tempDir();
      const partial = join(modelsDir, 'blobs', `sha256-${modelHex}.ollama-fetch.partial`);
      // 1 MiB/s 상한이라 약 2 MiB 를 받는 데 2초쯤 걸린다. partial 이 64 KiB 를 넘으면 Ctrl+C.
      const child = spawn(
        process.execPath,
        [cliPath, 'pull', 'tiny', '--registry', registry.url, '--models-dir', modelsDir, '--limit-rate', '1M', '--lang', 'en'],
        { env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      const poll = setInterval(() => {
        if (existsSync(partial) && statSync(partial).size >= 64 * 1024) {
          clearInterval(poll);
          child.kill('SIGINT');
        }
      }, 20);
      const giveUp = setTimeout(() => child.kill('SIGKILL'), 20_000);
      const code = await exited;
      clearInterval(poll);
      clearTimeout(giveUp);

      assert.equal(code, 130, stderr);
      assert.match(stderr, /Interrupted/);
      assert.equal(existsSync(partial), true, 'partial kept');
      const kept = statSync(partial).size;
      assert.equal(existsSync(join(modelsDir, 'manifests')), false);

      const events: PullEvent[] = [];
      const cap = captureCtx(undefined, { onPullEvent: (e) => events.push(e) });
      assert.equal(await main(['pull', 'tiny', '--registry', registry.url, '--models-dir', modelsDir], cap.ctx), 0, cap.err());
      const resume = events.find((e) => e.type === 'resume');
      assert.ok(resume && resume.type === 'resume');
      assert.equal(resume.at, kept);
      assert.equal(await sha256OfFile(join(modelsDir, 'blobs', `sha256-${modelHex}`)), modelHex);
    } finally {
      await registry.close();
    }
  });
});

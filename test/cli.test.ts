// AC-7: --dry-run 은 표·합계·예상 시간을 보여 주고 파일을 하나도 만들지 않는다(CLI 를 자식 프로세스로 실행)
// + 도움말·버전·사용법 오류 종료 코드
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { main } from '../src/main.js';
import { startMockRegistry, tinyModelLayers } from '../src/mock/registry-server.js';
import { encodeModel, synthModel } from '../src/mock/synth-gguf.js';
import { captureCtx, cleanupTempDirs, cliPath, listTree, repoRoot, tempDir } from './helpers.js';

after(cleanupTempDirs);

const run = promisify(execFile);

/** 자식 프로세스로 CLI 실행 → { code, stdout, stderr } */
async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('AC-7 --dry-run', () => {
  it('prints media type, size, present/missing, total and ETA; writes nothing', async () => {
    const gguf = encodeModel(synthModel({ scale: 4 }));
    const registry = await startMockRegistry({
      models: [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(gguf) }],
    });
    try {
      const modelsDir = await tempDir();
      // 템플릿 블롭 하나는 이미 있다고 해 둔다 → present 로 보여야 한다
      const manifest = JSON.parse((registry.manifests.get('library/tiny:latest') as Buffer).toString()) as {
        layers: { digest: string; mediaType: string }[];
      };
      const template = manifest.layers.find((l) => l.mediaType.endsWith('.template'))!;
      await mkdir(join(modelsDir, 'blobs'), { recursive: true });
      await writeFile(join(modelsDir, 'blobs', template.digest.replace(':', '-')), '{{ .Prompt }}');
      const before = await listTree(modelsDir);

      const r = await cli([
        'pull', 'library/tiny:latest', '--registry', registry.url, '--models-dir', modelsDir,
        '--limit-rate', '2M', '--dry-run', '--lang', 'en',
      ]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /application\/vnd\.ollama\.image\.model/);
      assert.match(r.stdout, /missing/);
      assert.match(r.stdout, /present/);
      assert.match(r.stdout, /Estimated time at 2\.0 MiB\/s: \d+s/);
      assert.match(r.stdout, /to download/);
      assert.deepEqual(await listTree(modelsDir), before, 'models dir unchanged');
      assert.equal(registry.blobRequests(), 0, 'dry run downloads no blobs');

      // 모델 폴더가 아예 없을 때도 만들지 않는다
      const fresh = join(await tempDir(), 'not-created');
      const r2 = await cli(['pull', 'tiny', '--registry', registry.url, '--models-dir', fresh, '--dry-run']);
      assert.equal(r2.code, 0, r2.stderr);
      assert.match(r2.stdout, /depends on your connection/);
      assert.deepEqual(await listTree(fresh), []);
    } finally {
      await registry.close();
    }
  });
});

describe('CLI basics', () => {
  it('--help, --version, usage errors', async () => {
    const help = await cli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage:/);
    const version = await cli(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+/);
    const unknown = await cli(['frobnicate']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown command/);
    const badRate = await cli(['pull', 'tiny', '--limit-rate', 'fast']);
    assert.equal(badRate.code, 1);
    assert.match(badRate.stderr, /--limit-rate/);
    const wrongCmd = await cli(['merge', 'x.gguf', '--limit-rate', '1M']);
    assert.equal(wrongCmd.code, 1);
    const badOpt = await cli(['pull', 'tiny', '--nope']);
    assert.equal(badOpt.code, 1);
    assert.match(badOpt.stderr, /--nope/);
  });
});

describe('negative --limit-rate', () => {
  it('reports an invalid rate, not a missing value', async () => {
    const cap = captureCtx();
    const code = await main(['pull', 'llama3.2:1b', '--limit-rate', '-5M', '--lang', 'en'], cap.ctx);
    assert.equal(code, 1);
    assert.match(cap.err(), /invalid --limit-rate '-5M'/);
  });
});

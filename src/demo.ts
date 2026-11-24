// 오프라인 데모: 연습용 모의 레지스트리(127.0.0.1)와 합성 GGUF 로 전체 흐름을 실제 CLI 명령 그대로 보여 준다.
// 속도 제한 받기 → 40% 지점 강제 끊김 → Range 이어받기 → 다이제스트 검증 → 다시 실행(요청 0) → 분할 병합·등록.
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Lang, Translate } from './i18n.js';
import type { CliContext } from './main.js';
import { sha256Digest, startMockRegistry, tinyModelLayers } from './mock/registry-server.js';
import { encodeModel, synthModel, writeSplitModel } from './mock/synth-gguf.js';
import { formatBytes } from './plan.js';
import { Printer } from './report.js';

type Run = (argv: string[], ctx: CliContext) => Promise<number>;

class StepFailed extends Error {
  constructor(readonly code: number) {
    super(`demo step failed with exit code ${code}`);
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out.sort();
}

export async function runDemo(options: { ctx: CliContext; t: Translate; lang: Lang; keep: boolean; run: Run }): Promise<number> {
  const { ctx, t, lang, run } = options;
  const printer = new Printer(ctx);
  const root = await mkdtemp(join(tmpdir(), 'ollama-fetch-demo-'));
  const modelsDir = join(root, 'models');
  // 데모 안에서는 재시도 대기를 0.5초로 줄인다(실제 기본값은 1초, 2초, 4초 …)
  const demoCtx: CliContext = { ...ctx, retryDelayMs: () => 500 };
  const show = (argv: string[]) => printer.line(`\n$ ollama-fetch ${argv.join(' ')}`);
  const exec = async (argv: string[]) => {
    show(argv);
    const code = await run([...argv, '--lang', lang], demoCtx);
    // 단계가 실패하면(오류 문구는 그 명령이 이미 출력했다) 같은 종료 코드로 데모를 끝낸다
    if (code !== 0) throw new StepFailed(code);
  };

  try {
    printer.line(t('demo_title'));

    // 1) 합성 모델(약 3 MiB)을 올린 모의 레지스트리. 모델 블롭은 40% 지점에서 한 번 끊는다.
    const gguf = encodeModel(synthModel({ scale: 10 }));
    const registry = await startMockRegistry({
      models: [{ namespace: 'library', repo: 'tiny', tag: 'latest', layers: tinyModelLayers(gguf) }],
      faults: { drop: { digest: sha256Digest(gguf), fraction: 0.4, times: 1 } },
    });
    try {
      const pullArgs = ['pull', 'tiny', '--registry', registry.url, '--limit-rate', '2M', '--connections', '2', '--models-dir', modelsDir];
      printer.line('');
      printer.line(t('demo_step_pull', { rate: '2.0 MiB/s', connections: 2 }));
      await exec(pullArgs);

      // 2) 같은 명령을 다시: 블롭이 다 있으니 모의 서버에 블롭 요청이 가지 않는다
      printer.line('');
      printer.line(t('demo_step_rerun'));
      const before = registry.blobRequests();
      await exec(pullArgs);
      printer.line(t('demo_rerun_result', { requests: registry.blobRequests() - before }));
    } finally {
      await registry.close();
    }

    // 3) 분할 GGUF 3개를 만들고(hf download 로 받은 샤드라고 생각하자) 병합·등록
    const shardsDir = join(root, 'shards');
    await mkdir(shardsDir, { recursive: true });
    const shards = writeSplitModel(shardsDir, 'tiny-split', synthModel({ scale: 4, alignment: 64, seed: 7, name: 'tiny-split' }), 3);
    printer.line('');
    printer.line(t('demo_step_merge', { name: 'tiny-merged:latest' }));
    await exec(['merge', shards[0], '--register', 'tiny-merged', '--models-dir', modelsDir]);

    // 4) Ollama 가 읽는 폴더 구조
    printer.line('');
    printer.line(t('demo_step_tree', { dir: modelsDir }));
    for (const file of await listFiles(modelsDir)) {
      const rel = relative(modelsDir, file).split('\\').join('/');
      const shown = rel.replace(/(sha256-[0-9a-f]{12})[0-9a-f]{52}$/, '$1…');
      printer.line(`  ${shown}  (${formatBytes((await stat(file)).size)})`);
    }

    printer.line('');
    printer.line(t('demo_footer'));
    if (options.keep) printer.line(t('demo_kept', { dir: root }));
    return 0;
  } catch (err) {
    if (err instanceof StepFailed) return err.code;
    throw err;
  } finally {
    if (!options.keep) await rm(root, { recursive: true, force: true });
  }
}

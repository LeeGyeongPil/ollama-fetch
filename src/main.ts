// CLI 본체: 인자 해석 → 하위 명령(pull · merge · demo) 실행 → 종료 코드.
// 테스트가 자식 프로세스 없이도 부를 수 있게 출력·환경·신호를 인자로 받는다(실행 파일은 cli.ts).
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { mergeAndRegister } from './config.js';
import { runDemo } from './demo.js';
import { defaultSleep, type Sleep } from './download.js';
import { AppError, EXIT, isAbortError, UsageError } from './errors.js';
import { createTranslator, type Lang, resolveLang, type Translate } from './i18n.js';
import { mergeToFile, planMerge } from './merge.js';
import { formatBytes, formatElapsed, formatRate, parseRate, planBlobs, renderPlan } from './plan.js';
import { allBlobs, pullModel } from './pull.js';
import { fetchManifest } from './registry.js';
import { type ModelRef, parseRef, refShort, refToString, registryBase } from './ref.js';
import { createPullReporter, type Output, Printer } from './report.js';
import { resolveModelsDir } from './store.js';

export interface CliContext extends Output {
  env: NodeJS.ProcessEnv;
  /** Ctrl+C 등으로 멈출 때 */
  signal?: AbortSignal;
  /** 테스트에서 재시도 대기를 줄이려고 바꿔 끼운다 */
  sleep?: Sleep;
  retryDelayMs?: (failure: number) => number;
}

export function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../../package.json') as { version: string }).version;
}

// 모든 하위 명령의 옵션. 어떤 명령에 쓸 수 있는지는 COMMAND_OPTIONS 로 따로 검사한다.
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  lang: { type: 'string' },
  'limit-rate': { type: 'string' },
  connections: { type: 'string' },
  'dry-run': { type: 'boolean' },
  retries: { type: 'string' },
  registry: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  'models-dir': { type: 'string' },
  output: { type: 'string', short: 'o' },
  register: { type: 'string' },
  keep: { type: 'boolean' },
} as const;

const COMMON = ['help', 'version', 'lang'];
const COMMAND_OPTIONS: Record<string, string[]> = {
  pull: [...COMMON, 'limit-rate', 'connections', 'dry-run', 'retries', 'registry', 'quiet', 'models-dir'],
  merge: [...COMMON, 'output', 'register', 'quiet', 'models-dir'],
  demo: [...COMMON, 'keep'],
};

/** --lang 은 다른 인자 오류보다 먼저 알아야 오류 문구도 그 언어로 낼 수 있다 */
function scanLangFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') return argv[i + 1] ?? '';
    if (argv[i].startsWith('--lang=')) return argv[i].slice('--lang='.length);
  }
  return undefined;
}

function parseIntOption(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < min || n > max) {
    throw new UsageError('err_bad_int', { option: `--${name}`, value, min, max });
  }
  return n;
}

/** node:util parseArgs 오류 → 우리 사용법 오류(옵션 이름만 뽑아 고른 언어로 낸다) */
function toUsageError(err: unknown): UsageError {
  const e = err as { code?: string; message?: string };
  const option = /'(-[^' ]+)/.exec(e.message ?? '')?.[1] ?? '';
  if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return new UsageError('err_unknown_option', { option });
  if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return new UsageError('err_option_value', { option });
  return new UsageError('err_bad_option', { detail: e.message ?? String(err) });
}

function parseCli(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw toUsageError(err);
  }
}

export async function main(argv: string[], ctx: CliContext): Promise<number> {
  const langFlag = scanLangFlag(argv);
  const badLang = langFlag !== undefined && langFlag !== 'en' && langFlag !== 'ko';
  const lang: Lang = resolveLang(badLang ? undefined : langFlag, ctx.env);
  const t = createTranslator(lang);
  const printer = new Printer(ctx);
  const version = packageVersion();

  try {
    if (badLang) throw new UsageError('err_bad_lang', { value: langFlag ?? '' });

    const { values, positionals } = parseCli(argv);
    const command = positionals[0];

    if (values.version) {
      ctx.stdout(`${version}\n`);
      return EXIT.ok;
    }
    if (values.help || !command || command === 'help') {
      ctx.stdout(t('help', { version }) + '\n');
      return EXIT.ok;
    }
    const allowed = COMMAND_OPTIONS[command];
    if (!allowed) throw new UsageError('err_unknown_command', { command });
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key)) throw new UsageError('err_option_not_for', { option: `--${key}`, command });
    }

    if (command === 'pull') return await runPull(positionals.slice(1), values, ctx, t);
    if (command === 'merge') return await runMerge(positionals.slice(1), values, ctx, t);
    // 데모는 실제 CLI 명령을 그대로 실행해 보여 준다(main 을 넘겨 순환 import 를 피한다)
    return await runDemo({ ctx, t, lang, keep: values.keep === true, run: main });
  } catch (err) {
    return reportError(err, ctx, printer, t);
  }
}

function reportError(err: unknown, ctx: CliContext, printer: Printer, t: Translate): number {
  if (ctx.signal?.aborted || isAbortError(err)) {
    printer.error(t('interrupted'));
    return EXIT.interrupted;
  }
  if (err instanceof AppError) {
    printer.error(t('error_line', { message: t(err.key, err.vars) }));
    if (err instanceof UsageError) printer.error(t('hint_help'));
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  printer.error(t('error_line', { message: t('err_unexpected', { message }) }));
  return EXIT.usage;
}

type Values = Record<string, string | boolean | undefined>;

async function runPull(args: string[], values: Values, ctx: CliContext, t: Translate): Promise<number> {
  if (args.length !== 1) throw new UsageError('err_pull_needs_ref');
  const ref: ModelRef = parseRef(args[0]);

  const rateText = values['limit-rate'] as string | undefined;
  const rateLimit = rateText === undefined ? 0 : parseRate(rateText);
  if (rateLimit === null) throw new UsageError('err_bad_rate', { value: rateText ?? '' });
  const connections = parseIntOption('connections', values.connections as string | undefined, 2, 1, 16);
  const retries = parseIntOption('retries', values.retries as string | undefined, 6, 0, 100);
  const registry = values.registry as string | undefined;
  if (registry !== undefined && !/^https?:\/\/[^/\s]+/.test(registry)) {
    throw new UsageError('err_bad_registry', { value: registry });
  }
  const modelsDir = resolveModelsDir(values['models-dir'] as string | undefined, ctx.env);
  const quiet = values.quiet === true;
  const printer = new Printer(ctx, quiet);

  const where = registryBase(ref, registry);

  // 함정: Node 의 fetch 는 HTTPS_PROXY 를 기본으로 무시한다(내 컴퓨터 주소로 갈 때는 상관없다)
  const proxy = ctx.env.HTTPS_PROXY || ctx.env.https_proxy;
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(where);
  if (proxy && !ctx.env.NODE_USE_ENV_PROXY && !loopback) printer.error(t('proxy_hint'));

  if (values['dry-run']) {
    // 매니페스트만 받아 표를 보여 주고 끝낸다. 폴더를 만들지도 않는다.
    const { manifest } = await fetchManifest(ref, { registry, signal: ctx.signal });
    const rows = await planBlobs(modelsDir, allBlobs(manifest));
    ctx.stdout(t('plan_title', { ref: refToString(ref), registry: where, modelsDir }) + '\n');
    for (const line of renderPlan(rows, rateLimit, t)) ctx.stdout(line + '\n');
    return EXIT.ok;
  }

  printer.line(t('pull_start', { ref: refToString(ref), registry: where }));
  printer.line(
    t('pull_settings', {
      rate: rateLimit ? formatRate(rateLimit) : t('rate_unlimited'),
      connections,
      modelsDir,
    }),
  );
  const reporter = createPullReporter(t, printer);
  let result;
  try {
    result = await pullModel({
      ref,
      modelsDir,
      registry,
      rateLimit,
      connections,
      retries,
      signal: ctx.signal,
      sleep: ctx.sleep ?? defaultSleep,
      retryDelayMs: ctx.retryDelayMs,
      onEvent: reporter.onEvent,
    });
  } finally {
    reporter.stop();
  }

  const seconds = result.elapsedMs / 1000;
  if (result.downloaded.length === 0) {
    printer.always(t('pull_nothing', { ref: refShort(ref) }));
  } else {
    printer.always(
      t('pull_done', {
        ref: refShort(ref),
        count: result.downloaded.length,
        bytes: formatBytes(result.transferred),
        time: formatElapsed(seconds),
        rate: formatRate(seconds > 0 ? result.transferred / seconds : result.transferred),
      }),
    );
  }
  return EXIT.ok;
}

async function runMerge(args: string[], values: Values, ctx: CliContext, t: Translate): Promise<number> {
  if (args.length !== 1) throw new UsageError('err_merge_needs_shard');
  const printer = new Printer(ctx, values.quiet === true);
  const registerName = values.register as string | undefined;
  const ref = registerName !== undefined ? parseRef(registerName) : undefined;
  const started = performance.now();

  // 1) 샤드 찾기·검사(아직 아무것도 쓰지 않는다 — 실패하면 출력 파일이 남지 않는다)
  const plan = await planMerge(args[0]);
  let output = values.output as string | undefined;
  if (output === undefined && ref === undefined) {
    if (!plan.defaultOutput) throw new UsageError('err_merge_needs_output');
    output = plan.defaultOutput;
  }
  printer.line(t('merge_found', { count: plan.shards.length, files: plan.shards.map((s) => basename(s)).join(', ') }));
  printer.line(
    t('merge_checked', {
      tensors: plan.tensors.length,
      kv: plan.kv.length,
      removed: plan.removedKeys.length ? plan.removedKeys.join(', ') : '-',
    }),
  );

  // 2) 병합(+ 등록)
  const onProgress = (written: number) =>
    printer.progress(`${formatBytes(written)} / ${formatBytes(plan.totalSize)} (${Math.floor((written / plan.totalSize) * 100)}%)`);
  let sha: string;
  let size: number;
  let manifestFile: string | undefined;
  try {
    if (ref) {
      const res = await mergeAndRegister(plan, { ref, modelsDir: resolveModelsDir(values['models-dir'] as string | undefined, ctx.env), output, signal: ctx.signal, onProgress });
      sha = res.modelDigest.slice('sha256:'.length);
      size = res.modelSize;
      manifestFile = res.manifestPath;
    } else {
      const res = await mergeToFile(plan, output as string, { signal: ctx.signal, onProgress });
      sha = res.sha256;
      size = res.size;
    }
  } finally {
    printer.clearProgress();
  }

  const time = formatElapsed((performance.now() - started) / 1000);
  const shown = output ?? `blobs/sha256-${sha.slice(0, 12)}…`;
  if (plan.shards.length > 1) {
    printer.always(t('merge_done', { count: plan.shards.length, out: shown, size: formatBytes(size), time }));
  } else {
    printer.always(t('merge_done_single', { out: shown, size: formatBytes(size), time }));
  }
  printer.line(t('merge_sha', { sha }));
  if (ref && manifestFile) {
    printer.always(t('register_done', { name: refShort(ref), path: manifestFile }));
    printer.line(t('register_hint', { name: refShort(ref) }));
  }
  return EXIT.ok;
}

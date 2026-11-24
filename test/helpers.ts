// 테스트 공용 도구: 임시 폴더, main() 출력 잡기, 가짜 시계, 파일 해시
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliContext } from '../src/main.js';
import type { Clock } from '../src/ratelimit.js';

/** 레포 루트(dist/test/helpers.js 기준 두 단계 위) */
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const cliPath = join(repoRoot, 'dist', 'src', 'cli.js');

const made: string[] = [];

export async function tempDir(prefix = 'ollama-fetch-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  while (made.length > 0) await rm(made.pop() as string, { recursive: true, force: true });
}

/** 시스템 언어 설정에 흔들리지 않도록 기본 환경은 영어 */
export function captureCtx(env: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8' }, extra: Partial<CliContext> = {}) {
  let out = '';
  let err = '';
  const ctx: CliContext = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    isTTY: false,
    env,
    // 재시도 대기를 없앤다(테스트 시간 단축). 대기 횟수는 이벤트로 확인한다.
    sleep: async () => undefined,
    ...extra,
  };
  return { ctx, out: () => out, err: () => err };
}

/** 가짜 시계: sleep 하면 시간이 그만큼 즉시 흐른다 */
export class FakeClock implements Clock {
  t = 0;
  sleeps = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps += 1;
    this.t += ms;
  }
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256OfFile(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

/** 폴더 안 모든 파일의 상대 경로(정렬). 없으면 빈 목록 */
export async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      out.push(relative(dir, p) + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  return out.sort();
}

/** 결정적 의사 난수 바이트(블롭 내용용) */
export function pseudoRandomBytes(size: number, seed: number): Buffer {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

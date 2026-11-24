// Ollama 로컬 저장소($OLLAMA_MODELS) 다루기: blobs/sha256-<hex>, manifests/<host>/<ns>/<repo>/<tag>
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { InputError } from './errors.js';

export const PARTIAL_SUFFIX = '.ollama-fetch.partial';
const DIGEST = /^sha256:([0-9a-f]{64})$/;

/** --models-dir > OLLAMA_MODELS > ~/.ollama/models */
export function resolveModelsDir(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag) return flag;
  if (env.OLLAMA_MODELS && env.OLLAMA_MODELS.trim() !== '') return env.OLLAMA_MODELS;
  return join(homedir(), '.ollama', 'models');
}

/** "sha256:<hex>" 를 검사해 hex 만 돌려준다. 파일 이름으로 쓰이므로 반드시 검사한다 */
export function digestHex(digest: string): string {
  const m = DIGEST.exec(digest);
  if (!m) throw new InputError('err_bad_digest', { digest });
  return m[1];
}

/** 블롭 파일 경로: 콜론 대신 하이픈 */
export function blobPath(modelsDir: string, digest: string): string {
  return join(modelsDir, 'blobs', `sha256-${digestHex(digest)}`);
}

export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 최종 블롭이 이미 있고 크기·해시가 맞으면 true(다시 받지 않는다) */
export async function hasVerifiedBlob(modelsDir: string, digest: string, size: number): Promise<boolean> {
  const path = blobPath(modelsDir, digest);
  if ((await fileSize(path)) !== size) return false;
  return (await sha256File(path)) === digestHex(digest);
}

/** 쓰기 권한 문제는 경로를 알려 주는 입력 오류(종료 코드 2)로 바꾼다 */
export function wrapFsError(err: unknown, path: string): unknown {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new InputError('err_not_writable', { path });
  }
  return err;
}

export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (err) {
    throw wrapFsError(err, path);
  }
}

/** 같은 폴더(같은 볼륨)의 임시 이름 */
export function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/** 임시 파일에 쓰고 rename — 중간에 멈춰도 반쪽 파일이 보이지 않는다 */
export async function writeFileAtomic(path: string, data: Buffer | string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = tempPathFor(path);
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw wrapFsError(err, path);
  }
}

/** 내용 주소 블롭 하나를 원자적으로 넣는다(config 블롭처럼 작은 것용). 다이제스트를 돌려준다 */
export async function putSmallBlob(modelsDir: string, data: Buffer): Promise<{ digest: string; size: number }> {
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  await writeFileAtomic(blobPath(modelsDir, digest), data);
  return { digest, size: data.length };
}

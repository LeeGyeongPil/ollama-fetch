// 블롭 하나 받기: partial 크기 → Range 요청 → (206 이어붙이기 | 200 처음부터) → 토큰 버킷 → 파일·해시
// → 길이 확인 → SHA-256 검증 → 같은 폴더에서 rename. 끊기면 지수 대기 후 원래 URL 부터 다시.
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { AppError, IntegrityError, NetworkError } from './errors.js';
import type { TokenBucket } from './ratelimit.js';
import { describeNetError, type FetchLike, fetchFollowingRedirects } from './registry.js';
import { digestHex, fileSize, PARTIAL_SUFFIX, wrapFsError } from './store.js';

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** 기본 sleep: 신호가 오면 타이머를 지우고 바로 깨어난다(Ctrl+C 때 프로세스가 기다리지 않게) */
export const defaultSleep: Sleep = async (ms, signal) => {
  await sleepTimer(ms, undefined, { signal });
};

/** Ollama 본체와 같은 지수 대기: 1s, 2s, 4s … 최대 30s */
export function defaultRetryDelayMs(failure: number): number {
  return Math.min(2 ** (failure - 1), 30) * 1000;
}

export type DownloadEvent =
  | { type: 'redirect'; digest: string; location: string }
  | { type: 'resume'; digest: string; at: number; size: number }
  | { type: 'range-ignored'; digest: string; status: number; had: number }
  | { type: 'progress'; digest: string; bytes: number }
  | { type: 'drop'; digest: string; at: number; size: number; reason: string; failure: number; retries: number; delayMs: number }
  | { type: 'verify-fail'; digest: string; actual: string; failure: number; retries: number }
  | { type: 'verify-ok'; digest: string };

export interface DownloadOptions {
  /** 원래 블롭 URL(레지스트리). 재시도마다 여기서 다시 시작한다 */
  url: string;
  /** 최종 블롭 경로(blobs/sha256-<hex>) */
  dest: string;
  digest: string;
  size: number;
  bucket: TokenBucket;
  retries: number;
  retryDelayMs?: (failure: number) => number;
  sleep?: Sleep;
  signal?: AbortSignal;
  /** 데이터가 이 시간 동안 하나도 오지 않으면 끊고 재시도(버킷 대기 시간은 세지 않는다) */
  stallTimeoutMs?: number;
  fetchImpl?: FetchLike;
  onEvent?: (event: DownloadEvent) => void;
}

export interface DownloadResult {
  /** 실제로 네트워크로 받은 바이트(이어받기로 아낀 바이트 제외) */
  transferred: number;
  attempts: number;
}

/** 재시도해도 소용없는 HTTP 오류(404 등) */
class FatalHttpError extends NetworkError {}

/** 이번 시도는 실패했지만 다시 해 볼 만한 오류 */
class RetryableError extends Error {}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

async function hashPrefix(path: string, length: number, hash: Hash): Promise<void> {
  if (length <= 0) return;
  for await (const chunk of createReadStream(path, { start: 0, end: length - 1 })) hash.update(chunk as Buffer);
}

export async function downloadBlob(options: DownloadOptions): Promise<DownloadResult> {
  const { url, dest, digest, size, bucket } = options;
  const expected = digestHex(digest);
  const partial = dest + PARTIAL_SUFFIX;
  const sleep = options.sleep ?? defaultSleep;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const emit = options.onEvent ?? (() => undefined);
  const stallTimeoutMs = options.stallTimeoutMs ?? 30_000;

  let networkFailures = 0; // 진전 없이 연속으로 끊긴 횟수
  let integrityFailures = 0; // 다 받았는데 해시가 틀린 횟수
  let attempts = 0;
  let transferred = 0;

  // 한 번의 HTTP 시도. 끝까지 받으면 전체 파일의 sha256 hex 를 돌려준다.
  const attempt = async (have: number): Promise<string> => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      stallTimer = setTimeout(() => controller.abort(new RetryableError(`no data for ${stallTimeoutMs} ms`)), stallTimeoutMs);
    };
    const disarmStall = () => clearTimeout(stallTimer);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
      armStall();
      const res = await fetchFollowingRedirects(
        url,
        { headers, signal: controller.signal },
        { fetchImpl: options.fetchImpl, onRedirect: (location) => emit({ type: 'redirect', digest, location }) },
      );
      disarmStall();

      if (res.status === 416) {
        // 서버가 우리 partial 보다 짧다고 한다 → 버리고 처음부터
        await res.body?.cancel();
        await rm(partial, { force: true });
        throw new RetryableError('HTTP 416');
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        if (isRetryableStatus(res.status)) throw new RetryableError(`HTTP ${res.status}`);
        throw new FatalHttpError('err_http', { url, status: res.status });
      }

      let start = 0;
      if (res.status === 206) {
        // Content-Range: bytes <start>-<end>/<total> 의 시작점이 우리가 가진 크기와 같아야 이어 붙인다
        const m = /bytes\s+(\d+)-/.exec(res.headers.get('content-range') ?? '');
        const from = m ? Number(m[1]) : -1;
        if (from !== have) {
          await res.body.cancel();
          await rm(partial, { force: true });
          throw new RetryableError(`unexpected Content-Range start ${from}`);
        }
        start = have;
        if (have > 0) emit({ type: 'resume', digest, at: have, size });
      } else if (have > 0) {
        // 함정: 서버가 Range 를 무시하고 200(전체)을 줬다 → 이어 붙이면 파일이 깨진다. 처음부터 쓴다.
        emit({ type: 'range-ignored', digest, status: res.status, had: have });
      }

      const hash = createHash('sha256');
      await hashPrefix(partial, start, hash); // 이어받기면 이미 받은 앞부분부터 해시에 넣는다
      try {
        file = await open(partial, start > 0 ? 'a' : 'w');
      } catch (err) {
        await res.body.cancel().catch(() => undefined); // 소켓을 GC 까지 붙들고 있지 않게
        throw wrapFsError(err, partial);
      }

      let written = start;
      reader = res.body.getReader();
      for (;;) {
        armStall();
        const { done, value } = await reader.read();
        disarmStall();
        if (done) break;
        // 서버가 매니페스트에 적힌 크기보다 많이 보내면 디스크에 쓰기 전에 끊고 partial 을 버린다
        if (written + value.length > size) {
          await reader.cancel().catch(() => undefined);
          reader = undefined;
          await rm(partial, { force: true });
          throw new RetryableError(`server sent more than the declared ${size} bytes`);
        }
        // 핵심: 디스크에 쓰기 전에 공용 버킷에서 토큰을 꺼낸다. 기다리는 동안 소켓은 읽히지 않아 TCP 가 속도를 늦춘다.
        await bucket.take(value.length);
        await file.write(value);
        hash.update(value);
        written += value.length;
        transferred += value.length;
        emit({ type: 'progress', digest, bytes: value.length });
      }
      reader = undefined;
      if (written < size) throw new RetryableError(`connection closed early at ${written} of ${size} bytes`);
      return hash.digest('hex');
    } catch (err) {
      // 우리 stall 타이머가 끊은 경우 → 재시도 가능한 오류로 바꾼다
      if (controller.signal.aborted && controller.signal.reason instanceof RetryableError && !options.signal?.aborted) {
        throw controller.signal.reason;
      }
      throw err;
    } finally {
      disarmStall();
      options.signal?.removeEventListener('abort', onAbort);
      if (reader) await reader.cancel().catch(() => undefined); // 소켓을 놓아 준다
      if (file) await file.close();
    }
  };

  for (;;) {
    options.signal?.throwIfAborted();
    attempts += 1;
    let have = (await fileSize(partial)) ?? 0;
    if (have > size) {
      await rm(partial, { force: true });
      have = 0;
    }

    let actual: string;
    try {
      if (have === size && size > 0) {
        // 지난번에 끝까지 받아 두고 검증 전에 멈춘 경우
        const hash = createHash('sha256');
        await hashPrefix(partial, have, hash);
        actual = hash.digest('hex');
      } else {
        actual = await attempt(have);
      }
    } catch (err) {
      if (options.signal?.aborted) throw err; // Ctrl+C: partial 은 남겨 다음 실행에서 이어받는다
      if (err instanceof FatalHttpError || (err instanceof AppError && !(err instanceof NetworkError))) throw err;
      const now = (await fileSize(partial)) ?? 0;
      // 이번 시도에서 조금이라도 진전이 있었으면 연속 실패 수를 처음부터 센다
      networkFailures = now > have ? 1 : networkFailures + 1;
      const reason = describeNetError(err);
      if (networkFailures > options.retries) {
        throw new NetworkError('err_retries_exhausted', { digest: digest.slice(0, 19), reason });
      }
      const delayMs = retryDelayMs(networkFailures);
      emit({ type: 'drop', digest, at: now, size, reason, failure: networkFailures, retries: options.retries, delayMs });
      await sleep(delayMs, options.signal);
      continue;
    }

    if (actual === expected) {
      try {
        await rename(partial, dest); // 같은 폴더라 원자적
      } catch (err) {
        throw wrapFsError(err, dest);
      }
      emit({ type: 'verify-ok', digest });
      return { transferred, attempts };
    }

    // 다 받았는데 해시가 다르다 → 버리고 처음부터. 재시도를 다 쓰면 무결성 오류(종료 코드 3)
    await rm(partial, { force: true });
    integrityFailures += 1;
    emit({ type: 'verify-fail', digest, actual, failure: integrityFailures, retries: options.retries });
    if (integrityFailures > options.retries) {
      throw new IntegrityError('err_digest_mismatch', { digest, actual: `sha256:${actual}` });
    }
    await sleep(retryDelayMs(integrityFailures), options.signal);
  }
}

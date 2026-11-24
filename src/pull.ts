// pull 전체 흐름: 매니페스트 → 이미 있는 블롭 건너뛰기 → 남은 블롭을 연결 N개로 받기(공용 버킷)
// → 블롭이 전부 확정된 뒤에만 매니페스트를 원자적으로 쓴다(그래야 ollama list 에 깨진 모델이 안 보인다).
import { blobPath, ensureDir, hasVerifiedBlob, writeFileAtomic } from './store.js';
import { type DownloadEvent, downloadBlob, type Sleep } from './download.js';
import { type Clock, realClock, TokenBucket } from './ratelimit.js';
import { blobUrl, type FetchedManifest, type FetchLike, fetchManifest, type Layer } from './registry.js';
import { type ModelRef, manifestPath } from './ref.js';
import { join } from 'node:path';

export type PullEvent =
  | DownloadEvent
  | { type: 'manifest'; layers: number; totalBytes: number }
  | { type: 'blob-skip'; digest: string; size: number; mediaType: string }
  | { type: 'blob-start'; digest: string; size: number; mediaType: string }
  | { type: 'blob-done'; digest: string; size: number; mediaType: string; elapsedMs: number; transferred: number }
  | { type: 'manifest-written'; path: string };

export interface PullOptions {
  ref: ModelRef;
  modelsDir: string;
  /** --registry: 미러·테스트용 주소. 저장 경로의 호스트는 ref.host 그대로 */
  registry?: string;
  /** bytes/s, 0 이면 무제한 */
  rateLimit: number;
  connections: number;
  retries: number;
  signal?: AbortSignal;
  sleep?: Sleep;
  retryDelayMs?: (failure: number) => number;
  clock?: Clock;
  stallTimeoutMs?: number;
  fetchImpl?: FetchLike;
  onEvent?: (event: PullEvent) => void;
}

export interface PullResult {
  manifestPath: string;
  layers: Layer[];
  downloaded: Layer[];
  skipped: Layer[];
  transferred: number;
  elapsedMs: number;
}

/** 매니페스트의 config + layers 를 한 목록으로(같은 다이제스트는 한 번만) */
export function allBlobs(manifest: FetchedManifest['manifest']): Layer[] {
  const seen = new Set<string>();
  return [manifest.config, ...manifest.layers].filter((l) => !seen.has(l.digest) && seen.add(l.digest));
}

export async function pullModel(options: PullOptions): Promise<PullResult> {
  const clock = options.clock ?? realClock;
  const emit = options.onEvent ?? (() => undefined);
  const started = clock.now();

  const fetched = await fetchManifest(options.ref, {
    registry: options.registry,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  });
  const blobs = allBlobs(fetched.manifest);
  emit({ type: 'manifest', layers: blobs.length, totalBytes: blobs.reduce((s, l) => s + l.size, 0) });

  // 1) 이미 있고 해시가 맞는 블롭은 건너뛴다 → 다시 실행하면 블롭 요청 0회
  const todo: Layer[] = [];
  const skipped: Layer[] = [];
  for (const layer of blobs) {
    if (await hasVerifiedBlob(options.modelsDir, layer.digest, layer.size)) {
      skipped.push(layer);
      emit({ type: 'blob-skip', digest: layer.digest, size: layer.size, mediaType: layer.mediaType });
    } else {
      todo.push(layer);
    }
  }

  // 2) 남은 블롭을 연결 N개가 줄에서 하나씩 가져가 받는다. 버킷은 모두가 함께 쓴다.
  const bucket = new TokenBucket(options.rateLimit, { clock });
  if (todo.length > 0) await ensureDir(join(options.modelsDir, 'blobs'));
  const queue = [...todo];
  let transferred = 0;
  let firstError: unknown;
  const failFast = new AbortController(); // 한 연결이 치명적으로 실패하면 나머지도 멈춘다
  const onOuterAbort = () => failFast.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const worker = async () => {
    while (queue.length > 0 && !failFast.signal.aborted) {
      const layer = queue.shift() as Layer;
      const t0 = clock.now();
      emit({ type: 'blob-start', digest: layer.digest, size: layer.size, mediaType: layer.mediaType });
      try {
        const result = await downloadBlob({
          url: blobUrl(options.ref, layer.digest, options.registry),
          dest: blobPath(options.modelsDir, layer.digest),
          digest: layer.digest,
          size: layer.size,
          bucket,
          retries: options.retries,
          retryDelayMs: options.retryDelayMs,
          sleep: options.sleep,
          signal: failFast.signal,
          stallTimeoutMs: options.stallTimeoutMs,
          fetchImpl: options.fetchImpl,
          onEvent: emit,
        });
        transferred += result.transferred;
        emit({
          type: 'blob-done',
          digest: layer.digest,
          size: layer.size,
          mediaType: layer.mediaType,
          elapsedMs: clock.now() - t0,
          transferred: result.transferred,
        });
      } catch (err) {
        if (firstError === undefined) firstError = err;
        failFast.abort(err);
      }
    }
  };

  try {
    const workers = Math.max(1, Math.min(options.connections, todo.length || 1));
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
  if (firstError !== undefined) throw options.signal?.aborted ? options.signal.reason : firstError;

  // 3) 블롭이 전부 확정된 뒤에만 매니페스트를 원문 그대로 쓴다
  const path = manifestPath(options.modelsDir, options.ref);
  await writeFileAtomic(path, fetched.raw);
  emit({ type: 'manifest-written', path });

  return {
    manifestPath: path,
    layers: blobs,
    downloaded: todo,
    skipped,
    transferred,
    elapsedMs: clock.now() - started,
  };
}

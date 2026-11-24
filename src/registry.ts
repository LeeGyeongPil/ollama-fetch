// Ollama 레지스트리(OCI distribution 의 부분 집합) 클라이언트: 매니페스트 GET, 블롭 URL, 리다이렉트
import { InputError, NetworkError } from './errors.js';
import { type ModelRef, refToString, registryBase } from './ref.js';
import { digestHex } from './store.js';

export const MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
export const CONFIG_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
export const MODEL_MEDIA_TYPE = 'application/vnd.ollama.image.model';

export interface Layer {
  mediaType: string;
  digest: string;
  size: number;
}

export interface Manifest {
  schemaVersion: number;
  mediaType?: string;
  config: Layer;
  layers: Layer[];
}

export interface FetchedManifest {
  manifest: Manifest;
  /** 레지스트리가 준 원문 바이트 — 로컬에도 이 바이트 그대로 쓴다 */
  raw: Buffer;
}

export type FetchLike = typeof fetch;

function checkLayer(value: unknown, ref: string): Layer {
  const layer = value as Partial<Layer> | null;
  if (
    !layer ||
    typeof layer.mediaType !== 'string' ||
    typeof layer.digest !== 'string' ||
    typeof layer.size !== 'number' ||
    !Number.isSafeInteger(layer.size) ||
    layer.size < 0
  ) {
    throw new InputError('err_bad_manifest', { ref });
  }
  digestHex(layer.digest); // sha256:<64 hex> 가 아니면 오류(파일 이름으로 쓰이므로)
  return { mediaType: layer.mediaType, digest: layer.digest, size: layer.size };
}

/** 매니페스트 JSON 검사: config 1개 + layers[] */
export function parseManifest(raw: Buffer, ref: string): Manifest {
  let data: Partial<Manifest>;
  try {
    data = JSON.parse(raw.toString('utf8')) as Partial<Manifest>;
  } catch {
    throw new InputError('err_bad_manifest', { ref });
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.layers)) {
    throw new InputError('err_bad_manifest', { ref });
  }
  return {
    schemaVersion: Number(data.schemaVersion ?? 2),
    mediaType: data.mediaType,
    config: checkLayer(data.config, ref),
    layers: data.layers.map((l) => checkLayer(l, ref)),
  };
}

export function manifestUrl(ref: ModelRef, override?: string): string {
  return `${registryBase(ref, override)}/v2/${ref.namespace}/${ref.repo}/manifests/${ref.tag}`;
}

export function blobUrl(ref: ModelRef, digest: string, override?: string): string {
  return `${registryBase(ref, override)}/v2/${ref.namespace}/${ref.repo}/blobs/${digest}`;
}

/** 네트워크 계층 오류(연결 거부·DNS 등)를 사람이 읽을 이유 문자열로 */
export function describeNetError(err: unknown): string {
  const e = err as { cause?: { code?: string; message?: string }; code?: string; message?: string };
  return e?.cause?.code ?? e?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

export async function fetchManifest(
  ref: ModelRef,
  options: { registry?: string; fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<FetchedManifest> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = manifestUrl(ref, options.registry);
  const name = refToString(ref);
  let res: Response;
  try {
    res = await doFetch(url, { headers: { Accept: MANIFEST_MEDIA_TYPE }, signal: options.signal });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new NetworkError('err_network', { url, reason: describeNetError(err) });
  }
  if (res.status === 404) {
    await res.body?.cancel();
    throw new NetworkError('err_manifest_404', { ref: name });
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new NetworkError('err_http', { url, status: res.status });
  }
  const raw = Buffer.from(await res.arrayBuffer());
  return { manifest: parseManifest(raw, name), raw };
}

/**
 * 리다이렉트를 직접 따라간다(실제 레지스트리는 블롭 요청을 CDN 으로 307 보낸다).
 * 재시도할 때마다 원래 URL 부터 다시 시작하므로, 만료된 CDN 서명 URL 을 재사용하지 않는다.
 */
export async function fetchFollowingRedirects(
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
  options: { fetchImpl?: FetchLike; onRedirect?: (location: string) => void; maxRedirects?: number } = {},
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  let current = url;
  for (let hop = 0; hop <= (options.maxRedirects ?? 10); hop++) {
    const res = await doFetch(current, { headers: init.headers, signal: init.signal, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current).toString();
      options.onRedirect?.(current);
      continue;
    }
    return res;
  }
  throw new NetworkError('err_too_many_redirects', { url });
}

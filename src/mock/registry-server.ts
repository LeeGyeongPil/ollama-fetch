// 연습용 모의(mock) Ollama 레지스트리.
// 실제 레지스트리처럼 매니페스트를 주고, 블롭 요청은 "CDN" 주소로 307 리다이렉트하며, Range(206/416)를 지원한다.
// 장애 주입: n% 지점에서 연결 끊기, n% 지점에서 멈추기, Range 무시하고 200, 항상 손상된 바이트, 크기 초과, 404.
//
// 요청 처리기는 하나(handle: Request → Response)이고, 두 가지 전송으로 쓴다.
//   - createMockRegistry(): 메모리 안 fetch. 소켓·포트 없이 같은 응답을 돌려준다(단위 테스트).
//   - startMockRegistry():  같은 처리기를 127.0.0.1 의 node:http 서버로 띄운다(데모·실소켓 테스트).
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONFIG_MEDIA_TYPE, type FetchLike, MANIFEST_MEDIA_TYPE, MODEL_MEDIA_TYPE } from '../registry.js';

export interface MockLayer {
  mediaType: string;
  data: Buffer;
}

export interface MockModel {
  namespace: string;
  repo: string;
  tag: string;
  layers: MockLayer[];
  /** 없으면 Ollama 와 같은 모양의 config JSON 을 만든다 */
  config?: Buffer;
}

export interface MockFaults {
  /** 이 다이제스트의 본문을 fraction(0~1) 지점까지만 보내고 연결을 끊는다. times 번까지 */
  drop?: { digest: string; fraction: number; times: number };
  /** drop 과 같은 지점까지 보낸 뒤 연결을 닫지 않고 멈춘다(정체 감지 확인용) */
  hang?: { digest: string; fraction: number; times: number };
  /** true 면 Range 헤더를 무시하고 항상 200 으로 전체를 준다 */
  ignoreRange?: boolean;
  /** 이 다이제스트는 항상 바이트 하나가 뒤집힌 내용을 준다 */
  corrupt?: string;
  /** 이 다이제스트는 선언된 크기보다 바이트를 더 붙여서 준다(잘못된 미러) */
  oversize?: string;
  /** 매니페스트를 404 로 */
  missingManifest?: boolean;
}

export interface MockRequest {
  method: string;
  path: string;
  range?: string;
  status: number;
  kind: 'manifest' | 'blob' | 'cdn' | 'other';
}

export interface MockOptions {
  models: MockModel[];
  faults?: MockFaults;
}

export interface MockHandler {
  /** 요청 하나를 처리한다(전송과 무관) */
  handle(request: Request): Promise<Response>;
  /** 받은 요청 기록(테스트가 Range 헤더·요청 수를 단언한다) */
  requests: MockRequest[];
  /** 매니페스트 원문(키: ns/repo:tag) */
  manifests: Map<string, Buffer>;
  /** 실행 중에 장애 설정 바꾸기 */
  faults: MockFaults;
  blobRequests(): number;
}

/** 메모리 전송 모의 레지스트리: url 은 이름일 뿐이고 실제로 접속하지 않는다 */
export interface MemoryMockRegistry extends MockHandler {
  url: string;
  /** pull 의 fetchImpl 자리에 그대로 꽂는 fetch */
  fetch: FetchLike;
}

/** HTTP 전송 모의 레지스트리(127.0.0.1) */
export interface MockRegistry extends MockHandler {
  url: string;
  close(): Promise<void>;
}

/** 메모리 모의 레지스트리의 주소. `.invalid` 는 어떤 DNS 에서도 풀리지 않는 예약 이름이다(RFC 2606) */
export const MEMORY_REGISTRY_URL = 'http://mock-registry.invalid';

/** 본문을 이 크기 덩어리로 나눠 준다(undici 가 실제로 주는 덩어리 크기 정도) */
const CHUNK = 64 * 1024;

export function sha256Digest(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** 레이어만 주면 config JSON 과 매니페스트 원문을 만든다 */
export function buildMockManifest(model: MockModel): { raw: Buffer; blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  const layers = model.layers.map((l) => {
    const digest = sha256Digest(l.data);
    blobs.set(digest, l.data);
    return { mediaType: l.mediaType, digest, size: l.data.length };
  });
  const config =
    model.config ??
    Buffer.from(
      JSON.stringify({
        model_format: 'gguf',
        model_family: 'llama',
        model_families: ['llama'],
        model_type: '40K',
        file_type: 'F32',
        architecture: 'amd64',
        os: 'linux',
        rootfs: { type: 'layers', diff_ids: layers.map((l) => l.digest) },
      }),
    );
  const configDigest = sha256Digest(config);
  blobs.set(configDigest, config);
  const manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: { mediaType: CONFIG_MEDIA_TYPE, digest: configDigest, size: config.length },
    layers,
  };
  return { raw: Buffer.from(JSON.stringify(manifest)), blobs };
}

/** 데모·테스트용 기본 모델: 모델·템플릿·파라미터 레이어 */
export function tinyModelLayers(gguf: Buffer): MockLayer[] {
  return [
    { mediaType: MODEL_MEDIA_TYPE, data: gguf },
    { mediaType: 'application/vnd.ollama.image.template', data: Buffer.from('{{ .Prompt }}') },
    { mediaType: 'application/vnd.ollama.image.params', data: Buffer.from(JSON.stringify({ num_ctx: 256, stop: ['</s>'] })) },
  ];
}

/** 실제 fetch(undici)가 본문을 읽다 상대가 연결을 끊었을 때 내는 오류와 같은 모양 */
export function connectionTerminatedError(): TypeError {
  return new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
}

/**
 * 본문 스트림. 읽는 쪽이 요청할 때만(pull) 64 KiB 씩 내준다 — 그래서 끊는 지점이 바이트 단위로 정확하다.
 *  - end: 'close' 면 정상 종료, 'drop' 이면 마지막 바이트 뒤에 연결 끊김 오류, 'hang' 이면 더 보내지 않고 멈춘다.
 *  - signal 이 오면(클라이언트가 그만 읽음) 스트림을 그 이유로 끝낸다.
 */
function bodyStream(data: Buffer, end: 'close' | 'drop' | 'hang', signal: AbortSignal): ReadableStream<Uint8Array> {
  let offset = 0;
  let wakeHang: (() => void) | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const onAbort = () => {
    try {
      controllerRef?.error(signal.reason);
    } catch {
      // 이미 닫힌 스트림
    }
    wakeHang?.();
  };
  const finish = () => signal.removeEventListener('abort', onAbort);
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;
        if (signal.aborted) controller.error(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
      },
      pull(controller) {
        if (offset < data.length) {
          const next = Math.min(offset + CHUNK, data.length);
          controller.enqueue(new Uint8Array(data.subarray(offset, next)));
          offset = next;
          return undefined;
        }
        if (end === 'close') {
          finish();
          controller.close();
          return undefined;
        }
        if (end === 'drop') {
          finish();
          controller.error(connectionTerminatedError());
          return undefined;
        }
        // hang: 취소·중단될 때까지 다음 덩어리를 주지 않는다(타이머 없음)
        return new Promise<void>((resolve) => {
          wakeHang = resolve;
        });
      },
      cancel() {
        finish();
        wakeHang?.();
      },
    },
    { highWaterMark: 0 },
  );
}

/** 처리기 + 요청 기록. 전송(메모리·HTTP)과 무관하게 같은 응답을 만든다 */
export function createMockHandler(options: MockOptions): MockHandler {
  const manifests = new Map<string, Buffer>();
  const blobs = new Map<string, Buffer>();
  for (const model of options.models) {
    const built = buildMockManifest(model);
    manifests.set(`${model.namespace}/${model.repo}:${model.tag}`, built.raw);
    for (const [digest, data] of built.blobs) blobs.set(digest, data);
  }
  const requests: MockRequest[] = [];
  const faults: MockFaults = options.faults ?? {};
  const drops = new Map<string, number>();
  const hangs = new Map<string, number>();

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const range = request.headers.get('range') ?? undefined;
    const record = (status: number, kind: MockRequest['kind']) =>
      requests.push({ method: request.method, path: url.pathname, range, status, kind });
    let m: RegExpExecArray | null;

    // 1) 매니페스트
    if ((m = /^\/v2\/([^/]+)\/([^/]+)\/manifests\/([^/]+)$/.exec(url.pathname))) {
      const raw = manifests.get(`${m[1]}/${m[2]}:${m[3]}`);
      if (!raw || faults.missingManifest) {
        record(404, 'manifest');
        return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      record(200, 'manifest');
      return new Response(new Uint8Array(raw), {
        status: 200,
        headers: { 'Content-Type': MANIFEST_MEDIA_TYPE, 'Content-Length': String(raw.length) },
      });
    }

    // 2) 블롭 → 실제 레지스트리처럼 서명 붙은 CDN 주소로 307
    if ((m = /^\/v2\/[^/]+\/[^/]+\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname))) {
      if (!blobs.has(m[1])) {
        record(404, 'blob');
        return new Response(null, { status: 404 });
      }
      record(307, 'blob');
      return new Response(null, { status: 307, headers: { Location: `/cdn/${m[1]}?Expires=${Date.now() + 60_000}&Signature=mock` } });
    }

    // 3) "CDN": Range 지원 + 장애 주입
    if ((m = /^\/cdn\/(sha256:[0-9a-f]{64})$/.exec(url.pathname))) {
      const digest = m[1];
      let body = blobs.get(digest);
      if (!body) {
        record(404, 'cdn');
        return new Response(null, { status: 404 });
      }
      if (faults.corrupt === digest) {
        body = Buffer.from(body);
        body[Math.floor(body.length / 2)] ^= 0xff; // 가운데 바이트 하나를 뒤집는다
      }
      if (faults.oversize === digest) body = Buffer.concat([body, Buffer.alloc(4096, 0x61)]);
      const size = body.length;
      const rangeMatch = range ? /^bytes=(\d+)-$/.exec(range) : null;
      let start = 0;
      let status = 200;
      const headers: Record<string, string> = { 'Accept-Ranges': 'bytes' };
      if (rangeMatch && !faults.ignoreRange) {
        start = Number(rangeMatch[1]);
        if (start >= size) {
          record(416, 'cdn');
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${size - 1}/${size}`;
      }
      headers['Content-Length'] = String(size - start); // 끊기·멈춤 장애에서도 원래 길이를 약속한다(실제 서버처럼)
      record(status, 'cdn');

      // 끊기 장애: 전체의 floor(size × fraction) 바이트까지만 보내고 연결을 끊는다(Content-Length 보다 짧게 끝남)
      let stopAt = size;
      let end: 'close' | 'drop' | 'hang' = 'close';
      const drop = faults.drop;
      const dropAt = drop && drop.digest === digest ? Math.floor(size * drop.fraction) : -1;
      const hang = faults.hang;
      const hangAt = hang && hang.digest === digest ? Math.floor(size * hang.fraction) : -1;
      if (drop && dropAt > start && (drops.get(digest) ?? 0) < drop.times) {
        drops.set(digest, (drops.get(digest) ?? 0) + 1);
        stopAt = dropAt;
        end = 'drop';
      } else if (hang && hangAt > start && (hangs.get(digest) ?? 0) < hang.times) {
        // 정체 장애: fraction 지점까지 보내고 아무것도 더 보내지 않는다
        hangs.set(digest, (hangs.get(digest) ?? 0) + 1);
        stopAt = hangAt;
        end = 'hang';
      }
      return new Response(bodyStream(body.subarray(start, stopAt), end, request.signal), { status, headers });
    }

    record(404, 'other');
    return new Response(null, { status: 404 });
  };

  return {
    handle,
    requests,
    manifests,
    faults,
    blobRequests: () => requests.filter((r) => r.kind === 'blob' || r.kind === 'cdn').length,
  };
}

/**
 * 메모리 전송: 소켓·포트·DNS 없이 처리기를 바로 부르는 fetch.
 * 실제 fetch 와 같게: 이미 중단된 신호면 바로 실패하고, 본문을 읽는 중에 신호가 오면 그 이유로 스트림이 끝난다.
 */
export function createMockRegistry(options: MockOptions): MemoryMockRegistry {
  const handler = createMockHandler(options);
  const memoryFetch: FetchLike = async (input, init) => {
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    const request = new Request(new URL(url, MEMORY_REGISTRY_URL), {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      signal,
    });
    return handler.handle(request);
  };
  return { ...handler, url: MEMORY_REGISTRY_URL, fetch: memoryFetch };
}

/** node:http 요청 → 표준 Request. 클라이언트가 연결을 닫으면 request.signal 이 중단된다 */
function toRequest(req: IncomingMessage, res: ServerResponse): Request {
  const controller = new AbortController();
  res.on('close', () => controller.abort(new Error('client closed the connection')));
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  return new Request(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, signal: controller.signal });
}

/** 쓰기 버퍼가 비워지거나(drain) 연결이 닫힐(close) 때까지 기다린다 */
function drainOrClose(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** 표준 Response → node:http 응답. 본문 스트림이 오류로 끝나면(끊기 장애) 소켓을 닫는다 */
async function sendResponse(response: Response, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 소켓 버퍼가 차면 비워질 때까지 기다린다(그동안 스트림을 더 읽지 않는다). 기다림이 끝나면 두 리스너를 다 뗀다.
      if (!res.write(value)) await drainOrClose(res);
      if (res.destroyed) return;
    }
    res.end();
  } catch {
    if (res.destroyed) return; // 클라이언트가 먼저 닫았다
    // 끊기 장애: 보낸 바이트를 다 넘긴 뒤 FIN 으로 닫는다. destroy() 를 바로 쓰면 Linux 는 RST 를 보내
    // 상대가 아직 읽지 않은 바이트까지 버리게 할 수 있어, 끊긴 위치가 운영체제마다 달라진다.
    // 상대가 닫지 않으면 1초 뒤 강제로 닫는다(unref 라 프로세스 종료를 막지 않는다).
    const socket = req.socket;
    res.write(Buffer.alloc(0), () => {
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
    });
  } finally {
    reader.releaseLock();
  }
}

/** 같은 처리기를 127.0.0.1 의 진짜 HTTP 서버로 띄운다(데모·test/net) */
export async function startMockRegistry(options: MockOptions): Promise<MockRegistry> {
  const handler = createMockHandler(options);
  const server = createServer((req, res) => {
    handler
      .handle(toRequest(req, res))
      .then((response) => sendResponse(response, req, res))
      .catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    ...handler,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // 남은 keep-alive·멈춘 연결도 닫아 프로세스가 바로 끝나게 한다
      }),
  };
}

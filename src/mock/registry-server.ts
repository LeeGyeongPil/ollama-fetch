// 연습용 모의(mock) Ollama 레지스트리 — 진짜 HTTP 서버다(127.0.0.1 전용).
// 실제 레지스트리처럼 매니페스트를 주고, 블롭 요청은 "CDN" 주소로 307 리다이렉트하며, Range(206)를 지원한다.
// 장애 주입: n% 지점에서 연결 끊기, Range 무시하고 200, 항상 손상된 바이트, 404.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONFIG_MEDIA_TYPE, MANIFEST_MEDIA_TYPE, MODEL_MEDIA_TYPE } from '../registry.js';

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

export interface MockRegistry {
  url: string;
  /** 받은 요청 기록(테스트가 Range 헤더·요청 수를 단언한다) */
  requests: MockRequest[];
  /** 매니페스트 원문(키: ns/repo:tag) */
  manifests: Map<string, Buffer>;
  /** 실행 중에 장애 설정 바꾸기 */
  faults: MockFaults;
  blobRequests(): number;
  close(): Promise<void>;
}

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

export async function startMockRegistry(options: { models: MockModel[]; faults?: MockFaults }): Promise<MockRegistry> {
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

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const record = (status: number, kind: MockRequest['kind']) =>
      requests.push({ method: req.method ?? 'GET', path: url.pathname, range, status, kind });
    let m: RegExpExecArray | null;

    // 1) 매니페스트
    if ((m = /^\/v2\/([^/]+)\/([^/]+)\/manifests\/([^/]+)$/.exec(url.pathname))) {
      const raw = manifests.get(`${m[1]}/${m[2]}:${m[3]}`);
      if (!raw || faults.missingManifest) {
        record(404, 'manifest');
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}');
        return;
      }
      record(200, 'manifest');
      res.writeHead(200, { 'Content-Type': MANIFEST_MEDIA_TYPE, 'Content-Length': raw.length });
      res.end(raw);
      return;
    }

    // 2) 블롭 → 실제 레지스트리처럼 서명 붙은 CDN 주소로 307
    if ((m = /^\/v2\/[^/]+\/[^/]+\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname))) {
      if (!blobs.has(m[1])) {
        record(404, 'blob');
        res.writeHead(404);
        res.end();
        return;
      }
      record(307, 'blob');
      res.writeHead(307, { Location: `/cdn/${m[1]}?Expires=${Date.now() + 60_000}&Signature=mock` });
      res.end();
      return;
    }

    // 3) "CDN": Range 지원 + 장애 주입
    if ((m = /^\/cdn\/(sha256:[0-9a-f]{64})$/.exec(url.pathname))) {
      const digest = m[1];
      let body = blobs.get(digest);
      if (!body) {
        record(404, 'cdn');
        res.writeHead(404);
        res.end();
        return;
      }
      if (faults.corrupt === digest) {
        body = Buffer.from(body);
        body[Math.floor(body.length / 2)] ^= 0xff; // 가운데 바이트 하나를 뒤집는다
      }
      const size = body.length;
      const rangeMatch = range ? /^bytes=(\d+)-$/.exec(range) : null;
      let start = 0;
      if (rangeMatch && !faults.ignoreRange) {
        start = Number(rangeMatch[1]);
        if (start >= size) {
          record(416, 'cdn');
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        record(206, 'cdn');
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${size - 1}/${size}`,
          'Content-Length': size - start,
          'Accept-Ranges': 'bytes',
        });
      } else {
        record(200, 'cdn');
        res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      }

      // 끊기 장애: 전체의 fraction 지점까지만 보내고 소켓을 닫는다(Content-Length 보다 짧게 끝남)
      const drop = faults.drop;
      const dropAt = drop && drop.digest === digest ? Math.floor(size * drop.fraction) : -1;
      if (drop && dropAt > start && (drops.get(digest) ?? 0) < drop.times) {
        drops.set(digest, (drops.get(digest) ?? 0) + 1);
        res.write(body.subarray(start, dropAt), () => req.socket.destroy());
        return;
      }
      // 정체 장애: fraction 지점까지 보내고 아무것도 더 보내지 않는다(close() 때 정리된다)
      const hang = faults.hang;
      const hangAt = hang && hang.digest === digest ? Math.floor(size * hang.fraction) : -1;
      if (hang && hangAt > start && (hangs.get(digest) ?? 0) < hang.times) {
        hangs.set(digest, (hangs.get(digest) ?? 0) + 1);
        res.write(body.subarray(start, hangAt));
        return;
      }
      res.end(body.subarray(start));
      return;
    }

    record(404, 'other');
    res.writeHead(404);
    res.end();
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    manifests,
    faults,
    blobRequests: () => requests.filter((r) => r.kind === 'blob' || r.kind === 'cdn').length,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // 남은 keep-alive 연결도 닫아 프로세스가 바로 끝나게 한다
      }),
  };
}

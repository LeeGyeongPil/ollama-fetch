// 분할 GGUF(<name>-0000k-of-0000N.gguf) 스트리밍 병합 — llama-gguf-split --merge 와 같은 일을 빌드 없이.
//
// 1) 첫 샤드 이름에서 나머지 샤드 이름을 만들고 빠진 것이 없는지 본다
// 2) 각 샤드 헤더의 split.no / split.count / split.tensors.count 를 검사한다
// 3) 첫 샤드의 KV 에서 split.* 를 빼고, 텐서 오프셋을 general.alignment 배수로 다시 계산해 새 헤더를 만든다
// 4) 텐서 데이터를 4 MiB 버퍼로 차례로 복사하면서 sha256 을 같이 계산한다(병합본을 다시 읽지 않아도 된다)
import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { GgufFormatError, InputError, UsageError } from './errors.js';
import {
  alignUp,
  buildHeader,
  getKv,
  type GgufHeader,
  type GgufKv,
  type GgufTensorInfo,
  readGguf,
  tensorNbytes,
} from './gguf.js';
import { fileSize, tempPathFor, wrapFsError } from './store.js';

const SHARD_NAME = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const COPY_BUFFER = 4 * 1024 * 1024;

export interface CopyStep {
  shard: number;
  /** 원본 샤드 안의 절대 위치 */
  src: number;
  length: number;
  /** 병합본 데이터 영역 기준 위치 */
  dst: number;
}

export interface MergePlan {
  shards: string[];
  headers: GgufHeader[];
  /** 병합본 헤더 바이트(패딩 포함) */
  headerBytes: Buffer;
  kv: GgufKv[];
  tensors: GgufTensorInfo[];
  alignment: number;
  copies: CopyStep[];
  removedKeys: string[];
  /** 병합본 전체 크기 */
  totalSize: number;
  /** 이름에서 -0000k-of-0000N 을 뗀 기본 출력 이름 */
  defaultOutput: string;
}

/** 첫 샤드 경로 → 전체 샤드 경로 목록. 빠진 샤드가 있으면 이름을 모두 담아 입력 오류(종료 코드 2) */
export async function discoverShards(firstShard: string): Promise<{ shards: string[]; defaultOutput: string }> {
  const dir = dirname(firstShard);
  const m = SHARD_NAME.exec(basename(firstShard));
  if (!m) {
    if ((await fileSize(firstShard)) === null) throw new InputError('err_file_missing', { path: firstShard });
    return { shards: [firstShard], defaultOutput: '' };
  }
  const [, base, , countText] = m;
  const count = Number(countText);
  if (count < 1) throw new InputError('err_split_count', { file: basename(firstShard), expected: count, actual: 0 });
  const shards: string[] = [];
  const missing: string[] = [];
  for (let i = 1; i <= count; i++) {
    const name = `${base}-${String(i).padStart(5, '0')}-of-${countText}.gguf`;
    const path = join(dir, name);
    shards.push(path);
    if ((await fileSize(path)) === null) missing.push(name);
  }
  if (missing.length > 0) throw new InputError('err_shards_missing', { missing: missing.join(', '), count });
  return { shards, defaultOutput: join(dir, `${base}.gguf`) };
}

function numberKv(header: GgufHeader, key: string): number | undefined {
  const v = getKv(header, key);
  return typeof v === 'number' || typeof v === 'bigint' ? Number(v) : undefined;
}

/** 샤드 집합 검사와 병합본 배치 계산(아직 아무것도 쓰지 않는다) */
export async function planMerge(firstShard: string): Promise<MergePlan> {
  const { shards, defaultOutput } = await discoverShards(firstShard);
  const headers = shards.map((p) => readGguf(p));
  const n = shards.length;

  // split.* 키 검사: 모든 샤드의 split.count 가 같고 split.no 가 0..N-1 순서여야 한다
  headers.forEach((h, i) => {
    const count = numberKv(h, 'split.count');
    const no = numberKv(h, 'split.no');
    const file = basename(shards[i]);
    if (n === 1 && (count === undefined || count <= 1)) return; // 분할되지 않은 단일 GGUF
    if (count !== n) throw new InputError('err_split_count', { file, expected: n, actual: count ?? 'none' });
    if (no !== i) throw new InputError('err_split_no', { file, expected: i, actual: no ?? 'none' });
  });
  const first = headers[0];
  const tensorTotal = headers.reduce((s, h) => s + h.tensors.length, 0);
  const declared = numberKv(first, 'split.tensors.count');
  if (declared !== undefined && declared !== tensorTotal) {
    throw new InputError('err_split_tensors', { expected: declared, actual: tensorTotal });
  }

  // 병합본은 첫 샤드의 정렬을 따른다. 각 샤드를 읽을 때는 그 샤드 자신의 정렬로 데이터 시작을 구한다.
  const alignment = first.alignment;
  const kv = first.kv.filter((k) => !k.key.startsWith('split.'));
  const removedKeys = first.kv.filter((k) => k.key.startsWith('split.')).map((k) => k.key);

  const tensors: GgufTensorInfo[] = [];
  const copies: CopyStep[] = [];
  const names = new Set<string>();
  let cursor = 0;
  headers.forEach((h, s) => {
    const dataSize = h.fileSize - h.dataOffset;
    const byOffset = [...h.tensors].sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
    for (const t of h.tensors) {
      if (names.has(t.name)) throw new InputError('err_duplicate_tensor', { name: t.name });
      names.add(t.name);
      // 텐서 바이트 수: 타입·모양으로 계산, 모르는 타입이면 다음 텐서까지의 간격
      const next = byOffset.find((o) => o.offset > t.offset);
      const span = (next ? Number(next.offset) : dataSize) - Number(t.offset);
      const nbytes = tensorNbytes(t) ?? span;
      const src = h.dataOffset + Number(t.offset);
      if (nbytes < 0 || src + nbytes > h.fileSize) {
        throw new GgufFormatError('err_gguf_truncated', { path: shards[s], pos: src });
      }
      cursor = alignUp(cursor, alignment); // 오프셋 재계산: 모든 텐서를 정렬 배수에 둔다
      tensors.push({ ...t, offset: BigInt(cursor) });
      copies.push({ shard: s, src, length: nbytes, dst: cursor });
      cursor += nbytes;
    }
  });

  const headerBytes = buildHeader({ version: first.version, kv, tensors, alignment });
  const totalSize = headerBytes.length + alignUp(cursor, alignment);
  return { shards, headers, headerBytes, kv, tensors, alignment, copies, removedKeys, totalSize, defaultOutput };
}

/** 계획대로 path 에 병합본을 쓰면서 sha256 을 계산한다. 실패하면 path 를 지운다 */
export async function writeMerged(
  plan: MergePlan,
  path: string,
  options: { signal?: AbortSignal; onProgress?: (written: number) => void } = {},
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  const zeros = Buffer.alloc(Math.max(plan.alignment, 64));
  const buffer = Buffer.alloc(COPY_BUFFER);
  const inputs: Awaited<ReturnType<typeof open>>[] = [];
  let out: Awaited<ReturnType<typeof open>> | undefined;
  let pos = 0;

  const emitBytes = async (data: Buffer) => {
    hash.update(data);
    let off = 0;
    while (off < data.length) {
      const { bytesWritten } = await (out as Awaited<ReturnType<typeof open>>).write(data, off, data.length - off, pos);
      off += bytesWritten;
      pos += bytesWritten;
    }
    options.onProgress?.(pos);
  };
  const padTo = async (target: number) => {
    while (pos < target) await emitBytes(zeros.subarray(0, Math.min(zeros.length, target - pos)));
  };

  try {
    try {
      out = await open(path, 'w');
    } catch (err) {
      throw wrapFsError(err, path);
    }
    for (const shard of plan.shards) inputs.push(await open(shard, 'r'));

    await emitBytes(plan.headerBytes);
    const dataStart = plan.headerBytes.length;
    for (const step of plan.copies) {
      await padTo(dataStart + step.dst);
      let left = step.length;
      let src = step.src;
      while (left > 0) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await inputs[step.shard].read(buffer, 0, Math.min(buffer.length, left), src);
        if (bytesRead === 0) throw new GgufFormatError('err_gguf_truncated', { path: plan.shards[step.shard], pos: src });
        await emitBytes(buffer.subarray(0, bytesRead));
        left -= bytesRead;
        src += bytesRead;
      }
    }
    await padTo(plan.totalSize); // 마지막 텐서도 정렬 배수까지 채운다(llama.cpp 와 같다)
    return { sha256: hash.digest('hex'), size: pos };
  } catch (err) {
    if (out) await out.close().catch(() => undefined);
    out = undefined;
    await rm(path, { force: true });
    throw err;
  } finally {
    for (const fh of inputs) await fh.close().catch(() => undefined);
    if (out) await out.close();
  }
}

/** 파일로 병합: 같은 폴더 임시 파일에 쓰고 rename(중단돼도 반쪽 파일이 남지 않는다) */
export async function mergeToFile(
  plan: MergePlan,
  outPath: string,
  options: { signal?: AbortSignal; onProgress?: (written: number) => void } = {},
): Promise<{ sha256: string; size: number }> {
  if (plan.shards.some((s) => resolve(s) === resolve(outPath))) throw new UsageError('err_merge_output_is_input', { path: outPath });
  const tmp = tempPathFor(outPath);
  const result = await writeMerged(plan, tmp, options);
  try {
    await rename(tmp, outPath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw wrapFsError(err, outPath);
  }
  return result;
}

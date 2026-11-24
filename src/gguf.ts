// GGUF v2/v3 헤더 리더·라이터 (명세: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md)
//
// 파일 순서: "GGUF" → u32 버전 → u64 텐서 수 → u64 KV 수 → KV 들 → 텐서 정보들
//            → general.alignment(기본 32) 배수까지 0 패딩 → 텐서 데이터
// 텐서 정보의 offset 은 "데이터 영역 시작" 기준 상대값이다.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { GgufFormatError } from './errors.js';

export const GGUF_MAGIC = 'GGUF';
export const DEFAULT_ALIGNMENT = 32;

/** KV 값 타입 번호(명세의 gguf_metadata_value_type) */
export const GgufType = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

const FIXED_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

export interface GgufArray {
  itemType: number;
  items: GgufValue[];
}
/** u64·i64 는 bigint, 문자열이 UTF-8 왕복이 안 되면 원래 바이트(Buffer)를 그대로 둔다 */
export type GgufValue = number | bigint | boolean | string | Buffer | GgufArray;

export interface GgufKv {
  key: string;
  type: number;
  value: GgufValue;
}

export interface GgufTensorInfo {
  name: string;
  /** ne[0], ne[1], … (ggml 순서) */
  dims: bigint[];
  /** ggml_type 번호 */
  ggmlType: number;
  /** 데이터 영역 기준 상대 오프셋 */
  offset: bigint;
}

export interface GgufHeader {
  version: number;
  kv: GgufKv[];
  tensors: GgufTensorInfo[];
  alignment: number;
  /** 패딩 전 헤더 끝 위치 */
  headerSize: number;
  /** 데이터 영역 시작(= headerSize 를 alignment 배수로 올림) */
  dataOffset: number;
  fileSize: number;
}

export function alignUp(n: number, alignment: number): number {
  return Math.ceil(n / alignment) * alignment;
}

// ---------------------------------------------------------------- 읽기

/** 파일을 1 MiB 창으로 조금씩 읽는 리더(헤더가 수 MB 인 큰 어휘 배열도 메모리를 적게 쓴다) */
class FileReader {
  pos = 0;
  private buf = Buffer.alloc(0);
  private bufStart = 0;
  constructor(
    private readonly fd: number,
    readonly size: number,
    private readonly path: string,
  ) {}

  take(n: number): Buffer {
    if (n < 0 || this.pos + n > this.size) {
      throw new GgufFormatError('err_gguf_truncated', { path: this.path, pos: this.pos });
    }
    let off = this.pos - this.bufStart;
    if (off < 0 || off + n > this.buf.length) {
      const want = Math.min(Math.max(n, 1 << 20), this.size - this.pos);
      this.buf = Buffer.alloc(want);
      const got = readSync(this.fd, this.buf, 0, want, this.pos);
      if (got < n) throw new GgufFormatError('err_gguf_truncated', { path: this.path, pos: this.pos });
      this.buf = this.buf.subarray(0, got);
      this.bufStart = this.pos;
      off = 0;
    }
    this.pos += n;
    return this.buf.subarray(off, off + n);
  }
  u32(): number {
    return this.take(4).readUInt32LE(0);
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }
  /** 개수·길이용 u64: 남은 파일 크기를 넘으면 깨진 파일로 본다 */
  count(perItemMin: number): number {
    const n = this.u64();
    if (n > BigInt(Math.floor((this.size - this.pos) / Math.max(1, perItemMin)))) {
      throw new GgufFormatError('err_gguf_truncated', { path: this.path, pos: this.pos });
    }
    return Number(n);
  }
  string(): string | Buffer {
    const bytes = this.take(this.count(1));
    const text = bytes.toString('utf8');
    // UTF-8 로 되돌렸을 때 같은 바이트면 문자열, 아니면 원래 바이트를 지켜 왕복이 바이트 단위로 같게 한다
    return Buffer.byteLength(text, 'utf8') === bytes.length && Buffer.from(text, 'utf8').equals(bytes)
      ? text
      : Buffer.from(bytes);
  }
  value(type: number): GgufValue {
    switch (type) {
      case GgufType.STRING:
        return this.string();
      case GgufType.ARRAY: {
        const itemType = this.u32();
        const n = this.count(itemType === GgufType.STRING ? 8 : (FIXED_SIZE[itemType] ?? 1));
        const items: GgufValue[] = new Array(n);
        for (let i = 0; i < n; i++) items[i] = this.value(itemType);
        return { itemType, items };
      }
      case GgufType.UINT8:
        return this.take(1).readUInt8(0);
      case GgufType.INT8:
        return this.take(1).readInt8(0);
      case GgufType.UINT16:
        return this.take(2).readUInt16LE(0);
      case GgufType.INT16:
        return this.take(2).readInt16LE(0);
      case GgufType.UINT32:
        return this.take(4).readUInt32LE(0);
      case GgufType.INT32:
        return this.take(4).readInt32LE(0);
      case GgufType.FLOAT32:
        return this.take(4).readFloatLE(0);
      case GgufType.BOOL:
        return this.take(1).readUInt8(0) !== 0;
      case GgufType.UINT64:
        return this.take(8).readBigUInt64LE(0);
      case GgufType.INT64:
        return this.take(8).readBigInt64LE(0);
      case GgufType.FLOAT64:
        return this.take(8).readDoubleLE(0);
      default:
        throw new GgufFormatError('err_gguf_bad_type', { path: this.path, type });
    }
  }
}

export function readGguf(path: string): GgufHeader {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    throw new GgufFormatError('err_file_missing', { path });
  }
  try {
    const size = fstatSync(fd).size;
    const r = new FileReader(fd, size, path);
    if (size < 24 || r.take(4).toString('latin1') !== GGUF_MAGIC) throw new GgufFormatError('err_not_gguf', { path });
    const version = r.u32();
    // v1 은 개수에 u32 를 써서 형식이 다르다. v2·v3 만 받는다.
    if (version !== 2 && version !== 3) throw new GgufFormatError('err_gguf_version', { path, version });
    const nTensors = r.count(8 + 4 + 4 + 8);
    const nKv = r.count(8 + 4 + 1);

    const kv: GgufKv[] = [];
    for (let i = 0; i < nKv; i++) {
      const rawKey = r.string();
      const key = typeof rawKey === 'string' ? rawKey : rawKey.toString('utf8');
      const type = r.u32();
      kv.push({ key, type, value: r.value(type) });
    }

    const tensors: GgufTensorInfo[] = [];
    for (let i = 0; i < nTensors; i++) {
      const rawName = r.string();
      const name = typeof rawName === 'string' ? rawName : rawName.toString('utf8');
      const nDims = r.u32();
      if (nDims > 8) throw new GgufFormatError('err_gguf_truncated', { path, pos: r.pos });
      const dims: bigint[] = [];
      for (let d = 0; d < nDims; d++) dims.push(r.u64());
      const ggmlType = r.u32();
      const offset = r.u64();
      tensors.push({ name, dims, ggmlType, offset });
    }

    const alignKv = kv.find((k) => k.key === 'general.alignment');
    const alignment = alignKv ? Number(alignKv.value) : DEFAULT_ALIGNMENT;
    if (!Number.isInteger(alignment) || alignment <= 0 || alignment % 8 !== 0) {
      throw new GgufFormatError('err_gguf_alignment', { path, alignment: String(alignKv?.value) });
    }
    const headerSize = r.pos;
    return { version, kv, tensors, alignment, headerSize, dataOffset: alignUp(headerSize, alignment), fileSize: size };
  } finally {
    closeSync(fd);
  }
}

export function getKv(header: Pick<GgufHeader, 'kv'>, key: string): GgufValue | undefined {
  return header.kv.find((k) => k.key === key)?.value;
}

// ---------------------------------------------------------------- 쓰기

class ByteWriter {
  private readonly parts: Buffer[] = [];
  length = 0;
  push(b: Buffer): void {
    this.parts.push(b);
    this.length += b.length;
  }
  fixed(size: number, fill: (b: Buffer) => void): void {
    const b = Buffer.alloc(size);
    fill(b);
    this.push(b);
  }
  u32(v: number): void {
    this.fixed(4, (b) => b.writeUInt32LE(v));
  }
  u64(v: bigint | number): void {
    this.fixed(8, (b) => b.writeBigUInt64LE(BigInt(v)));
  }
  string(v: string | Buffer): void {
    const bytes = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
    this.u64(bytes.length);
    this.push(bytes);
  }
  value(type: number, v: GgufValue): void {
    switch (type) {
      case GgufType.STRING:
        return this.string(v as string | Buffer);
      case GgufType.ARRAY: {
        const arr = v as GgufArray;
        this.u32(arr.itemType);
        this.u64(arr.items.length);
        for (const item of arr.items) this.value(arr.itemType, item);
        return;
      }
      case GgufType.UINT8:
        return this.fixed(1, (b) => b.writeUInt8(v as number));
      case GgufType.INT8:
        return this.fixed(1, (b) => b.writeInt8(v as number));
      case GgufType.UINT16:
        return this.fixed(2, (b) => b.writeUInt16LE(v as number));
      case GgufType.INT16:
        return this.fixed(2, (b) => b.writeInt16LE(v as number));
      case GgufType.UINT32:
        return this.fixed(4, (b) => b.writeUInt32LE(v as number));
      case GgufType.INT32:
        return this.fixed(4, (b) => b.writeInt32LE(v as number));
      case GgufType.FLOAT32:
        return this.fixed(4, (b) => b.writeFloatLE(v as number));
      case GgufType.BOOL:
        return this.fixed(1, (b) => b.writeUInt8(v ? 1 : 0));
      case GgufType.UINT64:
        return this.fixed(8, (b) => b.writeBigUInt64LE(BigInt(v as bigint)));
      case GgufType.INT64:
        return this.fixed(8, (b) => b.writeBigInt64LE(BigInt(v as bigint)));
      case GgufType.FLOAT64:
        return this.fixed(8, (b) => b.writeDoubleLE(v as number));
      default:
        throw new GgufFormatError('err_gguf_bad_type', { path: '<write>', type });
    }
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.parts, this.length);
  }
}

/** 헤더 바이트(데이터 영역 시작까지 0 패딩 포함)를 만든다 */
export function buildHeader(header: Pick<GgufHeader, 'version' | 'kv' | 'tensors' | 'alignment'>): Buffer {
  const w = new ByteWriter();
  w.push(Buffer.from(GGUF_MAGIC, 'latin1'));
  w.u32(header.version);
  w.u64(header.tensors.length);
  w.u64(header.kv.length);
  for (const kv of header.kv) {
    w.string(kv.key);
    w.u32(kv.type);
    w.value(kv.type, kv.value);
  }
  for (const t of header.tensors) {
    w.string(t.name);
    w.u32(t.dims.length);
    for (const d of t.dims) w.u64(d);
    w.u32(t.ggmlType);
    w.u64(t.offset);
  }
  const padding = alignUp(w.length, header.alignment) - w.length;
  w.push(Buffer.alloc(padding));
  return w.toBuffer();
}

// ---------------------------------------------------------------- 텐서 크기

/** ggml_type → [블록당 원소 수, 블록 바이트] (ggml.c 의 type_traits) */
const GGML_TYPE_SIZE: Record<number, [number, number]> = {
  0: [1, 4], // F32
  1: [1, 2], // F16
  2: [32, 18], // Q4_0
  3: [32, 20], // Q4_1
  6: [32, 22], // Q5_0
  7: [32, 24], // Q5_1
  8: [32, 34], // Q8_0
  9: [32, 36], // Q8_1
  10: [256, 84], // Q2_K
  11: [256, 110], // Q3_K
  12: [256, 144], // Q4_K
  13: [256, 176], // Q5_K
  14: [256, 210], // Q6_K
  15: [256, 292], // Q8_K
  16: [256, 66], // IQ2_XXS
  17: [256, 74], // IQ2_XS
  18: [256, 98], // IQ3_XXS
  19: [256, 50], // IQ1_S
  20: [32, 18], // IQ4_NL
  21: [256, 110], // IQ3_S
  22: [256, 82], // IQ2_S
  23: [256, 136], // IQ4_XS
  24: [1, 1], // I8
  25: [1, 2], // I16
  26: [1, 4], // I32
  27: [1, 8], // I64
  28: [1, 8], // F64
  29: [256, 56], // IQ1_M
  30: [1, 2], // BF16
};

/** 텐서 데이터 바이트 수. 모르는 타입이면 null(병합기는 다음 텐서까지의 간격을 쓴다) */
export function tensorNbytes(t: GgufTensorInfo): number | null {
  const traits = GGML_TYPE_SIZE[t.ggmlType];
  if (!traits || t.dims.length === 0) return null;
  const [block, typeSize] = traits;
  const ne0 = Number(t.dims[0]);
  if (ne0 % block !== 0) return null;
  let rows = 1;
  for (const d of t.dims.slice(1)) rows *= Number(d);
  return (ne0 / block) * typeSize * rows;
}

export function tensorElements(t: GgufTensorInfo): number {
  return t.dims.reduce((acc, d) => acc * Number(d), 1);
}

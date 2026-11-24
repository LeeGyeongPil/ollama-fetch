// 결정적 합성 GGUF 생성기 — 고정 시드로 매번 같은 바이트를 만든다(외부 모델 파일·라이선스 없음).
// 추론할 수 있는 모델이 아니라 "모양만 llama 같은" 연습용 파일이다.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alignUp, buildHeader, DEFAULT_ALIGNMENT, type GgufKv, GgufType } from '../gguf.js';

export interface SynthTensor {
  name: string;
  /** ne[0], ne[1] … */
  dims: number[];
  /** F32 데이터 */
  data: Buffer;
}

export interface SynthModel {
  kv: GgufKv[];
  tensors: SynthTensor[];
  alignment: number;
}

/** mulberry32: 작고 결정적인 의사 난수 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function f32Tensor(name: string, dims: number[], rand: () => number): SynthTensor {
  const count = dims.reduce((a, b) => a * b, 1);
  const data = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) data.writeFloatLE(Math.fround(rand() * 2 - 1), i * 4);
  return { name, dims, data };
}

/**
 * 합성 모델. scale 이 커지면 텐서가 커진다(1 → 약 40 KiB, 10 → 약 3 MiB).
 * KV 에는 13가지 값 타입(배열 안의 배열 포함)을 모두 넣어 리더·라이터 왕복을 검사한다.
 */
export function synthModel(options: { alignment?: number; scale?: number; seed?: number; name?: string } = {}): SynthModel {
  const alignment = options.alignment ?? DEFAULT_ALIGNMENT;
  const scale = options.scale ?? 1;
  const rand = prng(options.seed ?? 20261124);
  const dim = 16 * scale;
  const vocab = 64 * scale;
  const ff = dim * 2 + 8;
  const blocks = 2;

  const tokens = ['<unk>', '<s>', '</s>'];
  for (let i = tokens.length; i < vocab; i++) tokens.push(`tok${i}`);

  const kv: GgufKv[] = [
    { key: 'general.architecture', type: GgufType.STRING, value: 'llama' },
    { key: 'general.name', type: GgufType.STRING, value: options.name ?? 'tiny-synth' },
    { key: 'general.file_type', type: GgufType.UINT32, value: 0 },
  ];
  if (alignment !== DEFAULT_ALIGNMENT) kv.push({ key: 'general.alignment', type: GgufType.UINT32, value: alignment });
  kv.push(
    { key: 'llama.context_length', type: GgufType.UINT32, value: 256 },
    { key: 'llama.embedding_length', type: GgufType.UINT32, value: dim },
    { key: 'llama.block_count', type: GgufType.UINT32, value: blocks },
    { key: 'llama.rope.freq_base', type: GgufType.FLOAT32, value: Math.fround(10000) },
    { key: 'llama.attention.layer_norm_rms_epsilon', type: GgufType.FLOAT32, value: Math.fround(1e-5) },
    { key: 'tokenizer.ggml.model', type: GgufType.STRING, value: 'llama' },
    { key: 'tokenizer.ggml.tokens', type: GgufType.ARRAY, value: { itemType: GgufType.STRING, items: tokens } },
    {
      key: 'tokenizer.ggml.scores',
      type: GgufType.ARRAY,
      value: { itemType: GgufType.FLOAT32, items: tokens.map((_, i) => Math.fround(-i / 10)) },
    },
    {
      key: 'tokenizer.ggml.token_type',
      type: GgufType.ARRAY,
      value: { itemType: GgufType.INT32, items: tokens.map((_, i) => (i < 3 ? 3 : 1)) },
    },
    { key: 'tokenizer.ggml.bos_token_id', type: GgufType.UINT32, value: 1 },
    // 나머지 값 타입들(왕복 검사용)
    { key: 'synth.u8', type: GgufType.UINT8, value: 200 },
    { key: 'synth.i8', type: GgufType.INT8, value: -7 },
    { key: 'synth.u16', type: GgufType.UINT16, value: 65000 },
    { key: 'synth.i16', type: GgufType.INT16, value: -1234 },
    { key: 'synth.i32', type: GgufType.INT32, value: -123456 },
    { key: 'synth.bool', type: GgufType.BOOL, value: true },
    { key: 'synth.u64', type: GgufType.UINT64, value: 1n << 40n },
    { key: 'synth.i64', type: GgufType.INT64, value: -(1n << 40n) },
    { key: 'synth.f64', type: GgufType.FLOAT64, value: 3.141592653589793 },
    {
      key: 'synth.nested',
      type: GgufType.ARRAY,
      value: {
        itemType: GgufType.ARRAY,
        items: [
          { itemType: GgufType.UINT16, items: [1, 2, 3] },
          { itemType: GgufType.STRING, items: ['한국어', 'emoji ✓'] },
        ],
      },
    },
  );

  const tensors: SynthTensor[] = [f32Tensor('token_embd.weight', [dim, vocab], rand)];
  for (let b = 0; b < blocks; b++) {
    tensors.push(
      f32Tensor(`blk.${b}.attn_norm.weight`, [dim], rand),
      f32Tensor(`blk.${b}.attn_q.weight`, [dim, dim], rand),
      f32Tensor(`blk.${b}.attn_k.weight`, [dim, dim], rand),
      f32Tensor(`blk.${b}.attn_v.weight`, [dim, dim], rand),
      f32Tensor(`blk.${b}.attn_output.weight`, [dim, dim], rand),
      f32Tensor(`blk.${b}.ffn_norm.weight`, [dim], rand),
      f32Tensor(`blk.${b}.ffn_gate.weight`, [dim, ff], rand),
      f32Tensor(`blk.${b}.ffn_down.weight`, [ff, dim], rand),
      f32Tensor(`blk.${b}.ffn_up.weight`, [dim, ff], rand),
    );
  }
  // 9 개 원소(36 바이트)짜리 텐서: 정렬 배수가 아니라 패딩 경로를 반드시 지나게 한다
  tensors.push(f32Tensor('rope_freqs.weight', [9], rand));
  tensors.push(f32Tensor('output_norm.weight', [dim], rand));
  tensors.push(f32Tensor('output.weight', [dim, vocab], rand));
  return { kv, tensors, alignment };
}

/** KV + 텐서 → GGUF 파일 바이트(텐서마다 정렬 배수로 패딩) */
export function encodeGguf(kv: GgufKv[], tensors: SynthTensor[], alignment: number): Buffer {
  let cursor = 0;
  const infos = tensors.map((t) => {
    cursor = alignUp(cursor, alignment);
    const info = { name: t.name, dims: t.dims.map(BigInt), ggmlType: 0, offset: BigInt(cursor) };
    cursor += t.data.length;
    return info;
  });
  const header = buildHeader({ version: 3, kv, tensors: infos, alignment });
  const data = Buffer.alloc(alignUp(cursor, alignment));
  tensors.forEach((t, i) => t.data.copy(data, Number(infos[i].offset)));
  return Buffer.concat([header, data]);
}

export function encodeModel(model: SynthModel): Buffer {
  return encodeGguf(model.kv, model.tensors, model.alignment);
}

/**
 * llama-gguf-split 처럼 나눈다: 첫 샤드는 모든 KV + split.* 3개, 나머지 샤드는 split.* 3개만.
 * 나머지 샤드에는 general.alignment 가 없으니 기본 정렬 32 를 쓴다(원본이 64 여도) — 병합기가 다시 정렬해야 한다.
 */
export function splitModel(model: SynthModel, count: number): Buffer[] {
  const total = model.tensors.length;
  const shards: Buffer[] = [];
  for (let s = 0; s < count; s++) {
    const part = model.tensors.slice(Math.floor((s * total) / count), Math.floor(((s + 1) * total) / count));
    const splitKv: GgufKv[] = [
      { key: 'split.no', type: GgufType.UINT16, value: s },
      { key: 'split.count', type: GgufType.UINT16, value: count },
      { key: 'split.tensors.count', type: GgufType.INT32, value: total },
    ];
    const kv = s === 0 ? [...splitKv, ...model.kv] : splitKv;
    shards.push(encodeGguf(kv, part, s === 0 ? model.alignment : DEFAULT_ALIGNMENT));
  }
  return shards;
}

export function shardName(base: string, index: number, count: number): string {
  return `${base}-${String(index).padStart(5, '0')}-of-${String(count).padStart(5, '0')}.gguf`;
}

/** 샤드 파일을 dir 에 쓰고 경로 목록을 돌려준다 */
export function writeSplitModel(dir: string, base: string, model: SynthModel, count: number): string[] {
  return splitModel(model, count).map((bytes, i) => {
    const path = join(dir, shardName(base, i + 1, count));
    writeFileSync(path, bytes);
    return path;
  });
}

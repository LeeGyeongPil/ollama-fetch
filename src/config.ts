// GGUF → Ollama 등록: config 블롭(JSON) + 모델 블롭 + 매니페스트를 $OLLAMA_MODELS 에 쓴다.
// 이렇게 쓰기만 해도 `ollama list` 에 바로 보인다(Ollama 0.40.15 에서 확인).
import { copyFile, link, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getKv, type GgufKv, type GgufTensorInfo, tensorElements } from './gguf.js';
import { type MergePlan, mergeToFile, writeMerged } from './merge.js';
import { CONFIG_MEDIA_TYPE, MANIFEST_MEDIA_TYPE, MODEL_MEDIA_TYPE } from './registry.js';
import { type ModelRef, manifestPath } from './ref.js';
import { blobPath, ensureDir, PARTIAL_SUFFIX, putSmallBlob, writeFileAtomic, wrapFsError } from './store.js';

/** general.file_type(llama_ftype 번호) → Ollama 가 보여 주는 양자화 이름 */
const FILE_TYPE_NAMES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
};

export function fileTypeName(value: unknown): string {
  if (typeof value !== 'number' && typeof value !== 'bigint') return 'unknown';
  return FILE_TYPE_NAMES[Number(value)] ?? 'unknown';
}

/** 파라미터 수 → "15M", "1.2B" (ollama show 의 표기와 비슷하게) */
export function humanParams(n: number): string {
  const fmt = (value: number, unit: string) =>
    `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)}${unit}`;
  if (n >= 1e9) return fmt(n / 1e9, 'B');
  if (n >= 1e6) return fmt(n / 1e6, 'M');
  if (n >= 1e3) return fmt(n / 1e3, 'K');
  return String(n);
}

function goArch(): string {
  return process.arch === 'x64' ? 'amd64' : process.arch;
}
function goOs(): string {
  return process.platform === 'win32' ? 'windows' : process.platform;
}

/** Ollama config 블롭 JSON. model_family ← general.architecture, file_type ← general.file_type */
export function buildConfig(kv: GgufKv[], tensors: GgufTensorInfo[], modelDigest: string): Buffer {
  const arch = getKv({ kv }, 'general.architecture');
  const family = typeof arch === 'string' ? arch : 'unknown';
  const params = tensors.reduce((s, t) => s + tensorElements(t), 0);
  const config = {
    model_format: 'gguf',
    model_family: family,
    model_families: [family],
    model_type: humanParams(params),
    file_type: fileTypeName(getKv({ kv }, 'general.file_type')),
    architecture: goArch(),
    os: goOs(),
    rootfs: { type: 'layers', diff_ids: [modelDigest] },
  };
  return Buffer.from(JSON.stringify(config));
}

export function buildManifest(config: { digest: string; size: number }, model: { digest: string; size: number }): Buffer {
  const manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: { mediaType: CONFIG_MEDIA_TYPE, digest: config.digest, size: config.size },
    layers: [{ mediaType: MODEL_MEDIA_TYPE, digest: model.digest, size: model.size }],
  };
  return Buffer.from(JSON.stringify(manifest));
}

export interface RegisterResult {
  modelDigest: string;
  modelSize: number;
  configDigest: string;
  configSize: number;
  manifestPath: string;
  /** -o 를 줬으면 그 파일 */
  outputPath?: string;
}

/**
 * 병합하면서 바로 블롭으로 넣는다. -o 도 주면 파일을 만든 뒤 같은 볼륨이면 하드링크, 아니면 복사한다.
 * 순서: 모델 블롭 → config 블롭 → 매니페스트(마지막)
 */
export async function mergeAndRegister(
  plan: MergePlan,
  options: { ref: ModelRef; modelsDir: string; output?: string; signal?: AbortSignal; onProgress?: (n: number) => void },
): Promise<RegisterResult> {
  const blobsDir = join(options.modelsDir, 'blobs');
  await ensureDir(blobsDir);
  const tmp = join(blobsDir, `.merge-${process.pid}-${randomBytes(4).toString('hex')}${PARTIAL_SUFFIX}`);

  let merged: { sha256: string; size: number };
  try {
    if (options.output) {
      merged = await mergeToFile(plan, options.output, { signal: options.signal, onProgress: options.onProgress });
      try {
        await link(options.output, tmp);
      } catch {
        await copyFile(options.output, tmp);
      }
    } else {
      merged = await writeMerged(plan, tmp, { signal: options.signal, onProgress: options.onProgress });
    }
    await rename(tmp, blobPath(options.modelsDir, `sha256:${merged.sha256}`));
  } catch (err) {
    await rm(tmp, { force: true });
    throw wrapFsError(err, blobsDir);
  }

  const modelDigest = `sha256:${merged.sha256}`;
  const config = await putSmallBlob(options.modelsDir, buildConfig(plan.kv, plan.tensors, modelDigest));
  const path = manifestPath(options.modelsDir, options.ref);
  await writeFileAtomic(path, buildManifest(config, { digest: modelDigest, size: merged.size }));
  return {
    modelDigest,
    modelSize: merged.size,
    configDigest: config.digest,
    configSize: config.size,
    manifestPath: path,
    outputPath: options.output,
  };
}

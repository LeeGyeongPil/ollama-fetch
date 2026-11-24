// 모델 참조 해석: "llama3.2:1b" → registry.ollama.ai / library / llama3.2 / 1b
import { join } from 'node:path';
import { InputError } from './errors.js';

export const DEFAULT_HOST = 'registry.ollama.ai';
export const DEFAULT_NAMESPACE = 'library';
export const DEFAULT_TAG = 'latest';

export interface ModelRef {
  host: string;
  namespace: string;
  repo: string;
  tag: string;
}

// 경로 조각으로 그대로 쓰이므로 '/'·'\\'·'..' 시작을 막는다(경로 탈출 방지)
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
// 호스트도 경로 조각이 되므로 ".." 같은 값을 막는다: 점으로 나눈 각 라벨이 영숫자로 시작·끝나야 한다
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;

/**
 * 받는 형식: name, name:tag, ns/name:tag, host/ns/name:tag
 * (첫 조각에 '.' 이나 ':' 이 있거나 localhost 이면 호스트로 본다)
 */
export function parseRef(input: string): ModelRef {
  const raw = input.trim();
  if (!raw || raw.includes('@') || raw.includes('\\')) throw new InputError('err_bad_ref', { ref: input });

  const parts = raw.split('/');
  let host = DEFAULT_HOST;
  if (parts.length >= 2 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    host = parts.shift() as string;
  }
  if (parts.length < 1 || parts.length > 2) throw new InputError('err_bad_ref', { ref: input });

  // 태그는 마지막 조각의 ':' 뒤
  let last = parts[parts.length - 1];
  let tag = DEFAULT_TAG;
  const colon = last.lastIndexOf(':');
  if (colon !== -1) {
    tag = last.slice(colon + 1);
    last = last.slice(0, colon);
  }
  const namespace = parts.length === 2 ? parts[0] : DEFAULT_NAMESPACE;
  const repo = last;

  if (!HOST.test(host) || !PART.test(namespace) || !PART.test(repo) || !TAG.test(tag)) {
    throw new InputError('err_bad_ref', { ref: input });
  }
  return { host: host.toLowerCase(), namespace, repo, tag };
}

/** 사람이 읽는 전체 이름 */
export function refToString(ref: ModelRef): string {
  return `${ref.host}/${ref.namespace}/${ref.repo}:${ref.tag}`;
}

/** 짧은 이름(ollama list 와 같은 모양) */
export function refShort(ref: ModelRef): string {
  if (ref.host === DEFAULT_HOST && ref.namespace === DEFAULT_NAMESPACE) return `${ref.repo}:${ref.tag}`;
  if (ref.host === DEFAULT_HOST) return `${ref.namespace}/${ref.repo}:${ref.tag}`;
  return refToString(ref);
}

/** $OLLAMA_MODELS/manifests/<host>/<ns>/<repo>/<tag> */
export function manifestPath(modelsDir: string, ref: ModelRef): string {
  return join(modelsDir, 'manifests', ref.host, ref.namespace, ref.repo, ref.tag);
}

/** 레지스트리 기본 주소. --registry 를 주면 그 주소로 바꾸되 저장 경로의 호스트는 그대로 둔다 */
export function registryBase(ref: ModelRef, override?: string): string {
  const base = override ?? `https://${ref.host}`;
  return base.replace(/\/+$/, '');
}

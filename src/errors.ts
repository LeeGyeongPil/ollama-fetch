// 종료 코드와 묶인 오류 종류. 문구는 키로만 들고 다니고, 화면에 낼 때 고른 언어로 바꾼다.
import type { MessageKey } from './messages/en.js';
import { translate, type MsgVars } from './i18n.js';

export const EXIT = {
  ok: 0,
  usage: 1,
  input: 2,
  integrity: 3,
  network: 4,
  interrupted: 130,
} as const;

export class AppError extends Error {
  readonly key: MessageKey;
  readonly vars: MsgVars;
  readonly exitCode: number;

  constructor(key: MessageKey, vars: MsgVars, exitCode: number) {
    // 라이브러리로 쓸 때 보이는 message 는 영어
    super(translate('en', key, vars));
    this.name = new.target.name;
    this.key = key;
    this.vars = vars;
    this.exitCode = exitCode;
  }
}

/** 종료 코드 1: 옵션·인자 사용법 오류 */
export class UsageError extends AppError {
  constructor(key: MessageKey, vars: MsgVars = {}) {
    super(key, vars, EXIT.usage);
  }
}

/** 종료 코드 2: 입력·형식 오류(참조 형식, 샤드 빠짐, 쓰기 권한 등) */
export class InputError extends AppError {
  constructor(key: MessageKey, vars: MsgVars = {}) {
    super(key, vars, EXIT.input);
  }
}

/** 종료 코드 2: GGUF 가 아니거나 헤더가 깨진 파일 */
export class GgufFormatError extends InputError {}

/** 종료 코드 3: 재시도 후에도 다이제스트가 맞지 않음 */
export class IntegrityError extends AppError {
  constructor(key: MessageKey, vars: MsgVars = {}) {
    super(key, vars, EXIT.integrity);
  }
}

/** 종료 코드 4: 재시도를 다 써도 받지 못함, 매니페스트 404 등 */
export class NetworkError extends AppError {
  constructor(key: MessageKey, vars: MsgVars = {}) {
    super(key, vars, EXIT.network);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

// 화면 언어 결정과 문구 찾기. 문구는 messages/en.ts · messages/ko.ts 두 표에만 있다.
import { en, type MessageKey } from './messages/en.js';
import { ko } from './messages/ko.js';

export type Lang = 'en' | 'ko';
export type MsgVars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: MsgVars) => string;

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, ko };

/** "ko", "ko_KR.UTF-8", "ko-KR" 처럼 ko 로 시작하면 한국어, 그 밖은 전부 영어 */
export function normalizeLang(value: string | undefined): Lang {
  return value && value.trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/**
 * 우선순위: --lang 옵션 > OLLAMA_FETCH_LANG > LC_ALL > LC_MESSAGES > LANG.
 * 처음으로 값이 있는 곳에서 정하고, 그 값이 ko 로 시작하지 않으면 영어다.
 */
export function resolveLang(flag: string | undefined, env: NodeJS.ProcessEnv): Lang {
  if (flag) return normalizeLang(flag);
  for (const name of ['OLLAMA_FETCH_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[name];
    if (value && value.trim() !== '') return normalizeLang(value);
  }
  return 'en';
}

/** "{name}" 자리표시를 값으로 바꾼다 */
export function format(template: string, vars: MsgVars = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

export function translate(lang: Lang, key: MessageKey, vars?: MsgVars): string {
  return format(MESSAGES[lang][key], vars);
}

export function createTranslator(lang: Lang): Translate {
  return (key, vars) => translate(lang, key, vars);
}

/** 표를 맞추기 위한 화면 폭: 한글·CJK 전각 문자는 2칸으로 센다 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

export function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

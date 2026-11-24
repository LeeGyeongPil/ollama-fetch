#!/usr/bin/env node
// 실행 파일: 실제 stdout·stderr·환경 변수·Ctrl+C 를 main() 에 연결한다.
import { main } from './main.js';

const controller = new AbortController();
// 첫 Ctrl+C: 받던 것을 멈추고 partial 을 남긴 채 정리. 두 번째: 바로 끝낸다.
const onSigint = () => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
};
process.on('SIGINT', onSigint);
// `ollama-fetch demo | head` 처럼 출력 받는 쪽이 먼저 닫히면(EPIPE) 죽지 말고 멈춘 뒤 임시 파일을 정리한다
const onPipeError = (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') controller.abort();
  else throw err;
};
process.stdout.on('error', onPipeError);
process.stderr.on('error', onPipeError);

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: process.stderr.isTTY === true,
  env: process.env,
  signal: controller.signal,
});
process.off('SIGINT', onSigint);
process.exitCode = code;

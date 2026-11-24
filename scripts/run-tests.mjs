// 컴파일된 테스트를 집합별로 실행한다: node scripts/run-tests.mjs <unit|net|e2e>
//   unit — 기본 집합(`npm test`, CI). 소켓·실제 대기 없음. 네트워크 가드를 켠다.
//   net  — 127.0.0.1 실제 소켓과 실제 시간(`npm run test:net`, 로컬에서만).
//   e2e  — 실제 인터넷(`npm run test:e2e`, 수동).
// `node --test <폴더>` 와 글롭 인자는 Node 버전마다 다르게 해석되므로 파일 목록을 직접 만든다.
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SUITES = ['unit', 'net', 'e2e'];
const suite = process.argv[2] ?? 'unit';
if (!SUITES.includes(suite)) {
  console.error(`usage: node scripts/run-tests.mjs <${SUITES.join('|')}>`);
  process.exit(1);
}

// 원본(test/<집합>/*.test.ts)이 있는 컴파일 결과만 실행한다(tsc 는 지운 원본의 옛 결과를 지우지 않는다)
const files = readdirSync(join('test', suite))
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join('dist', 'test', suite, f.replace(/\.ts$/, '.js')));
const missing = files.filter((f) => !existsSync(f));
if (files.length === 0 || missing.length > 0) {
  console.error(`suite ${suite}: compiled tests missing (${missing.join(', ') || 'none found'}). Run \`npm run build\` first.`);
  process.exit(1);
}

const guard = suite === 'unit';
const flags = [];
// 가드는 테스트 실행기와 테스트 파일 프로세스가 시작될 때 걸린다(--import 는 자식 테스트 프로세스에도 전달된다)
if (guard) flags.push('--import', pathToFileURL(join('test', 'support', 'no-network.mjs')).href);
// 멈춘 테스트는 30초에 이름과 함께 실패한다(e2e 는 실제 회선으로 26 MB 를 받으므로 180초).
// 파일은 하나씩 순서대로(2 vCPU 러너에서도 서로 간섭하지 않게).
const testTimeoutMs = suite === 'e2e' ? 180_000 : 30_000;
flags.push('--test', `--test-timeout=${testTimeoutMs}`, '--test-concurrency=1');

// 첫 줄: CI 로그에서 집합·파일 수·Node 버전·가드 상태를 바로 본다
console.log(`suite ${suite}: ${files.length} files, node ${process.version}, network guard ${guard ? 'on' : 'off'}`);

const child = spawn(process.execPath, [...flags, ...files], { stdio: 'inherit' });
// 전체 감시 300초: 무엇이 멈춰도 CI 작업 시간 제한까지 붙들지 않는다
const watchdog = setTimeout(() => {
  console.error(`suite ${suite}: still running after 300 s, stopping the test runner`);
  child.kill('SIGKILL');
}, 300_000);
child.on('error', (err) => {
  clearTimeout(watchdog);
  console.error(err);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  clearTimeout(watchdog);
  if (signal) console.error(`test runner killed by ${signal}`);
  process.exit(code ?? 1);
});

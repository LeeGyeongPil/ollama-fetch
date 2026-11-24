// 네트워크 가드: 기본 테스트 집합(test/unit)이 소켓·DNS 를 하나도 쓰지 않는다는 것을 강제한다.
// `node --import ./test/support/no-network.mjs --test …` 로 테스트 프로세스가 시작될 때 걸린다(scripts/run-tests.mjs).
// 막는 것: 전역 fetch, 소켓 연결(net.Socket#connect), 서버 열기(net.Server#listen), 이름 풀기(dns.lookup).
// 자식 프로세스의 파이프·테스트 실행기의 통신은 connect/listen 을 거치지 않으므로 그대로 동작한다.
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

export class NetworkGuardError extends Error {
  constructor(what) {
    super(`network access is blocked in the unit test suite: ${what} (use the in-memory mock registry; real sockets belong in test/net)`);
    this.name = 'NetworkGuardError';
  }
}

const block = (what) =>
  function blocked() {
    throw new NetworkGuardError(what);
  };

globalThis.fetch = block('fetch()');
net.Socket.prototype.connect = block('net.Socket#connect()');
net.Server.prototype.listen = block('net.Server#listen()');
dns.lookup = block('dns.lookup()');
dns.promises.lookup = block('dns.promises.lookup()');
// `import { lookup } from 'node:dns'` 같은 이름 가져오기에도 바뀐 함수가 보이게 한다
syncBuiltinESMExports();

// 테스트가 가드가 정말 켜졌는지 확인할 수 있게 표시한다
globalThis[Symbol.for('ollama-fetch.networkGuard')] = true;

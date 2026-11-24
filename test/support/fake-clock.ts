// 가짜 시계: sleep 은 실제로 기다리지 않고 가상 시각만 앞으로 돌린다.
// 속도 상한을 벽시계로 재면 느린 기계·붐비는 CI 에서 흔들리므로, 단위 테스트는 이 시계로 "가상 경과"를 단언한다.
import type { Clock } from '../../src/ratelimit.js';

export class FakeClock implements Clock {
  /** 가상 현재 시각(ms) */
  t = 0;
  /** sleep 이 불린 횟수(무제한 모드에서 0 인지 확인용) */
  sleeps = 0;

  now(): number {
    return this.t;
  }

  /**
   * 깨는 시각 = 부른 시점 + ms. 가상 시각을 max(지금, 깨는 시각) 으로 옮기고,
   * 다른 비동기 작업(파일 쓰기 등)이 끼어들 수 있게 setImmediate 로 한 번 양보한 뒤 끝난다.
   * 타이머(setTimeout)를 쓰지 않으므로 실제 시간은 거의 흐르지 않는다.
   */
  sleep(ms: number): Promise<void> {
    this.sleeps += 1;
    const wake = this.t + Math.max(0, ms);
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        this.t = Math.max(this.t, wake);
        resolve();
      });
    });
  }
}

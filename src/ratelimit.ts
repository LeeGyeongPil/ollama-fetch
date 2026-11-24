// 전체 공용 토큰 버킷 — 모든 연결이 버킷 하나에서 바이트 토큰을 꺼내 쓴다.
// 그래서 연결이 1개든 8개든 합계 속도는 rate 를 넘지 않는다.

/** 시계와 sleep 을 바꿔 끼울 수 있게 해 테스트에서 가짜 시계로 결정적으로 검증한다. */
export interface Clock {
  /** 밀리초 단위 현재 시각(단조 증가) */
  now(): number;
  /** ms 만큼 기다린다 */
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** 버스트 기본값: 100ms 분량, 최소 16 KiB. 1초 분량으로 잡으면 짧은 다운로드에서 상한을 넘는다(프로브 +18%). */
export function defaultBurst(rate: number): number {
  return Math.max(Math.round(rate * 0.1), 16 * 1024);
}

export class TokenBucket {
  readonly rate: number; // bytes per second, 0 이면 무제한
  readonly burst: number; // 버킷 용량(bytes)
  private tokens: number;
  private last: number;
  private readonly clock: Clock;
  // 여러 연결이 동시에 take() 해도 도착 순서대로 한 명씩 처리한다(FIFO 줄).
  private queue: Promise<void> = Promise.resolve();

  constructor(rate: number, options: { burst?: number; clock?: Clock } = {}) {
    this.rate = rate > 0 && Number.isFinite(rate) ? rate : 0;
    this.burst = options.burst ?? (this.rate ? defaultBurst(this.rate) : 0);
    this.clock = options.clock ?? realClock;
    this.tokens = this.burst; // 처음에는 버킷이 가득 차 있다
    this.last = this.clock.now();
  }

  get unlimited(): boolean {
    return this.rate === 0;
  }

  /** n 바이트를 보내도 되는 시점까지 기다린다. 상한이 없으면 바로 돌아온다. */
  take(n: number): Promise<void> {
    if (this.unlimited || n <= 0) return Promise.resolve();
    const turn = this.queue.then(() => this.consume(n));
    // 한 소비자가 실패해도 다음 사람의 줄은 끊기지 않게 한다
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  private async consume(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      // 버스트보다 큰 덩어리는 버스트 크기로 잘라서 꺼낸다
      const piece = Math.min(left, this.burst);
      this.refill();
      if (this.tokens < piece) {
        // 모자란 만큼 채워질 때까지 기다린다
        const waitMs = ((piece - this.tokens) / this.rate) * 1000;
        await this.clock.sleep(waitMs);
        this.refill();
      }
      // 실제 타이머가 조금 일찍 깨어나도 상한을 넘지 않게 빚(음수)으로 남긴다
      this.tokens -= piece;
      left -= piece;
    }
  }
}

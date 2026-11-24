// 핵심 모듈이 내는 구조화 이벤트를 고른 언어의 화면 문구로 바꾼다.
// 터미널(TTY)이면 stderr 한 줄을 덮어쓰는 진행 표시를 0.25초마다 갱신하고, 끝나면 타이머를 지운다.
import type { Translate } from './i18n.js';
import { formatBytes, formatDuration, formatElapsed, formatRate } from './plan.js';
import type { PullEvent } from './pull.js';

export interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** stderr 가 터미널이면 진행 줄을 보여 준다 */
  isTTY?: boolean;
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 19); // "sha256:" + 앞 12자
}

/** 일반 줄 출력 + (TTY 일 때만) 덮어쓰는 진행 줄 */
export class Printer {
  private progressShown = false;
  constructor(
    private readonly out: Output,
    private readonly quiet = false,
  ) {}

  line(text: string): void {
    if (this.quiet) return;
    this.clearProgress();
    this.out.stdout(text + '\n');
  }

  /** --quiet 에서도 보이는 줄(마지막 결과) */
  always(text: string): void {
    this.clearProgress();
    this.out.stdout(text + '\n');
  }

  error(text: string): void {
    this.clearProgress();
    this.out.stderr(text + '\n');
  }

  progress(text: string): void {
    if (this.quiet || !this.out.isTTY) return;
    this.out.stderr(`\r\x1b[K${text}`);
    this.progressShown = true;
  }

  clearProgress(): void {
    if (!this.progressShown) return;
    this.out.stderr('\r\x1b[K');
    this.progressShown = false;
  }
}

/** pull 이벤트 → 화면. stop() 을 꼭 불러 진행 타이머를 정리한다 */
export function createPullReporter(t: Translate, printer: Printer, now: () => number = () => performance.now()) {
  let total = 0;
  let done = 0;
  let windowStart = now();
  let windowBytes = 0;
  let speed = 0;
  const blobSizes = new Map<string, number>();

  const timer = setInterval(() => {
    // 최근 구간 속도(지수 평활)로 남은 시간을 계산한다
    const elapsed = (now() - windowStart) / 1000;
    if (elapsed > 0) speed = speed === 0 ? windowBytes / elapsed : speed * 0.7 + (windowBytes / elapsed) * 0.3;
    windowStart = now();
    windowBytes = 0;
    if (total > 0) {
      printer.progress(
        t('progress_line', {
          done: formatBytes(done),
          total: formatBytes(total),
          pct: Math.floor((done / total) * 100),
          rate: formatRate(speed),
          eta: speed > 0 ? formatDuration((total - done) / speed) : '?',
        }),
      );
    }
  }, 250);
  timer.unref(); // 진행 표시 때문에 프로세스가 끝나지 못하는 일이 없게

  const onEvent = (event: PullEvent) => {
    switch (event.type) {
      case 'manifest':
        printer.line(t('pull_manifest', { layers: event.layers, total: formatBytes(event.totalBytes) }));
        break;
      case 'blob-skip':
        printer.line(t('blob_skip', { digest: shortDigest(event.digest), size: formatBytes(event.size) }));
        break;
      case 'blob-start':
        total += event.size;
        blobSizes.set(event.digest, event.size);
        printer.line(t('blob_start', { digest: shortDigest(event.digest), size: formatBytes(event.size), media: event.mediaType }));
        break;
      case 'progress':
        done += event.bytes;
        windowBytes += event.bytes;
        break;
      case 'resume':
        printer.line(
          t('blob_resume', { digest: shortDigest(event.digest), at: event.at, pct: Math.floor((event.at / event.size) * 100) }),
        );
        break;
      case 'range-ignored':
        done -= event.had; // 받아 둔 부분을 버리고 다시 받으니 진행에서 뺀다
        printer.line(t('blob_range_ignored', { digest: shortDigest(event.digest), status: event.status, had: event.had }));
        break;
      case 'drop':
        printer.line(
          t('blob_drop', {
            digest: shortDigest(event.digest),
            pct: event.size ? Math.floor((event.at / event.size) * 100) : 0,
            at: event.at,
            reason: event.reason,
            failure: event.failure,
            retries: event.retries,
            delay: formatElapsed(event.delayMs / 1000),
          }),
        );
        break;
      case 'verify-fail':
        done = Math.max(0, done - (blobSizes.get(event.digest) ?? 0)); // 통째로 다시 받는다
        printer.line(
          t('blob_verify_fail', {
            digest: shortDigest(event.digest),
            actual: `sha256:${event.actual.slice(0, 12)}`,
            failure: event.failure,
            retries: event.retries,
          }),
        );
        break;
      case 'blob-done':
        printer.line(
          t('blob_done', {
            digest: shortDigest(event.digest),
            size: formatBytes(event.size),
            time: formatElapsed(event.elapsedMs / 1000),
            rate: formatRate(event.elapsedMs > 0 ? event.transferred / (event.elapsedMs / 1000) : event.transferred),
          }),
        );
        break;
      case 'manifest-written':
        printer.line(t('manifest_written', { path: event.path }));
        break;
      default:
        break; // redirect, verify-ok 는 화면에 따로 내지 않는다
    }
  };

  return {
    onEvent,
    stop: () => {
      clearInterval(timer);
      printer.clearProgress();
    },
  };
}

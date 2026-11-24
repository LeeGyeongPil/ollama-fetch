// --dry-run 표와 크기·속도·시간 형식화. 파일을 하나도 쓰지 않는다.
import { padDisplay, displayWidth, type Translate } from './i18n.js';
import type { Layer } from './registry.js';
import { blobPath, fileSize } from './store.js';

const UNITS: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** curl --limit-rate 와 같은 1024 기반 단위: 500K, 5M, 1.5M, 2G, 300000 → bytes/s. 형식이 틀리면 null */
export function parseRate(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)(?:i?B)?(?:\/s)?$/.exec(text.trim());
  if (!m) return null;
  const value = Number(m[1]) * UNITS[m[2].toUpperCase()];
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

/** 초 → "8s", "2m 05s", "1h 02m 03s" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(rest).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

/** 짧은 경과·대기 시간: 1분 미만은 "0.5s", "12.3s", 그 이상은 formatDuration */
export function formatElapsed(seconds: number): string {
  return seconds < 60 ? `${Math.max(0, seconds).toFixed(1)}s` : formatDuration(seconds);
}

export interface PlanRow {
  layer: Layer;
  present: boolean;
}

/** 각 블롭이 이미 있는지(크기 일치) 본다. 읽기만 한다 */
export async function planBlobs(modelsDir: string, blobs: Layer[]): Promise<PlanRow[]> {
  const rows: PlanRow[] = [];
  for (const layer of blobs) {
    rows.push({ layer, present: (await fileSize(blobPath(modelsDir, layer.digest))) === layer.size });
  }
  return rows;
}

/** dry-run 출력 줄들 */
export function renderPlan(rows: PlanRow[], rateLimit: number, t: Translate): string[] {
  const header = [t('plan_col_media'), t('plan_col_size'), t('plan_col_status'), t('plan_col_digest')];
  const body = rows.map((r) => [
    r.layer.mediaType,
    formatBytes(r.layer.size),
    r.present ? t('plan_present') : t('plan_missing'),
    r.layer.digest.slice(0, 19),
  ]);
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...body.map((row) => displayWidth(row[i]))));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : padDisplay(c, widths[i]))).join('  ');

  const total = rows.reduce((s, r) => s + r.layer.size, 0);
  const missing = rows.filter((r) => !r.present);
  const toGet = missing.reduce((s, r) => s + r.layer.size, 0);

  const out = [line(header), ...body.map(line), ''];
  out.push(
    t('plan_total', {
      total: formatBytes(total),
      blobs: rows.length,
      toGet: formatBytes(toGet),
      missing: missing.length,
    }),
  );
  if (rateLimit > 0) {
    out.push(t('plan_eta', { rate: formatRate(rateLimit), eta: formatDuration(toGet / rateLimit) }));
  } else {
    out.push(t('plan_eta_unlimited'));
  }
  out.push(t('plan_no_files'));
  return out;
}

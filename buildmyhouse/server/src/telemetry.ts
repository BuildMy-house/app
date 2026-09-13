export interface FileIoMetric {
  operation: 'save' | 'read' | 'remove' | 'import' | 'export';
  durationMs: number;
  fileSizeKB: number;
  format?: string;
  success: boolean;
  error?: string;
  itemCount?: number;
  cacheHit?: boolean;
}

const TIMEOUT_MS = 5000;

export function fileIoMetrics(metric: FileIoMetric): void {
  console.log(JSON.stringify({ event: 'file_io', ...metric }));

  if (metric.durationMs > TIMEOUT_MS) {
    console.warn(
      `[file-io-alert] Slow ${metric.operation}: ${metric.durationMs.toFixed(1)}ms ` +
      `(${metric.fileSizeKB.toFixed(1)}KB, format=${metric.format ?? 'unknown'})` +
      (metric.error ? ` error=${metric.error}` : ''),
    );
  }
}

export function timed<T>(operation: FileIoMetric['operation'], fn: () => T, meta?: Partial<FileIoMetric>): T {
  const t0 = performance.now();
  let result: T | undefined;
  let success = true;
  let error: string | undefined;
  try {
    result = fn();
  } catch (e: any) {
    success = false;
    error = e?.message ?? String(e);
    throw e;
  } finally {
    const durationMs = performance.now() - t0;
    const sizeKB = typeof result === 'object' && result !== null && 'byteLength' in result
      ? (result as any).byteLength / 1024
      : 0;
    fileIoMetrics({
      operation,
      durationMs,
      fileSizeKB: sizeKB,
      success,
      error,
      ...meta,
    });
  }
  return result!;
}

export async function timedAsync<T>(operation: FileIoMetric['operation'], fn: () => Promise<T>, meta?: Partial<FileIoMetric>): Promise<T> {
  const t0 = performance.now();
  let result: T | undefined;
  let success = true;
  let error: string | undefined;
  try {
    result = await fn();
  } catch (e: any) {
    success = false;
    error = e?.message ?? String(e);
    throw e;
  } finally {
    const durationMs = performance.now() - t0;
    const sizeKB = typeof result === 'object' && result !== null && 'byteLength' in result
      ? (result as any).byteLength / 1024
      : 0;
    fileIoMetrics({
      operation,
      durationMs,
      fileSizeKB: sizeKB,
      success,
      error,
      ...meta,
    });
  }
  return result!;
}

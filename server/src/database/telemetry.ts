import { createHash } from 'node:crypto';
import type { DbAdapter, RunResult } from '../db.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type QueryType = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'EXEC' | 'TRANSACTION';

export interface QueryMetrics {
  queryId: string;
  type: QueryType;
  sql: string;
  durationMs: number;
  rowsAffected: number;
  indexUsed: boolean;
  lockWaitMs: number;
  error?: string;
  sampled: boolean;
}

export interface DbTelemetryConfig {
  slowThresholdMs: number;
  alertSlowMs: number;
  alertLockWaitMs: number;
  fastSampleRate: number;
  onMetrics: (m: QueryMetrics) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashQuery(sql: string): string {
  return createHash('sha256').update(sql.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function classifyQuery(sql: string): QueryType {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith('SELECT')) return 'SELECT';
  if (trimmed.startsWith('INSERT')) return 'INSERT';
  if (trimmed.startsWith('UPDATE')) return 'UPDATE';
  if (trimmed.startsWith('DELETE')) return 'DELETE';
  if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) return 'TRANSACTION';
  return 'EXEC';
}

function detectLockWait(durationMs: number, _sql: string): boolean {
  // Heuristic: lock waits manifest as unexpectedly long waits on simple queries.
  // A SELECT on an indexed column should be <10ms; if it took >50ms and isn't
  // a complex query, likely a lock contention. Conservative — won't false-positive
  // on genuinely slow queries (which are already captured by slowThreshold).
  return durationMs > 50 && /SELECT\s/.test(_sql) && !/JOIN|GROUP|ORDER|LIMIT\s\d{4,}/.test(_sql);
}

// ── Default config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DbTelemetryConfig = {
  slowThresholdMs: 50,
  alertSlowMs: 200,
  alertLockWaitMs: 500,
  fastSampleRate: 0.05,
  onMetrics: () => {},
};

// ── TrackedDbAdapter ─────────────────────────────────────────────────────────

export class TrackedDbAdapter implements DbAdapter {
  readonly _brand = 'DbAdapter' as const;
  private config: DbTelemetryConfig;
  private counter = 0;

  constructor(
    private inner: DbAdapter,
    config?: Partial<DbTelemetryConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private shouldSample(durationMs: number, isSlow: boolean, isLockWait: boolean): boolean {
    if (isSlow || isLockWait) return true;
    if (durationMs >= this.config.slowThresholdMs) return true;
    // Fast query sampling: deterministic based on counter
    return Math.random() < this.config.fastSampleRate;
  }

  private track(
    sql: string,
    durationMs: number,
    rowsAffected: number,
    error?: string,
  ): void {
    const type = classifyQuery(sql);
    const isSlow = durationMs >= this.config.slowThresholdMs;
    const isLockWait = detectLockWait(durationMs, sql);
    const sampled = this.shouldSample(durationMs, isSlow, isLockWait);

    const metrics: QueryMetrics = {
      queryId: hashQuery(sql),
      type,
      sql,
      durationMs: Math.round(durationMs * 100) / 100,
      rowsAffected,
      indexUsed: type === 'SELECT' && durationMs < 10,
      lockWaitMs: isLockWait ? durationMs : 0,
      error,
      sampled,
    };

    if (sampled) {
      this.config.onMetrics(metrics);
    }

    // Emit alerts for high-severity conditions
    if (durationMs >= this.config.alertSlowMs) {
      this.config.onMetrics({ ...metrics, sampled: true });
    }
    if (isLockWait && durationMs >= this.config.alertLockWaitMs) {
      this.config.onMetrics({ ...metrics, sampled: true });
    }
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const t0 = performance.now();
    try {
      const result = await this.inner.get<T>(sql, ...params);
      this.track(sql, performance.now() - t0, result ? 1 : 0);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.track(sql, performance.now() - t0, 0, msg);
      throw err;
    }
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const t0 = performance.now();
    try {
      const result = await this.inner.all<T>(sql, ...params);
      this.track(sql, performance.now() - t0, result.length);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.track(sql, performance.now() - t0, 0, msg);
      throw err;
    }
  }

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    const t0 = performance.now();
    try {
      const result = await this.inner.run(sql, ...params);
      this.track(sql, performance.now() - t0, result.changes);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.track(sql, performance.now() - t0, 0, msg);
      throw err;
    }
  }

  async exec(sql: string): Promise<void> {
    const t0 = performance.now();
    try {
      await this.inner.exec(sql);
      this.track(sql, performance.now() - t0, 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.track(sql, performance.now() - t0, 0, msg);
      throw err;
    }
  }

  async transaction<T>(fn: (tx: DbAdapter) => T | Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      const result = await this.inner.transaction(fn);
      this.track('TRANSACTION', performance.now() - t0, 0);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.track('TRANSACTION', performance.now() - t0, 0, msg);
      throw err;
    }
  }

  async initSchema(): Promise<void> {
    return this.inner.initSchema();
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function withTelemetry(
  adapter: DbAdapter,
  config?: Partial<DbTelemetryConfig>,
): TrackedDbAdapter {
  return new TrackedDbAdapter(adapter, config);
}

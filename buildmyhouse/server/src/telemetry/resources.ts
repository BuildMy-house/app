/**
 * Resource usage monitoring — periodic sampling of memory, CPU, connections, and GC metrics.
 *
 * Tracks: process memory (heap), CPU time, active connections (DB/HTTP/WebSocket), GC activity.
 * Sampling: every 30s (no per-request sampling).
 * Alerts: Memory >85% = critical, GC pause >1s = warning.
 * Overhead: <1ms per 30s report (periodic only).
 *
 * Usage:
 *   resourceTelemetry.startMonitoring({ getDbConnections: () => 5, getHttpConnections: () => 2 })
 *   resourceTelemetry.stopMonitoring()
 *
 * Events emitted as structured JSON to stdout for Axiom ingestion.
 */

import { performance, PerformanceObserver } from 'perf_hooks';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryMetrics {
  heapUsedMB: number;
  heapTotalMB: number;
  heapUsedPercent: number;
  rssMemoryMB: number;
  externalMB: number;
}

export interface CpuMetrics {
  userTimeMs: number;
  systemTimeMs: number;
}

export interface ConnectionMetrics {
  activeDbConnections: number;
  activeHttpConnections: number;
  activeWebSocketConnections: number;
}

export interface GcMetrics {
  kind: 'unknown' | 'scavenge' | 'mark-sweep' | 'incremental-mark-sweep';
  durationMs: number;
  flags: number;
}

export interface ResourceEvent {
  event: string;
  ts: string;
  memory: MemoryMetrics;
  cpu: CpuMetrics;
  connections: ConnectionMetrics;
  gcActivity?: GcMetrics[];
  alerts: string[];
}

// ── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  SAMPLE_INTERVAL_MS: 30_000,           // Every 30 seconds
  MEMORY_ALERT_THRESHOLD_PERCENT: 85,   // >85% = critical alert
  GC_PAUSE_WARNING_MS: 1_000,            // >1s = warning alert
  GC_COLLECTION_WINDOW_MS: 30_000,       // Collect GC events within 30s window
};

// ── State ────────────────────────────────────────────────────────────────────

let monitoringTimer: ReturnType<typeof setInterval> | null = null;
let lastCpuUsage = process.cpuUsage();
let connectionGetters: {
  getDbConnections?: () => number;
  getHttpConnections?: () => number;
  getWebSocketConnections?: () => number;
} = {};
let gcEvents: GcMetrics[] = [];
let perfObserver: PerformanceObserver | null = null;
let lastMemoryAlertPercent = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function emit(event: string, data: Omit<ResourceEvent, 'event' | 'ts'>): void {
  const entry: ResourceEvent = {
    event,
    ts: new Date().toISOString(),
    ...data,
  };
  // Structured JSON to stdout — parseable by Axiom ingestion
  console.log(JSON.stringify({ telemetry: 'resource', ...entry }));
}

function getMemoryMetrics(): MemoryMetrics {
  const usage = process.memoryUsage();
  const heapUsedMB = usage.heapUsed / 1024 / 1024;
  const heapTotalMB = usage.heapTotal / 1024 / 1024;
  const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100;

  return {
    heapUsedMB: Math.round(heapUsedMB * 100) / 100,
    heapTotalMB: Math.round(heapTotalMB * 100) / 100,
    heapUsedPercent: Math.round(heapUsedPercent * 100) / 100,
    rssMemoryMB: Math.round((usage.rss / 1024 / 1024) * 100) / 100,
    externalMB: Math.round((usage.external / 1024 / 1024) * 100) / 100,
  };
}

function getCpuMetrics(): CpuMetrics {
  const cpuUsage = process.cpuUsage();
  const userDelta = (cpuUsage.user - lastCpuUsage.user) / 1000;  // Convert to ms
  const systemDelta = (cpuUsage.system - lastCpuUsage.system) / 1000;

  lastCpuUsage = cpuUsage;

  return {
    userTimeMs: Math.round(userDelta * 100) / 100,
    systemTimeMs: Math.round(systemDelta * 100) / 100,
  };
}

function getConnectionMetrics(): ConnectionMetrics {
  return {
    activeDbConnections: connectionGetters.getDbConnections?.() ?? 0,
    activeHttpConnections: connectionGetters.getHttpConnections?.() ?? 0,
    activeWebSocketConnections: connectionGetters.getWebSocketConnections?.() ?? 0,
  };
}

function checkAlerts(memory: MemoryMetrics, gcActivity: GcMetrics[]): string[] {
  const alerts: string[] = [];

  // Memory alert
  if (memory.heapUsedPercent > CONFIG.MEMORY_ALERT_THRESHOLD_PERCENT) {
    if (memory.heapUsedPercent > lastMemoryAlertPercent) {
      alerts.push(
        `[resource-alert] CRITICAL: Heap usage at ${memory.heapUsedPercent.toFixed(1)}% ` +
        `(${memory.heapUsedMB.toFixed(1)}MB / ${memory.heapTotalMB.toFixed(1)}MB)`
      );
      lastMemoryAlertPercent = memory.heapUsedPercent;
    }
  } else {
    lastMemoryAlertPercent = 0;  // Reset alert once cleared
  }

  // GC pause alerts
  for (const gc of gcActivity) {
    if (gc.durationMs > CONFIG.GC_PAUSE_WARNING_MS) {
      alerts.push(
        `[resource-alert] GC PAUSE WARNING: ${gc.durationMs.toFixed(1)}ms ` +
        `(kind=${gc.kind})`
      );
    }
  }

  return alerts;
}

function setupGcObserver(): void {
  if (perfObserver) return;

  try {
    perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'gc' && 'duration' in entry && 'kind' in entry) {
          const gcEntry = entry as any;
          gcEvents.push({
            kind: gcEntry.kind ?? 'unknown',
            durationMs: Math.round(gcEntry.duration * 100) / 100,
            flags: gcEntry.flags ?? 0,
          });
        }
      }
    });

    perfObserver.observe({ entryTypes: ['gc'], buffered: false });
  } catch (err) {
    // GC observation not available in all environments
    console.warn('[resource-telemetry] GC observation not available:', err instanceof Error ? err.message : String(err));
  }
}

function collectAndEmitMetrics(): void {
  const t0 = performance.now();

  const memory = getMemoryMetrics();
  const cpu = getCpuMetrics();
  const connections = getConnectionMetrics();

  // Collect GC events from the last sampling window
  const gcActivity = gcEvents.splice(0);

  // Check for alerts
  const alerts = checkAlerts(memory, gcActivity);

  // Emit event
  emit('resource.sample', {
    memory,
    cpu,
    connections,
    gcActivity: gcActivity.length > 0 ? gcActivity : undefined,
    alerts,
  });

  // Log alerts to stderr for visibility
  for (const alert of alerts) {
    console.error(alert);
  }

  // Monitor overhead
  const overheadMs = performance.now() - t0;
  if (overheadMs > 1) {
    console.warn(
      `[telemetry-overhead] Resource sampling took ${overheadMs.toFixed(3)}ms (target <1ms)`
    );
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export const resourceTelemetry = {
  /**
   * Start periodic resource monitoring.
   * Call once at server startup.
   *
   * @param getters - Optional connection count getters. If not provided, connections default to 0.
   */
  startMonitoring(getters?: {
    getDbConnections?: () => number;
    getHttpConnections?: () => number;
    getWebSocketConnections?: () => number;
  }): void {
    setupGcObserver();

    if (getters) {
      connectionGetters = getters;
    }

    if (monitoringTimer) {
      clearInterval(monitoringTimer);
    }

    // Initial sample
    collectAndEmitMetrics();

    // Periodic sampling
    monitoringTimer = setInterval(collectAndEmitMetrics, CONFIG.SAMPLE_INTERVAL_MS);
  },

  /**
   * Stop periodic monitoring (for graceful shutdown).
   */
  stopMonitoring(): void {
    if (monitoringTimer) {
      clearInterval(monitoringTimer);
      monitoringTimer = null;
    }

    if (perfObserver) {
      perfObserver.disconnect();
      perfObserver = null;
    }

    gcEvents.length = 0;
    connectionGetters = {};
    lastMemoryAlertPercent = 0;
  },

  /**
   * Manually trigger a resource snapshot (for testing or ad-hoc monitoring).
   */
  captureSnapshot(): ResourceEvent {
    const memory = getMemoryMetrics();
    const cpu = getCpuMetrics();
    const connections = getConnectionMetrics();
    const gcActivity = gcEvents.splice(0);
    const alerts = checkAlerts(memory, gcActivity);

    return {
      event: 'resource.snapshot',
      ts: new Date().toISOString(),
      memory,
      cpu,
      connections,
      gcActivity: gcActivity.length > 0 ? gcActivity : undefined,
      alerts,
    };
  },

  // For testing: reset all state
  _resetTelemetry(): void {
    if (monitoringTimer) {
      clearInterval(monitoringTimer);
      monitoringTimer = null;
    }
    if (perfObserver) {
      perfObserver.disconnect();
      perfObserver = null;
    }
    gcEvents.length = 0;
    connectionGetters = {};
    lastMemoryAlertPercent = 0;
    lastCpuUsage = process.cpuUsage();
  },
};

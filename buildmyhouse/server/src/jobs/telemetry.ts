/**
 * Job queue telemetry — lightweight server-side instrumentation for background jobs.
 *
 * Tracks: job queued, started, completed; queue depth monitoring.
 * Overhead: <1ms per operation (console.log only, no I/O blocking).
 *
 * Events emitted via structured JSON to stdout for Axiom ingestion.
 */

export interface JobEvent {
  event: string
  ts: string
  jobType: string
  jobId?: string
  queueDepth?: number
  waitDurationMs?: number
  durationMs?: number
  success?: boolean
  errorMsg?: string
}

let queueDepthTimer: ReturnType<typeof setInterval> | null = null
let queueDepthGetter: (() => number) | null = null
let lastAlertDepth = 0

const ALERT_THRESHOLD = 100
const DEPTH_CHECK_INTERVAL_MS = 60_000

function emit(event: string, data: Omit<JobEvent, 'event' | 'ts'>): void {
  const entry: JobEvent = {
    event,
    ts: new Date().toISOString(),
    ...data,
  }
  // Structured JSON to stdout — parseable by Axiom ingestion
  console.log(JSON.stringify({ telemetry: 'job', ...entry }))
}

function checkQueueDepth(): void {
  if (!queueDepthGetter) return
  const depth = queueDepthGetter()
  if (depth > ALERT_THRESHOLD && depth > lastAlertDepth) {
    emit('job.queue_depth_alert', { jobType: 'render', queueDepth: depth })
    lastAlertDepth = depth
  } else if (depth <= ALERT_THRESHOLD) {
    lastAlertDepth = 0 // reset alert once cleared
  }
}

export const jobTelemetry = {
  /** Start periodic queue depth monitoring. Call once at server start. */
  startMonitoring(getQueueDepth: () => number): void {
    queueDepthGetter = getQueueDepth
    if (queueDepthTimer) clearInterval(queueDepthTimer)
    queueDepthTimer = setInterval(checkQueueDepth, DEPTH_CHECK_INTERVAL_MS)
  },

  /** Stop periodic monitoring (for graceful shutdown). */
  stopMonitoring(): void {
    if (queueDepthTimer) {
      clearInterval(queueDepthTimer)
      queueDepthTimer = null
    }
    queueDepthGetter = null
  },

  /** A job was added to the queue. */
  jobQueued(jobType: string, queueDepth: number): void {
    emit('job.queued', { jobType, queueDepth })
  },

  /** A job started processing. waitDurationMs = time from enqueue to start. */
  jobStarted(jobType: string, jobId: string, waitDurationMs: number): void {
    emit('job.started', { jobType, jobId, waitDurationMs })
  },

  /** A job completed (success or failure). */
  jobCompleted(jobType: string, jobId: string, durationMs: number, success: boolean, errorMsg?: string): void {
    emit('job.completed', { jobType, jobId, durationMs, success, errorMsg })
  },
}

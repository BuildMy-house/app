/**
 * render-queue.ts — Server-side render job queue for photorealistic exports.
 *
 * Manages background render jobs (LuxCoreRender, path tracing, etc.).
 * Optional premium feature: users can queue high-quality renders instead of
 * instant client-side previews. Jobs processed in background, results cached.
 *
 * No database needed: in-memory queue + filesystem storage.
 * Scales: supports 1-2 concurrent renders even on tiny servers.
 */

import { randomUUID } from 'node:crypto'
import { jobTelemetry } from './jobs/telemetry.js'

export interface NormalizedHomeState {
  // Minimal interface for render queue; full type defined in client
  [key: string]: unknown
}

export type RenderJobStatus = 'pending' | 'processing' | 'complete' | 'failed'

export interface RenderJob {
  id: string
  userId: string
  homeId: string
  homeName: string
  homeJson: NormalizedHomeState
  status: RenderJobStatus
  quality: 'quick' | 'standard' | 'ultra' // Affects render time
  createdAt: number
  startedAt?: number
  completedAt?: number
  resultPath?: string // Path to saved render on disk
  error?: string
}

/**
 * In-memory render queue and job manager.
 * Processes jobs sequentially (1-2 concurrent renders max on small servers).
 */
export class RenderQueue {
  private jobs = new Map<string, RenderJob>()
  private queue: string[] = [] // Job IDs in order
  private processing = false
  private maxConcurrent = 1 // Start 1 render at a time; increase if server has headroom

  /**
   * Add a render job to the queue.
   * Returns job ID immediately; client polls for status.
   */
  enqueue(userId: string, homeId: string, homeName: string, home: NormalizedHomeState, quality = 'standard'): string {
    const id = randomUUID()
    const job: RenderJob = {
      id,
      userId,
      homeId,
      homeName,
      homeJson: home,
      status: 'pending',
      quality: quality as 'quick' | 'standard' | 'ultra',
      createdAt: Date.now(),
    }
    this.jobs.set(id, job)
    this.queue.push(id)
    jobTelemetry.jobQueued('render', this.queue.length)
    this.processQueue() // Start processing if idle
    return id
  }

  /**
   * Get a job by ID (visible only to the job's owner).
   */
  getJob(jobId: string, userId: string): RenderJob | null {
    const job = this.jobs.get(jobId)
    if (!job || job.userId !== userId) return null
    return job
  }

  /**
   * List all jobs for a user (for status dashboard).
   */
  getUserJobs(userId: string): RenderJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.userId === userId)
  }

  /**
   * Process the queue: take next pending job and start render.
   * Runs sequentially; only 1-2 renders at a time to avoid overwhelming small servers.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return

    this.processing = true
    while (this.queue.length > 0) {
      const jobId = this.queue.shift()
      if (!jobId) break

      const job = this.jobs.get(jobId)
      if (!job) continue

      job.status = 'processing'
      job.startedAt = Date.now()
      jobTelemetry.jobStarted('render', jobId, job.startedAt - job.createdAt)

      try {
        // TODO: Integrate actual render engine here (LuxCoreRender, Cycles, etc.)
        // For now: placeholder that simulates a render job
        await this.renderPlaceholder(job)
        job.status = 'complete'
        job.completedAt = Date.now()
        jobTelemetry.jobCompleted('render', jobId, job.completedAt - job.startedAt!, true)
        console.log(`[render-queue] job ${jobId} complete`)
      } catch (error) {
        job.status = 'failed'
        job.error = String(error)
        job.completedAt = Date.now()
        jobTelemetry.jobCompleted('render', jobId, job.completedAt - job.startedAt!, false, job.error)
        console.error(`[render-queue] job ${jobId} failed: ${job.error}`)
      }
    }
    this.processing = false
  }

  /**
   * Placeholder render: in production, call LuxCoreRender or other engine.
   * For now: just logs that render would happen.
   */
  private async renderPlaceholder(job: RenderJob): Promise<void> {
    // Simulate render time based on quality setting
    const delayMs = {
      quick: 1000, // 1s placeholder
      standard: 3000, // 3s placeholder
      ultra: 10000, // 10s placeholder
    }[job.quality]

    return new Promise((resolve) => {
      setTimeout(() => {
        // In production: save actual render to disk here
        job.resultPath = `/tmp/render-${job.id}.png`
        resolve()
      }, delayMs)
    })
  }

  /**
   * Get queue status: how many jobs pending/processing.
   */
  getStatus(): { pending: number; processing: number; averageWaitMs: number } {
    const allJobs = Array.from(this.jobs.values())
    const pending = allJobs.filter((j) => j.status === 'pending').length
    const processing = allJobs.filter((j) => j.status === 'processing').length

    // Estimate wait time: average render time × pending jobs
    const avgRenderTime = {
      quick: 1000,
      standard: 3000,
      ultra: 10000,
    }
    const totalWaitMs = allJobs
      .filter((j) => j.status === 'pending' || j.status === 'processing')
      .reduce((sum, j) => sum + avgRenderTime[j.quality as keyof typeof avgRenderTime], 0)

    return {
      pending,
      processing,
      averageWaitMs: totalWaitMs,
    }
  }
}

// Global singleton queue instance
export const renderQueue = new RenderQueue()

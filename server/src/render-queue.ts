/**
 * render-queue.ts — Server-side render job queue for photorealistic exports.
 *
 * Manages background render jobs (LuxCoreRender, path tracing, etc.).
 * Users queue final LuxCore renders (or catalog thumbnails) instead of
 * rendering them in the browser. Jobs are processed in the worker background.
 *
 * No database needed: in-memory queue + filesystem storage.
 * Scales: supports 1-2 concurrent renders even on tiny servers.
 */

import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { jobTelemetry } from './jobs/telemetry.js'

interface NormalizedHomeState {
  // Minimal interface for render queue; full type defined in client
  [key: string]: unknown
}

type RenderProfile = 'thumbnail' | 'low' | 'medium' | 'high'
type RenderJobStatus = 'pending' | 'processing' | 'complete' | 'failed'

interface RenderJob {
  id: string
  userId: string
  homeId: string
  homeName: string
  homeJson: NormalizedHomeState
  status: RenderJobStatus
  quality: RenderProfile
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
class RenderQueue {
  private static readonly MAX_RETAINED_JOBS = 100
  private jobs = new Map<string, RenderJob>()
  private queue: string[] = [] // Job IDs in order
  private processing = false
  private readonly workerUrl = (process.env.LUXCORE_WORKER_URL ?? '').replace(/\/$/, '')
  private readonly workerToken = process.env.LUXCORE_WORKER_TOKEN ?? ''
  private readonly renderRoot = process.env.RENDER_DIR ?? 'data/renders'

  /**
   * Add a render job to the queue.
   * Returns job ID immediately; client polls for status.
   */
  enqueue(userId: string, homeId: string, homeName: string, home: NormalizedHomeState, quality: RenderProfile = 'medium'): string {
    if (!this.workerUrl || !this.workerToken) throw new Error('LuxCore worker is not configured')
    const id = randomUUID()
    const job: RenderJob = {
      id,
      userId,
      homeId,
      homeName,
      homeJson: home,
      status: 'pending',
      quality,
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
        await this.renderWithWorker(job)
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
      this.pruneJobs()
    }
    this.processing = false
  }

  /**
   * Submit one job to the worker, poll it, and cache the PNG locally.
   */
  private async renderWithWorker(job: RenderJob): Promise<void> {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.workerToken}` }
    const submitted = await fetch(`${this.workerUrl}/api/render/jobs/${job.userId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ scene: job.homeJson, home: job.homeJson, profile: job.quality }),
    })
    if (!submitted.ok) throw new Error(`LuxCore submit failed: ${submitted.status}`)
    const remote = (await submitted.json()) as { id: string }
    let pollDelayMs = 1000
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs))
      pollDelayMs = Math.min(pollDelayMs * 1.5, 5000)
      const response = await fetch(`${this.workerUrl}/api/render/jobs/${job.userId}/${remote.id}`, { headers })
      if (!response.ok) throw new Error(`LuxCore status failed: ${response.status}`)
      const status = (await response.json()) as { status: string; error?: string }
      if (status.status === 'failed') throw new Error(status.error ?? 'LuxCore render failed')
      if (status.status !== 'completed') continue
      const artifact = await fetch(`${this.workerUrl}/api/render/jobs/${job.userId}/${remote.id}/artifact`, { headers })
      if (!artifact.ok) throw new Error(`LuxCore artifact failed: ${artifact.status}`)
      mkdirSync(this.renderRoot, { recursive: true })
      const path = join(this.renderRoot, `${job.id}.png`)
      if (!artifact.body) throw new Error('LuxCore artifact had no body')
      await pipeline(Readable.fromWeb(artifact.body as never), createWriteStream(path))
      job.resultPath = path
      return
    }
  }

  private pruneJobs(): void {
    if (this.jobs.size <= RenderQueue.MAX_RETAINED_JOBS) return
    const removable = [...this.jobs.values()]
      .filter((job) => job.status === 'complete' || job.status === 'failed')
      .sort((a, b) => a.createdAt - b.createdAt)
    while (this.jobs.size > RenderQueue.MAX_RETAINED_JOBS && removable.length > 0) {
      const job = removable.shift()!
      this.jobs.delete(job.id)
      if (job.resultPath) {
        try { unlinkSync(job.resultPath) } catch { /* already gone */ }
      }
    }
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
      thumbnail: 60_000,
      low: 300_000,
      medium: 600_000,
      high: 1_800_000,
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

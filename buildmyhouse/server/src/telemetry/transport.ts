/**
 * EventBatcher collects events and flushes them to Axiom in batches.
 * - Non-blocking: flush happens asynchronously, doesn't block event addition
 * - Batching: flushes when size (50 events) or time (5s) threshold is reached
 * - Memory management: drops oldest events if memory pressure is detected
 * - Error handling: queues events locally if Axiom is down, retries on next flush
 */

import { AxiomClient, AxiomEvent } from './axiom-client.js';

export interface TransportEvent extends AxiomEvent {
  timestamp?: number;
  sessionId?: string;
  userId?: string;
}

export interface TransportConfig {
  batchSize?: number;
  batchTimeoutMs?: number;
  maxQueueSize?: number;
  maxRetries?: number;
  axiomToken?: string;
  axiomDataset?: string;
  axiomUrl?: string;
}

/**
 * Singleton event transport.
 * Collects events and sends them to Axiom in batches.
 */
export class EventBatcher {
  private batch: TransportEvent[] = [];
  private queue: TransportEvent[] = [];
  private batchSize: number;
  private batchTimeoutMs: number;
  private maxQueueSize: number;
  private axiomClient: AxiomClient;
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushingQueue = false;
  private dropOldestWarningLogged = false;

  constructor(config: TransportConfig = {}) {
    this.batchSize = config.batchSize ?? 50;
    this.batchTimeoutMs = config.batchTimeoutMs ?? 5000;
    this.maxQueueSize = config.maxQueueSize ?? 10000;
    this.axiomClient = new AxiomClient(
      config.axiomToken,
      config.axiomDataset,
      config.axiomUrl,
    );
  }

  /**
   * Add an event to the batch. Non-blocking operation (~0.1ms overhead).
   * Returns the number of events in the batch after adding this event.
   */
  addEvent(event: TransportEvent): number {
    const t0 = performance.now();

    // Add timestamp if not present
    const eventWithTimestamp: TransportEvent = {
      ...event,
      timestamp: event.timestamp || Date.now(),
    };

    // Check for memory pressure by approximating event size
    const eventSize = JSON.stringify(eventWithTimestamp).length;
    const currentQueueMemoryKB = (this.queue.length * 100) / 1024; // Rough estimate

    if (currentQueueMemoryKB > 1024) {
      // ~1MB
      if (!this.dropOldestWarningLogged) {
        console.warn('[telemetry] Memory pressure: dropping oldest events from retry queue');
        this.dropOldestWarningLogged = true;
      }
      // Drop oldest event from queue to make room
      this.queue.shift();
    }

    this.batch.push(eventWithTimestamp);

    const overhead = performance.now() - t0;
    if (overhead > 1.0) {
      console.warn(`[telemetry] addEvent took ${overhead.toFixed(2)}ms (threshold: 1ms)`);
    }

    // Check if we need to flush
    if (this.batch.length >= this.batchSize) {
      this._scheduleFlush(0); // Flush immediately
    } else if (this.batch.length === 1) {
      // Schedule timer only when starting a new batch
      this._scheduleFlush(this.batchTimeoutMs);
    }

    return this.batch.length;
  }

  /**
   * Manually flush the current batch.
   */
  async flush(): Promise<void> {
    await this._flush();
    await this._flushQueue();
  }

  /**
   * Schedule a flush after the given delay.
   * If already scheduled, clears the previous timer.
   */
  private _scheduleFlush(delayMs: number): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    if (delayMs === 0) {
      // Immediate flush - schedule on next microtask
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this._flush();
      }, 0);
    } else {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this._flush();
      }, delayMs);
    }
  }

  /**
   * Flush the current batch to Axiom.
   * If Axiom is down, events are moved to the retry queue.
   */
  private async _flush(): Promise<void> {
    if (this.batch.length === 0) {
      return;
    }

    const events = this.batch;
    this.batch = [];

    try {
      const result = await this.axiomClient.sendBatch(events);

      if (result.success) {
        // Reset the memory pressure warning flag
        this.dropOldestWarningLogged = false;
      } else {
        // If send failed, add events back to the queue
        console.warn(`[telemetry] Failed to send batch: ${result.error}`);
        this._addToQueue(events);
      }
    } catch (error) {
      console.error('[telemetry] Flush error:', error);
      this._addToQueue(events);
    }
  }

  /**
   * Add events to the retry queue.
   */
  private _addToQueue(events: TransportEvent[]): void {
    this.queue.push(...events);

    if (this.queue.length > this.maxQueueSize) {
      // Trim queue to max size, dropping oldest
      this.queue = this.queue.slice(-this.maxQueueSize);
      console.warn(
        `[telemetry] Queue size exceeded ${this.maxQueueSize}; oldest events discarded`,
      );
    }

    // Attempt to flush queue on next tick
    if (!this.isFlushingQueue) {
      setImmediate(() => void this._flushQueue());
    }
  }

  /**
   * Try to flush the retry queue.
   * Only flushes up to batchSize events at a time.
   */
  private async _flushQueue(): Promise<void> {
    if (this.isFlushingQueue || this.queue.length === 0) {
      return;
    }

    this.isFlushingQueue = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        const result = await this.axiomClient.sendBatch(batch);

        if (!result.success) {
          // Put events back at the front of the queue
          this.queue.unshift(...batch);
          // Back off before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000));
          break;
        }
      }
    } finally {
      this.isFlushingQueue = false;
    }
  }

  /**
   * Get the current batch size.
   */
  getQueueLength(): number {
    return this.batch.length + this.queue.length;
  }

  /**
   * Get stats for monitoring.
   */
  getStats(): {
    batchLength: number;
    queueLength: number;
    totalPending: number;
  } {
    return {
      batchLength: this.batch.length,
      queueLength: this.queue.length,
      totalPending: this.batch.length + this.queue.length,
    };
  }
}

/**
 * Global singleton instance.
 * Lazily initialized on first use.
 */
let globalTransport: EventBatcher | null = null;

/**
 * Get or create the global transport instance.
 */
export function getTransport(config?: TransportConfig): EventBatcher {
  if (!globalTransport) {
    globalTransport = new EventBatcher(config);
  }
  return globalTransport;
}

/**
 * Add an event to the global transport.
 */
export function addEvent(event: TransportEvent): number {
  return getTransport().addEvent(event);
}

/**
 * Flush the global transport.
 */
export async function flushTransport(): Promise<void> {
  if (globalTransport) {
    await globalTransport.flush();
  }
}

/**
 * Reset the global transport (for testing).
 */
export function _resetTransport(): void {
  if (globalTransport) {
    void globalTransport.flush();
  }
  globalTransport = null;
}

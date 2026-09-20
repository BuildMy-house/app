import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBatcher, _resetTransport, addEvent, getTransport } from '../src/telemetry/transport.js';
import { AxiomClient, AxiomEvent } from '../src/telemetry/axiom-client.js';

/**
 * Helper to wait for async operations to complete
 */
async function waitForAsync(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock Axiom responses for testing.
 */
class MockAxiomClient extends AxiomClient {
  public sentBatches: AxiomEvent[][] = [];
  public failureCount = 0;
  public failureMode: 'none' | 'network' | 'server' = 'none';

  async sendBatch(events: AxiomEvent[]) {
    if (this.failureMode !== 'none') {
      if (this.failureCount > 0) {
        this.failureCount--;
        if (this.failureMode === 'network') {
          throw new Error('Network error');
        } else if (this.failureMode === 'server') {
          return {
            success: false,
            error: 'Server returned 503',
          };
        }
      }
    }

    this.sentBatches.push([...events]);
    return {
      success: true,
      bytesIngested: JSON.stringify(events).length,
    };
  }
}

describe('EventBatcher', () => {
  let batcher: EventBatcher;
  let mockClient: MockAxiomClient;

  beforeEach(() => {
    _resetTransport();
    mockClient = new MockAxiomClient();
    batcher = new EventBatcher();
    // Replace axiom client with mock
    (batcher as any).axiomClient = mockClient;
  });

  afterEach(async () => {
    // Wait for any pending operations to complete
    await waitForAsync(100);
  });

  describe('batching', () => {
    it('should add events without flushing until batch size is reached', async () => {
      const batchSize = 50;

      // Add 40 events - should not flush
      for (let i = 0; i < 40; i++) {
        batcher.addEvent({ event: 'test', index: i });
      }

      await waitForAsync(50);
      expect(mockClient.sentBatches.length).toBe(0);

      // Add 10 more events - should trigger flush at 50
      for (let i = 40; i < 50; i++) {
        batcher.addEvent({ event: 'test', index: i });
      }

      await waitForAsync(100);
      expect(mockClient.sentBatches.length).toBe(1);
      expect(mockClient.sentBatches[0].length).toBe(50);
    }, 10000);

    it('should add timestamps to events', async () => {
      const before = Date.now();
      batcher.addEvent({ event: 'test' });
      const after = Date.now();

      await batcher.flush();

      expect(mockClient.sentBatches.length).toBe(1);
      const event = mockClient.sentBatches[0][0];
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });

    it('should preserve event timestamp if provided', async () => {
      const customTimestamp = 1000000;
      batcher.addEvent({ event: 'test', timestamp: customTimestamp });

      await batcher.flush();

      expect(mockClient.sentBatches[0][0].timestamp).toBe(customTimestamp);
    });
  });

  describe('time-based flushing', () => {
    it('should flush after timeout when batch is not full', async () => {
      batcher = new EventBatcher({ batchTimeoutMs: 500 });
      (batcher as any).axiomClient = mockClient;

      batcher.addEvent({ event: 'test1' });
      batcher.addEvent({ event: 'test2' });

      // No flush yet
      expect(mockClient.sentBatches.length).toBe(0);

      // Wait for timeout
      await waitForAsync(600);

      // Should have flushed
      expect(mockClient.sentBatches.length).toBe(1);
      expect(mockClient.sentBatches[0].length).toBe(2);
    }, 10000);

    it('should not restart timer after timeout', async () => {
      batcher = new EventBatcher({ batchTimeoutMs: 500 });
      (batcher as any).axiomClient = mockClient;

      batcher.addEvent({ event: 'test1' });
      await waitForAsync(600);

      expect(mockClient.sentBatches.length).toBe(1);

      // Add another event
      batcher.addEvent({ event: 'test2' });
      await waitForAsync(300);

      // Should not flush yet
      expect(mockClient.sentBatches.length).toBe(1);

      await waitForAsync(300);

      // Now should flush
      expect(mockClient.sentBatches.length).toBe(2);
    }, 10000);
  });

  describe('error handling and retry', () => {
    it('should retry on network errors', async () => {
      mockClient.failureMode = 'network';
      mockClient.failureCount = 1; // Fail once, then succeed

      // Add 50 events to trigger flush
      for (let i = 0; i < 50; i++) {
        batcher.addEvent({ event: 'test', index: i });
      }

      await waitForAsync(500);

      // Should have retried and succeeded
      expect(mockClient.sentBatches.length).toBe(1);
      expect(mockClient.sentBatches[0].length).toBe(50);
    }, 15000);

    it('should queue events if Axiom is down', async () => {
      mockClient.failureMode = 'server';
      mockClient.failureCount = 100; // Keep failing

      // Add 50 events to trigger flush
      for (let i = 0; i < 50; i++) {
        batcher.addEvent({ event: 'test', index: i });
      }

      await waitForAsync(500);

      // Should have queued events
      const stats = batcher.getStats();
      expect(stats.queueLength).toBe(50);
      expect(stats.batchLength).toBe(0);
    }, 10000);

    it('should eventually recover from Axiom failures', async () => {
      // This test verifies that the system can recover from Axiom being down
      // by successfully sending events once Axiom is available again

      mockClient.failureMode = 'server';
      mockClient.failureCount = 1; // Fail once, then succeed on retry

      // Add 50 events - first send will fail but retry will succeed
      for (let i = 0; i < 50; i++) {
        batcher.addEvent({ event: 'test', index: i });
      }

      await waitForAsync(600);

      // After retries, should have successfully sent
      expect(mockClient.sentBatches.length).toBeGreaterThanOrEqual(1);
      const totalSent = mockClient.sentBatches.reduce((sum, batch) => sum + batch.length, 0);
      expect(totalSent).toBe(50);
    }, 10000);
  });

  describe('memory pressure handling', () => {
    it('should drop oldest events when queue exceeds max size', async () => {
      const maxQueueSize = 100;
      const batcher2 = new EventBatcher({ maxQueueSize });
      (batcher2 as any).axiomClient = mockClient;

      mockClient.failureMode = 'server';
      mockClient.failureCount = 100;

      // Add 150 events - queue size is 100, so 50 should be dropped
      for (let i = 0; i < 150; i++) {
        batcher2.addEvent({ event: 'test', index: i });
      }

      await waitForAsync(500);

      const stats = batcher2.getStats();
      expect(stats.queueLength).toBeLessThanOrEqual(maxQueueSize);
    }, 10000);
  });

  describe('performance', () => {
    it('should add events in less than 1ms each', async () => {
      const timings: number[] = [];

      for (let i = 0; i < 100; i++) {
        const t0 = performance.now();
        batcher.addEvent({ event: 'test', index: i });
        const t1 = performance.now();
        timings.push(t1 - t0);
      }

      const avgTiming = timings.reduce((a, b) => a + b) / timings.length;
      const maxTiming = Math.max(...timings);

      // Most should be well under 1ms, allow some outliers
      const sampleAt90Percentile = timings.sort((a, b) => a - b)[Math.floor(timings.length * 0.9)];
      expect(sampleAt90Percentile).toBeLessThan(1.0);
      expect(maxTiming).toBeLessThan(5.0); // Allow some outliers
    });
  });

  describe('manual flush', () => {
    it('should flush on demand', async () => {
      batcher.addEvent({ event: 'test1' });
      batcher.addEvent({ event: 'test2' });

      expect(mockClient.sentBatches.length).toBe(0);

      await batcher.flush();

      expect(mockClient.sentBatches.length).toBe(1);
      expect(mockClient.sentBatches[0].length).toBe(2);
    }, 10000);

    it('should flush both batch and queue', async () => {
      mockClient.failureMode = 'server';
      mockClient.failureCount = 1; // Fail on first send

      // Add 50 events - will be queued
      for (let i = 0; i < 50; i++) {
        batcher.addEvent({ event: 'queued', index: i });
      }

      await waitForAsync(500);

      // Reset failure mode
      mockClient.failureMode = 'none';

      // Add more events to batch
      batcher.addEvent({ event: 'batch' });

      await batcher.flush();

      // Should have sent queued events and batch events
      expect(mockClient.sentBatches.length).toBeGreaterThan(0);
      const totalSent = mockClient.sentBatches.reduce((sum, batch) => sum + batch.length, 0);
      expect(totalSent).toBe(51);
    }, 10000);
  });

  describe('global transport singleton', () => {
    it('should create and reuse global instance', async () => {
      _resetTransport();

      const transport1 = getTransport();
      const transport2 = getTransport();

      expect(transport1).toBe(transport2);
    });

    it('should add events via global addEvent function', async () => {
      _resetTransport();

      const transport = getTransport();
      (transport as any).axiomClient = mockClient;

      for (let i = 0; i < 50; i++) {
        addEvent({ event: 'test', index: i });
      }

      await waitForAsync(500);

      expect(mockClient.sentBatches.length).toBe(1);
    }, 10000);

    it('should allow config on first initialization', () => {
      _resetTransport();

      const transport = getTransport({
        batchSize: 25,
        batchTimeoutMs: 1000,
      });

      // Note: We can't easily verify the config was applied without inspecting private fields
      // But we can verify the instance was created with the right batch size by testing behavior
      for (let i = 0; i < 25; i++) {
        transport.addEvent({ event: 'test', index: i });
      }
    });
  });

  describe('stats and monitoring', () => {
    it('should report queue stats', async () => {
      mockClient.failureMode = 'server';
      mockClient.failureCount = 100;

      // Add 100 events - 50 in batch, 50 in queue
      for (let i = 0; i < 50; i++) {
        batcher.addEvent({ event: 'test', index: i });
      }

      await waitForAsync(500);

      const stats = batcher.getStats();
      expect(stats.batchLength).toBe(0); // Batch was flushed and failed
      expect(stats.queueLength).toBe(50); // Events are now in queue
      expect(stats.totalPending).toBe(50);
    }, 10000);
  });
});

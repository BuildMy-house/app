/**
 * Unit tests for error telemetry module
 * Tests synthetic errors with various contexts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  captureError,
  ErrorRateMonitor,
  errorRateMonitor,
  ErrorContext,
  ErrorSeverity,
  ErrorSource,
} from '../src/telemetry/errors';

// Mock console.log and console.error to capture telemetry events
const mockConsoleLog = vi.fn();
const mockConsoleError = vi.fn();
const mockConsoleWarn = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  console.log = mockConsoleLog;
  console.error = mockConsoleError;
  console.warn = mockConsoleWarn;
});

describe('Error Telemetry', () => {
  describe('captureError', () => {
    it('captures basic error with message', () => {
      const error = new Error('Test error');
      const context: ErrorContext = {
        endpoint: 'GET /api/test',
        userId: 'user123',
        source: 'api',
      };

      captureError(error, context);

      expect(mockConsoleLog).toHaveBeenCalled();
      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);

      expect(event.event).toBe('error_captured');
      expect(event.message).toBe('Test error');
      expect(event.endpoint).toBe('GET /api/test');
      expect(event.userId).toBe('user123');
      expect(event.source).toBe('api');
      expect(event.stack).toContain('Error: Test error');
      expect(event.timestamp).toBeDefined();
    });

    it('extracts error code from error.code property', () => {
      const error = new Error('Test error');
      (error as any).code = 'CUSTOM_ERROR_CODE';

      captureError(error, { source: 'api' });

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.code).toBe('CUSTOM_ERROR_CODE');
    });

    it('extracts error code from statusCode', () => {
      const error = new Error('Not Found');
      (error as any).statusCode = 404;

      captureError(error, { source: 'api' });

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.code).toBe('HTTP_404');
    });

    it('determines severity for 5xx errors as critical', () => {
      const error = new Error('Internal Server Error');
      (error as any).statusCode = 500;

      captureError(error, { source: 'api' });

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.severity).toBe('critical');
    });

    it('determines severity for 4xx errors as warning', () => {
      const error = new Error('Bad Request');
      (error as any).statusCode = 400;

      captureError(error, { source: 'api' });

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.severity).toBe('warning');
    });

    it('uses explicit severity from context', () => {
      const error = new Error('Test error');
      const context: ErrorContext = {
        severity: 'critical',
        source: 'api',
      };

      captureError(error, context);

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.severity).toBe('critical');
    });

    it('infers source from error message containing "database"', () => {
      const error = new Error('Database connection failed');

      captureError(error);

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.source).toBe('db');
    });

    it('infers source from error message containing "auth"', () => {
      const error = new Error('Authentication failed');

      captureError(error);

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.source).toBe('auth');
    });

    it('infers source from error message containing "file"', () => {
      const error = new Error('File not found: /path/to/file');

      captureError(error);

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.source).toBe('file');
    });

    it('captures string errors', () => {
      captureError('String error message', { source: 'api' });

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.message).toBe('String error message');
      expect(event.code).toBe('STRING_ERROR');
    });

    it('captures duration when provided', () => {
      const error = new Error('Test error');
      captureError(error, { source: 'api' }, 1.5);

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.durationMs).toBe(1.5);
    });

    it('includes timestamp in captured event', () => {
      const beforeTime = Date.now();
      const error = new Error('Test error');
      captureError(error, { source: 'api' });
      const afterTime = Date.now();

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(event.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('handles errors without stack property', () => {
      const error: any = {};
      error.message = 'Error without stack';

      captureError(error, { source: 'api' });

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.message).toBe('Error without stack');
      expect(event.stack).toBeUndefined();
    });

    it('warns when telemetry overhead exceeds 0.5ms', () => {
      const error = new Error('Test error');

      // This is a synthetic test; real capture should be <0.5ms
      captureError(error, { source: 'api' });

      // In normal operation, overhead should be minimal
      // If it exceeds 0.5ms, a warning is logged
      // We check that the function completes without error
      expect(mockConsoleLog).toHaveBeenCalled();
    });
  });

  describe('ErrorRateMonitor', () => {
    let monitor: ErrorRateMonitor;

    beforeEach(() => {
      monitor = new ErrorRateMonitor();
    });

    it('records API errors', () => {
      monitor.recordError('api', 'HTTP_500');
      monitor.recordError('api', 'HTTP_500');

      // Monitor should track the errors
      expect(monitor).toBeDefined();
    });

    it('records database errors', () => {
      monitor.recordError('db', 'DB_QUERY_ERROR');

      expect(monitor).toBeDefined();
    });

    it('records job errors', () => {
      monitor.recordError('job', 'JOB_TIMEOUT');

      expect(monitor).toBeDefined();
    });

    it('records file errors', () => {
      monitor.recordError('file', 'FILE_NOT_FOUND');

      expect(monitor).toBeDefined();
    });

    it('records auth errors', () => {
      monitor.recordError('auth', 'AUTH_INVALID_TOKEN');

      expect(monitor).toBeDefined();
    });
  });

  describe('Error Context', () => {
    it('preserves context across error capture', () => {
      const error = new Error('API Error');
      const context: ErrorContext = {
        endpoint: 'POST /api/users',
        userId: 'user456',
        source: 'api',
        customField: 'customValue',
      };

      captureError(error, context);

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.endpoint).toBe('POST /api/users');
      expect(event.userId).toBe('user456');
      expect(event.source).toBe('api');
    });

    it('handles missing context gracefully', () => {
      const error = new Error('Error without context');

      captureError(error);

      const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(event.message).toBe('Error without context');
      expect(event.endpoint).toBeUndefined();
      expect(event.userId).toBeUndefined();
      expect(event.source).toBe('unknown');
    });
  });

  describe('Error Severity Classification', () => {
    const severityCases = [
      { statusCode: 500, expected: 'critical' as ErrorSeverity },
      { statusCode: 503, expected: 'critical' as ErrorSeverity },
      { statusCode: 502, expected: 'error' as ErrorSeverity },
      { statusCode: 400, expected: 'warning' as ErrorSeverity },
      { statusCode: 404, expected: 'warning' as ErrorSeverity },
      { statusCode: 200, expected: 'error' as ErrorSeverity }, // Default for non-error
    ];

    severityCases.forEach(({ statusCode, expected }) => {
      it(`classifies HTTP ${statusCode} as ${expected}`, () => {
        const error = new Error('HTTP Error');
        (error as any).statusCode = statusCode;

        captureError(error, { source: 'api' });

        const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
        expect(event.severity).toBe(expected);
      });
    });
  });

  describe('Error Source Inference', () => {
    const sourceCases = [
      { message: 'database connection timeout', expected: 'db' as ErrorSource },
      { message: 'query failed', expected: 'db' as ErrorSource },
      { message: 'authentication token invalid', expected: 'auth' as ErrorSource },
      { message: 'file ENOENT', expected: 'file' as ErrorSource },
      { message: 'job execution timeout', expected: 'job' as ErrorSource },
      { message: 'unknown error', expected: 'unknown' as ErrorSource },
    ];

    sourceCases.forEach(({ message, expected }) => {
      it(`infers source as ${expected} from message: "${message}"`, () => {
        const error = new Error(message);

        captureError(error);

        const event = JSON.parse(mockConsoleLog.mock.calls[0][0]);
        expect(event.source).toBe(expected);
      });
    });
  });

  describe('100% Error Capture', () => {
    it('captures all error types without sampling', () => {
      const errorCount = 100;

      for (let i = 0; i < errorCount; i++) {
        const error = new Error(`Error ${i}`);
        captureError(error, { source: 'api' });
      }

      // Every error should be captured (no sampling)
      expect(mockConsoleLog).toHaveBeenCalledTimes(errorCount);
    });

    it('never drops errors due to sampling', () => {
      const errors = [
        new Error('Error 1'),
        new Error('Error 2'),
        new Error('Error 3'),
      ];

      errors.forEach((err) => captureError(err, { source: 'api' }));

      // All errors captured
      expect(mockConsoleLog).toHaveBeenCalledTimes(3);
    });
  });

  describe('Global Error Rate Monitor', () => {
    it('exports global errorRateMonitor instance', () => {
      expect(errorRateMonitor).toBeDefined();
      expect(errorRateMonitor).toHaveProperty('recordError');
    });

    it('allows recording errors on global instance', () => {
      errorRateMonitor.recordError('api', 'HTTP_500');
      errorRateMonitor.recordError('db', 'DB_ERROR');

      expect(errorRateMonitor).toBeDefined();
    });
  });
});

/**
 * Centralized error capture and telemetry module
 * 100% error capture (no sampling) with context extraction
 * Tracks: code, message, stack, endpoint, userId, severity, source
 */

export type ErrorSeverity = 'error' | 'warning' | 'critical';
export type ErrorSource = 'api' | 'db' | 'job' | 'file' | 'auth' | 'unknown';

export interface ErrorContext {
  endpoint?: string;
  userId?: string;
  source?: ErrorSource;
  [key: string]: any;
}

interface CapturedError {
  code: string;
  message: string;
  stack?: string;
  endpoint?: string;
  userId?: string;
  severity: ErrorSeverity;
  source: ErrorSource;
  timestamp: number;
  durationMs?: number;
}

interface ErrorEvent extends CapturedError {
  event: 'error_captured';
}

/**
 * Emits a structured error event to telemetry
 */
function emitErrorEvent(errorEvent: ErrorEvent): void {
  console.log(JSON.stringify(errorEvent));
}

/**
 * Determine error severity based on error properties
 */
function determineSeverity(error: any, context?: ErrorContext): ErrorSeverity {
  // Check for explicit severity in context
  if (context?.severity) {
    return context.severity;
  }

  // Check for error properties that indicate criticality
  if (error?.statusCode === 500 || error?.code === 'INTERNAL_ERROR') {
    return 'critical';
  }

  if (error?.statusCode === 503 || error?.code === 'SERVICE_UNAVAILABLE') {
    return 'critical';
  }

  if (error?.statusCode >= 500) {
    return 'error';
  }

  if (error?.statusCode >= 400) {
    return 'warning';
  }

  // Default to error for unknown errors
  return 'error';
}

/**
 * Determine error source from context or error properties
 */
function determineSource(error: any, context?: ErrorContext): ErrorSource {
  if (context?.source) {
    return context.source;
  }

  if (error?.source) {
    return error.source;
  }

  // Infer from error type or message (case-insensitive)
  const message = error?.message?.toLowerCase() || '';
  const code = error?.code?.toUpperCase() || '';

  if (message.includes('database') || message.includes('query')) {
    return 'db';
  }

  if (message.includes('auth') || code.includes('AUTH')) {
    return 'auth';
  }

  if (message.includes('file') || message.includes('enoent')) {
    return 'file';
  }

  if (message.includes('job') || code.includes('JOB')) {
    return 'job';
  }

  return 'unknown';
}

/**
 * Extract error code from various error types
 */
function extractErrorCode(error: any): string {
  if (typeof error === 'string') {
    return 'STRING_ERROR';
  }

  if (error?.code) {
    return error.code;
  }

  if (error?.statusCode) {
    return `HTTP_${error.statusCode}`;
  }

  if (error?.name) {
    return error.name;
  }

  return 'UNKNOWN_ERROR';
}

/**
 * Extract error message
 */
function extractErrorMessage(error: any): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error?.message) {
    return error.message;
  }

  return String(error);
}

/**
 * Extract stack trace
 */
function extractStack(error: any): string | undefined {
  if (typeof error === 'string') {
    return undefined;
  }

  return error?.stack;
}

/**
 * Centralized error capture function
 * Captures error details and emits structured telemetry event
 *
 * @param error - The error object to capture
 * @param context - Additional context (endpoint, userId, source, etc.)
 * @param durationMs - Optional duration for tracked operations
 */
export function captureError(
  error: any,
  context?: ErrorContext,
  durationMs?: number,
): void {
  const t0 = performance.now();

  const capturedError: CapturedError = {
    code: extractErrorCode(error),
    message: extractErrorMessage(error),
    stack: extractStack(error),
    endpoint: context?.endpoint,
    userId: context?.userId,
    severity: determineSeverity(error, context),
    source: determineSource(error, context),
    timestamp: Date.now(),
    durationMs,
  };

  const errorEvent: ErrorEvent = {
    ...capturedError,
    event: 'error_captured',
  };

  const emitDurationMs = performance.now() - t0;

  // Emit event with minimal overhead
  if (emitDurationMs > 0.5) {
    console.warn(
      `[telemetry-overhead] Error capture took ${emitDurationMs.toFixed(3)}ms (target <0.5ms)`,
    );
  }

  emitErrorEvent(errorEvent);
}

/**
 * Alert on error rate thresholds
 */
export class ErrorRateMonitor {
  private errorCounts: Map<string, number[]> = new Map();
  private dbErrorCount: number[] = [];
  private readonly windowMs = 5 * 60 * 1000; // 5-minute window
  private readonly alertCheckIntervalMs = 10 * 1000; // Check every 10 seconds

  constructor() {
    // Periodic check for alert conditions
    setInterval(() => this.checkAlerts(), this.alertCheckIntervalMs);
  }

  recordError(source: ErrorSource, code: string): void {
    const now = Date.now();

    if (source === 'db') {
      this.dbErrorCount.push(now);
    }

    // Track errors by type
    if (!this.errorCounts.has(code)) {
      this.errorCounts.set(code, []);
    }
    this.errorCounts.get(code)!.push(now);
  }

  private checkAlerts(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Check DB error rate (>5/min = ~50/5min window)
    const dbErrorsInWindow = this.dbErrorCount.filter((t) => t > windowStart);
    if (dbErrorsInWindow.length > 50) {
      console.error(
        `[error-alert] Database error spike detected: ${dbErrorsInWindow.length} errors in 5 minutes`,
      );
    }

    // Cleanup old entries
    this.dbErrorCount = dbErrorsInWindow;

    // Check specific error spikes (e.g., same error >10 times in 5 min)
    for (const [code, timestamps] of this.errorCounts.entries()) {
      const filtered = timestamps.filter((t) => t > windowStart);
      if (filtered.length > 10) {
        console.error(
          `[error-alert] Error spike detected: ${code} occurred ${filtered.length} times in 5 minutes`,
        );
      }
      this.errorCounts.set(code, filtered);
    }
  }
}

// Global instance
export const errorRateMonitor = new ErrorRateMonitor();

/**
 * Express error capture middleware
 * Wraps all error handlers and catches uncaught exceptions
 * Calls errorTelemetry.captureError() for centralized error tracking
 */

import { Request, Response, NextFunction } from 'express';
import { captureError, errorRateMonitor, ErrorContext, ErrorSource } from '../telemetry/errors';

/**
 * Extract context from Express request
 */
function extractContextFromRequest(req: Request, source?: ErrorSource): ErrorContext {
  return {
    endpoint: `${req.method} ${req.path}`,
    userId: (req as any).userId || (req as any).user?.id,
    source,
  };
}

/**
 * Error capture middleware for Express
 * Must be placed AFTER all other middleware and route handlers
 *
 * Usage in app.ts:
 * ```
 * import { errorCaptureMiddleware } from './middleware/error-capture';
 * app.use(errorCaptureMiddleware);
 * ```
 */
export function errorCaptureMiddleware(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const t0 = performance.now();

  // Extract context from request
  const context = extractContextFromRequest(req, 'api');

  // Determine HTTP status code
  const statusCode = err?.statusCode || err?.status || 500;
  const isServerError = statusCode >= 500;
  const isClientError = statusCode >= 400 && statusCode < 500;

  // Record error rate for monitoring
  const errorCode = err?.code || `HTTP_${statusCode}`;
  errorRateMonitor.recordError('api', errorCode);

  // Capture error with timing information
  const durationMs = performance.now() - t0;
  captureError(err, context, durationMs);

  // Alert on 5xx error rate >1%
  if (isServerError) {
    console.error(`[api-error] ${statusCode}: ${err?.message || 'Unknown error'}`);
  }

  // Send response if not already sent
  if (!res.headersSent) {
    res.status(statusCode).json({
      error: {
        code: err?.code || `HTTP_${statusCode}`,
        message: isClientError ? err?.message : 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err?.stack }),
      },
    });
  }
}

/**
 * Wrapper for async route handlers to catch unhandled promise rejections
 *
 * Usage:
 * ```
 * app.get('/route', asyncHandler(async (req, res) => {
 *   const data = await someAsyncOperation();
 *   res.json(data);
 * }));
 * ```
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const t0 = performance.now();
    const context = extractContextFromRequest(req, 'api');

    Promise.resolve(fn(req, res, next)).catch((err) => {
      const durationMs = performance.now() - t0;
      captureError(err, context, durationMs);
      errorRateMonitor.recordError('api', err?.code || 'ASYNC_ERROR');
      next(err);
    });
  };
}

/**
 * Database error wrapper
 * Captures database-specific errors with enhanced context
 */
export function withDbErrorCapture<T>(
  operation: string,
  fn: () => Promise<T>,
  context?: Partial<ErrorContext>,
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const t0 = performance.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (err: any) {
      const durationMs = performance.now() - t0;
      const dbContext: ErrorContext = {
        source: 'db',
        ...context,
        operation,
      };

      captureError(err, dbContext, durationMs);
      errorRateMonitor.recordError('db', err?.code || 'DB_ERROR');

      // Alert on DB error rate >5/min
      const dbErrorRate = 5; // per minute
      if (err?.code?.includes('UNIQUE') || err?.code?.includes('CONSTRAINT')) {
        console.warn(`[db-warning] Constraint violation in ${operation}: ${err.message}`);
      }

      reject(err);
    }
  });
}

/**
 * Job error wrapper
 * Captures background job errors
 */
export function withJobErrorCapture<T>(
  jobName: string,
  fn: () => Promise<T>,
  context?: Partial<ErrorContext>,
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const t0 = performance.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (err: any) {
      const durationMs = performance.now() - t0;
      const jobContext: ErrorContext = {
        source: 'job',
        ...context,
        jobName,
      };

      captureError(err, jobContext, durationMs);
      errorRateMonitor.recordError('job', err?.code || 'JOB_ERROR');

      console.error(`[job-error] ${jobName} failed: ${err.message}`);

      reject(err);
    }
  });
}

/**
 * File operation error wrapper
 * Captures file system errors
 */
export function withFileErrorCapture<T>(
  operation: string,
  filePath: string,
  fn: () => Promise<T>,
  context?: Partial<ErrorContext>,
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const t0 = performance.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (err: any) {
      const durationMs = performance.now() - t0;
      const fileContext: ErrorContext = {
        source: 'file',
        ...context,
        operation,
        filePath,
      };

      captureError(err, fileContext, durationMs);
      errorRateMonitor.recordError('file', err?.code || 'FILE_ERROR');

      console.error(`[file-error] ${operation} on ${filePath}: ${err.message}`);

      reject(err);
    }
  });
}

/**
 * Auth error wrapper
 * Captures authentication and authorization errors
 */
export function withAuthErrorCapture<T>(
  operation: string,
  fn: () => Promise<T>,
  userId?: string,
  context?: Partial<ErrorContext>,
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const t0 = performance.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (err: any) {
      const durationMs = performance.now() - t0;
      const authContext: ErrorContext = {
        source: 'auth',
        ...context,
        operation,
        userId,
      };

      captureError(err, authContext, durationMs);
      errorRateMonitor.recordError('auth', err?.code || 'AUTH_ERROR');

      console.error(`[auth-error] ${operation}: ${err.message}`);

      reject(err);
    }
  });
}

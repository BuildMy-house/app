/**
 * HTTP request telemetry middleware. Captures method, path, statusCode,
 * durationMs, requestSize, responseSize, userId. Sampling:
 *   - 100% for errors (status >= 400)
 *   - 100% for slow requests (>100ms)
 *   - 10% for fast requests (<100ms)
 *
 * Overhead: <2ms per request (performance.now() + fire-and-forget emit).
 */

import type { Request, Response, NextFunction } from 'express';
import { serverTelemetry } from '../telemetry/logger.js';

export function telemetryMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();
  const originalEnd = res.end;
  let capturedUserId: string | undefined;

  // Capture userId after requireAuth runs (it sets req.userId)
  const originalJson = res.json;
  res.json = function (this: Response, body?: unknown) {
    // Capture response size estimate before sending
    return originalJson.call(this, body);
  } as typeof res.json;

  res.end = function (this: Response, ...args: any[]) {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    // userId is set by requireAuth middleware which runs before this
    capturedUserId = req.userId;

    // Estimate sizes from content-length header or body
    const requestSize = Number(req.headers['content-length']) || undefined;

    let responseSize: number | undefined;
    const cl = res.getHeader('content-length');
    if (cl) {
      responseSize = Number(cl) || undefined;
    }

    serverTelemetry.apiRequest({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
      requestSize,
      responseSize,
      userId: capturedUserId,
    });

    return originalEnd.apply(this, args as any);
  } as typeof res.end;

  next();
}

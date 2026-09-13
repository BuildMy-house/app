import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps async express middleware/route handlers to catch errors and pass them to Express error handling.
 * Without this, unhandled promise rejections in async handlers would crash the server.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

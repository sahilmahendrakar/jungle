import type { Request, Response, NextFunction, RequestHandler } from "express";

// An error carrying an HTTP status. Throw from a route handler or guard to send
// `{ error: message }` with that status; errorHandler serializes it.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Wrap an async route handler so a thrown error / rejected promise is forwarded to the error
// middleware instead of hanging the request. Replaces the per-route try/catch that was
// copy-pasted across every handler.
export function wrap(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Terminal error middleware. An ApiError maps to its status; anything else is a 500. The JSON
// shape ({ error: <message> }) matches what the old per-route catch blocks produced.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  const isApi = err instanceof ApiError;
  // A handler may have set response headers before throwing (the attachment route sets
  // content-type/length from the DB row). Left in place they'd label this JSON as an image and
  // give a wrong length, so the browser shows a broken image instead of the error.
  for (const h of ["content-type", "content-length", "content-disposition"]) res.removeHeader(h);
  // Unexpected errors carry internals (fs paths, driver messages) — log them, don't ship them.
  if (!isApi) console.error(`unhandled error on ${req.method} ${req.path}:`, err);
  res.status(isApi ? err.status : 500).json({ error: isApi ? err.message : "internal error" });
}

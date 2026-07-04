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
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  const status = err instanceof ApiError ? err.status : 500;
  res.status(status).json({ error: String((err as Error)?.message ?? err) });
}

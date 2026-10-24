import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, ZodError, type ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m = "Not found.") => new HttpError(404, m);
export const forbidden = (m = "You do not have permission to do that.") => new HttpError(403, m);
export const conflict = (m: string) => new HttpError(409, m);

/** Wrap async handlers so thrown errors reach the error middleware (Express 5 does this too, kept explicit). */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    throw new HttpError(400, `${where}${first?.message ?? "Invalid input."}`);
  }
  return result.data;
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export { ZodError };

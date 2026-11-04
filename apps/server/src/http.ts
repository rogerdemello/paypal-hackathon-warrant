import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type z } from 'zod';
import { AgentError } from './services/agent';
import { DisputeError } from './services/disputes';
import { LlmBudgetError } from './services/llm';
import { MerchantError } from './services/merchant';
import { StoreError } from './services/store';
import { WalletError } from './services/wallet';

declare module 'fastify' {
  interface FastifyRequest {
    /** The request body exactly as received (PayPal webhook signatures cover the raw bytes). */
    rawBody?: string;
  }
}

export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'ERROR',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Validate a request body or query against a schema, turning failures into a 400 that lists every problem. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new HttpError(400, `invalid request: ${result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`, 'INVALID_REQUEST', result.error.issues);
  }
  return result.data;
}

/** The browser's anonymous visitor id (demo identity; see docs/threat-model.md). */
export function visitorIdOf(request: FastifyRequest): string {
  const header = request.headers['x-visitor-id'];
  const id = Array.isArray(header) ? header[0] : header;
  if (id === undefined || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new HttpError(401, 'send your visitor id in the x-visitor-id header (8-128 characters of A-Z a-z 0-9 _ -)', 'NO_VISITOR');
  return id;
}

const WALLET_STATUS: Record<WalletError['code'], number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  EXPIRED: 410,
  REVOKED: 409,
  OUT_OF_SCOPE: 422,
  INVALID: 400,
  CONFLICT: 409,
  UNKNOWN_MERCHANT: 422,
};
const SIMPLE_STATUS = { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, INVALID: 400, PAYPAL: 502 } as const;

/** Map domain errors to HTTP statuses once, so route handlers can simply throw. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const send = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => reply.status(status).send({ error: { code, message, ...extra } });
    if (error instanceof HttpError) return send(error.status, error.code, error.message, error.details === undefined ? {} : { details: error.details });
    if (error instanceof ZodError) return send(400, 'INVALID_REQUEST', 'invalid request', { details: error.issues });
    if (error instanceof WalletError) return send(WALLET_STATUS[error.code], error.code, error.message, error.problems.length > 0 ? { problems: error.problems } : {});
    if (error instanceof AgentError || error instanceof MerchantError || error instanceof DisputeError) return send(SIMPLE_STATUS[error.code], error.code, error.message);
    if (error instanceof StoreError) return send(400, 'INVALID', error.message);
    if (error instanceof LlmBudgetError) return send(429, 'MODEL_BUDGET', error.message);
    const framework = error as { statusCode?: number; message?: string; code?: string };
    if (typeof framework.statusCode === 'number' && framework.statusCode >= 400 && framework.statusCode < 500) {
      return send(framework.statusCode, framework.code ?? 'BAD_REQUEST', framework.message ?? 'bad request');
    }
    request.log.error({ err: error }, 'unhandled error');
    return send(500, 'INTERNAL', 'something went wrong on the server');
  });
}

/** Drop `undefined` members so a parsed body can be passed where optional properties may not be `undefined`. */
export function compact<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

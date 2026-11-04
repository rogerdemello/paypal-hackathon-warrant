import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Container } from './container';
import { installErrorHandler } from './http';
import { registerConsoleRoutes } from './routes/console';
import { registerLabRoutes } from './routes/lab';
import { registerPublicRoutes } from './routes/public';
import { registerShopperRoutes } from './routes/shopper';

export interface AppOptions {
  /** Folder with the built web app to serve (and fall back to for client-side routes). Default: apps/web/dist if it exists. */
  readonly webDist?: string | null;
  readonly logger?: boolean;
}

/** The HTTP API (and, when built, the web app) over a container of services. */
export async function buildApp(container: Container, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? container.config.nodeEnv !== 'test', bodyLimit: 2 * 1024 * 1024, trustProxy: true });

  // Keep the raw text of JSON bodies: PayPal's webhook signature covers the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = text;
    if (text === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('the request body is not valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }), undefined);
    }
  });
  // The simulator's approval page posts a plain HTML form.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'))));
  });

  installErrorHandler(app);
  await app.register(cors, { origin: [container.config.webOrigin, container.config.publicBaseUrl], allowedHeaders: ['content-type', 'x-visitor-id', 'x-console-token'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  registerPublicRoutes(app, container);
  registerShopperRoutes(app, container);
  registerConsoleRoutes(app, container);
  registerLabRoutes(app, container);

  const dist = options.webDist === undefined ? resolve(process.cwd(), '../web/dist') : options.webDist;
  if (dist !== null && existsSync(resolve(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: resolve(dist), wildcard: false });
    // Client-side routes (/v/:id, /console, ...) all serve the app shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/sim/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'no such route' } });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'no such route' } }));
  }
  return app;
}

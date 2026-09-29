import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Default location of the renter frontend. The P0 layout keeps it as a plain
 * static page (`apps/web/public`); a production build can override the location
 * with `WEB_ROOT` without touching the code.
 */
export const DEFAULT_WEB_ROOT = resolve(__dirname, '..', '..', 'web', 'public');

/** Extensions the page and its assets can use; anything else is not served. */
const SERVEABLE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.map', '.json', '.svg', '.ico', '.png', '.woff2']);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export interface StaticOptions {
  /** Absolute path of the directory to serve. */
  root: string;
  /** File served for `/` and for unknown paths. */
  indexFile?: string;
}

/**
 * Minimal dependency-free static file server.
 *
 * `@fastify/static` is deliberately not used: the P0 surface is a single page
 * plus one module script, and a hand-rolled handler keeps the Agent's
 * dependency list to what the chain and inference paths actually need.
 *
 * Directory traversal is rejected by re-resolving the request path against the
 * root and requiring the result to stay inside it.
 */
export async function serveStatic(app: FastifyInstance, options: StaticOptions): Promise<void> {
  const root = resolve(options.root);
  const indexFile = options.indexFile ?? 'index.html';

  // Every response is public: the page contains no renters' data. Network
  // privacy and ingress are deployment responsibilities; this static handler
  // does not assume or configure a particular tunnel or private network.
  app.addHook('onSend', async (_request: any, reply: any, payload: unknown) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setNotFoundHandler(async (request: any, reply: any) => {
    const urlPath = typeof request.url === 'string' ? request.url.split('?')[0] : '/';

    // API routes keep their JSON 404s; only document paths fall through to the
    // static handler.
    if (urlPath.startsWith('/api') || urlPath.startsWith('/v1') || urlPath.startsWith('/auth')) {
      reply.code(404);
      return { error: 'not found' };
    }

    const target = resolveInside(root, urlPath === '/' ? indexFile : urlPath.slice(1));
    if (!target) {
      reply.code(403);
      return { error: 'forbidden' };
    }

    const file = (await isFile(target)) ? target : resolveInside(root, indexFile);
    if (!file || !(await isFile(file))) {
      reply.code(404);
      return { error: 'web asset not found' };
    }

    reply.header('content-type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
    reply.code(200);
    return reply.send(createReadStream(file));
  });
}

/** Resolves `relative` inside `root`, or `null` when it escapes the root. */
function resolveInside(root: string, relative: string): string | null {
  // decodeURIComponent rejects malformed escapes; normalize collapses `..`
  // segments before the containment check.
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const candidate = resolve(join(root, normalize(decoded)));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

async function isFile(path: string): Promise<boolean> {
  if (!SERVEABLE_EXTENSIONS.has(extname(path))) return false;
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const root = resolve(
  process.env.WEB_ROOT ?? resolve(fileURLToPath(new URL('.', import.meta.url)), 'dist'),
);
const securityHeaders = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://*.ingest.sentry.io; worker-src 'self' blob:; manifest-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.manifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const noCacheFiles = new Set(['/sw.js', '/manifest.webmanifest', '/push-sw.js']);
const hashedAssetPattern = /(?:^|[-.])[A-Za-z0-9_-]{8,}(?=\.[^.]+$)/;

const server = createServer((request, response) => {
  void serveRequest(request, response).catch(() => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendError(response, 500);
  });
});

server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '0.0.0.0', () => {
  const address = server.address();
  console.info(`Static web server listening on ${typeof address === 'object' ? address.port : ''}`);
});

async function serveRequest(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendError(response, 405);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    sendError(response, 400);
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    sendError(response, 404);
    return;
  }

  const filePath = resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    sendError(response, 400);
    return;
  }

  let resolvedPath = filePath;
  let fileInfo;
  try {
    fileInfo = await stat(resolvedPath);
    if (fileInfo.isDirectory()) {
      resolvedPath = resolve(resolvedPath, 'index.html');
      fileInfo = await stat(resolvedPath);
    }
    if (!fileInfo.isFile()) throw new Error('Not a regular file');
  } catch {
    if (pathname.startsWith('/assets/') || extname(pathname)) {
      sendError(response, 404);
      return;
    }
    resolvedPath = resolve(root, 'index.html');
    try {
      fileInfo = await stat(resolvedPath);
    } catch {
      sendError(response, 404);
      return;
    }
  }

  const contentType = contentTypes[extname(resolvedPath)] ?? 'application/octet-stream';
  const assetName = basename(resolvedPath);
  const cacheControl = noCacheFiles.has(pathname)
    ? 'no-cache, no-store, must-revalidate'
    : pathname === '/' || resolvedPath === resolve(root, 'index.html')
      ? 'no-cache'
      : hashedAssetPattern.test(assetName)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate';

  const headers = {
    ...securityHeaders,
    'Cache-Control': cacheControl,
    'Content-Type': contentType,
    Vary: 'Accept-Encoding',
  };

  if (request.method === 'HEAD') {
    response.writeHead(200, { ...headers, 'Content-Length': fileInfo.size });
    response.end();
    return;
  }

  const acceptsGzip = String(request.headers['accept-encoding'] ?? '')
    .split(',')
    .some((encoding) => {
      const [name, ...parameters] = encoding.trim().split(';');
      return (
        name === 'gzip' &&
        !parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?$/i.test(parameter.trim()))
      );
    });
  const isCompressible =
    fileInfo.size >= 256 &&
    (/^(text\/|application\/(javascript|json|manifest\+json|wasm|xml))/.test(contentType) ||
      contentType === 'image/svg+xml');

  if (acceptsGzip && isCompressible) {
    response.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
    await pipeline(createReadStream(resolvedPath), createGzip(), response);
    return;
  }

  response.writeHead(200, { ...headers, 'Content-Length': fileInfo.size });
  await pipeline(createReadStream(resolvedPath), response);
}

function sendError(response, statusCode) {
  response.writeHead(statusCode, {
    ...securityHeaders,
    'Cache-Control': 'no-store',
    'Content-Length': 0,
  });
  response.end();
}

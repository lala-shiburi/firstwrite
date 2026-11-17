import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface ResponseData {
  statusCode: number | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function request(port: number, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<ResponseData>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Node static web server', () => {
  it('serves SPA routes and applies service-worker, asset, compression, and security rules', async () => {
    const webRoot = mkdtempSync(path.join(os.tmpdir(), 'firstwrite-web-'));
    const largeAsset = 'const app = "' + 'cached-content-'.repeat(40) + '";';
    mkdirSync(path.join(webRoot, 'assets'));
    writeFileSync(path.join(webRoot, 'index.html'), '<main>Morning Pages app shell</main>');
    writeFileSync(path.join(webRoot, 'sw.js'), 'self.skipWaiting();');
    writeFileSync(path.join(webRoot, 'push-sw.js'), 'self.addEventListener("push", () => {});');
    writeFileSync(path.join(webRoot, 'manifest.webmanifest'), '{"name":"Morning Pages"}');
    writeFileSync(path.join(webRoot, 'assets/app-a1b2c3d4.js'), largeAsset);

    const server = spawn(process.execPath, [path.join(root, 'apps/web/server.mjs')], {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        WEB_ROOT: webRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const port = await new Promise<number>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error('Static server did not start')), 5000);
        server.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const match = /listening on (\d+)/.exec(output);
          if (match?.[1]) {
            clearTimeout(timeout);
            resolve(Number(match[1]));
          }
        });
        server.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        server.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Static server exited before listening (${code})`));
        });
      });

      const deepLink = await request(port, '/entries/2026-11-15');
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body.toString()).toBe('<main>Morning Pages app shell</main>');
      expect(deepLink.headers['cache-control']).toBe('no-cache');
      expect(deepLink.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(deepLink.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(deepLink.headers['x-content-type-options']).toBe('nosniff');
      expect(deepLink.headers['x-frame-options']).toBe('DENY');

      for (const pathname of ['/sw.js', '/push-sw.js', '/manifest.webmanifest']) {
        const response = await request(port, pathname);
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
      }

      const asset = await request(port, '/assets/app-a1b2c3d4.js', {
        'accept-encoding': 'gzip',
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(asset.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(asset.body).toString()).toBe(largeAsset);

      expect((await request(port, '/api/health')).statusCode).toBe(404);
      expect((await request(port, '/assets/missing.js')).statusCode).toBe(404);
    } finally {
      server.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (server.exitCode !== null) {
          resolve();
        } else {
          server.once('exit', () => resolve());
        }
      });
      rmSync(webRoot, { recursive: true, force: true });
    }
  });
});

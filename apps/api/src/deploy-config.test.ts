import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('production Compose and static web server rules', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yaml'), 'utf8');
  const staticServer = fs.readFileSync(path.join(root, 'apps/web/server.mjs'), 'utf8');
  const webDockerfile = fs.readFileSync(path.join(root, 'apps/web/Dockerfile'), 'utf8');
  const apiDockerfile = fs.readFileSync(path.join(root, 'apps/api/Dockerfile'), 'utf8');

  it('keeps one root Compose file and isolates the database from the proxy network', () => {
    expect(fs.existsSync(path.join(root, 'docker-compose.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'docker-compose.yml'))).toBe(false);
    expect(compose).toContain('image: postgres:15-alpine');
    expect(compose).toContain('internal: true');
    expect(compose).toContain('aliases:\n          - firstwrite-db');
    expect(compose).toContain('condition: service_healthy');
    expect(compose).toContain('pg_isready');
    expect(compose).toContain('postgres_data:/var/lib/postgresql/data');
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('resources:\n        limits:');

    const dbDefinition = compose.match(/ {2}db:\n([\s\S]*?)\n {2}api:/)?.[1];
    expect(dbDefinition).toBeDefined();
    expect(dbDefinition).not.toContain('proxy');
    expect(dbDefinition).toContain('default:');
  });

  it('routes explicitly to prefixed Traefik services without stripping the API path', () => {
    expect(compose).toContain('traefik.http.routers.firstwrite-api.priority=100');
    expect(compose).toContain('traefik.http.routers.firstwrite-web.priority=1');
    expect(compose).toContain('traefik.http.routers.firstwrite-api.entrypoints=websecure');
    expect(compose).toContain('traefik.http.routers.firstwrite-api.tls.certresolver=myresolver');
    expect(compose).toContain('PathPrefix(`/api`)');
    expect(compose).toContain('traefik.http.services.firstwrite-api.loadbalancer.server.port=3000');
    expect(compose).toContain('traefik.http.services.firstwrite-web.loadbalancer.server.port=8080');
    expect(compose).toContain("- '8080'");
    expect(compose).toContain('traefik.docker.network=proxy');
    expect(compose).not.toMatch(/stripPrefix|stripprefix/i);
    expect(compose).toContain('VITE_SENTRY_DSN: ${VITE_SENTRY_DSN:-}');
    expect(webDockerfile).toContain('ARG VITE_SENTRY_DSN=');
    expect(webDockerfile).toContain('VITE_SENTRY_DSN=${VITE_SENTRY_DSN}');
    expect(apiDockerfile).toContain('npm ci --omit=dev');
    expect(apiDockerfile).toContain('USER node');
  });

  it('has a SPA origin with caching, compression, and security headers', () => {
    expect(staticServer).toContain("resolve(root, 'index.html')");
    expect(staticServer).toContain('no-cache, no-store, must-revalidate');
    expect(staticServer).toContain('max-age=31536000, immutable');
    expect(staticServer).toContain('createGzip()');
    expect(staticServer).toContain('Strict-Transport-Security');
    expect(staticServer).toContain('Content-Security-Policy');
    expect(staticServer).toContain("'X-Content-Type-Options': 'nosniff'");
    expect(staticServer).toContain("'X-Frame-Options': 'DENY'");
  });
});

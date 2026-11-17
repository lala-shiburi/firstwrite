import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const validBaseEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  APP_BASE_URL: 'http://localhost:5173',
  TRUST_PROXY: '1',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/firstwrite',
  ENCRYPTION_KEY_CURRENT_VERSION: '1',
  ENCRYPTION_KEY_V1: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef-session-secret',
  VAPID_PUBLIC_KEY:
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  VAPID_PRIVATE_KEY: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls',
  VAPID_SUBJECT: 'mailto:support@example.com',
  EMAIL_PROVIDER: 'console',
  EMAIL_PROVIDER_API_KEY: 'test-email-key',
  EMAIL_FROM: 'Morning Pages <noreply@example.com>',
  LLM_PROVIDER: 'anthropic',
  LLM_API_KEY: 'test-llm-key',
  LLM_MODEL: 'claude-haiku-4-5',
  LLM_MONTHLY_SPEND_LIMIT_USD: '50',
};

describe('API loadConfig', () => {
  it('parses a complete valid environment configuration', () => {
    const config = loadConfig(validBaseEnv);
    expect(config.PORT).toBe(3000);
    expect(config.APP_BASE_URL).toBe('http://localhost:5173');
    expect(config.TRUST_PROXY).toBe(1);
    expect(config.ENCRYPTION_KEY_CURRENT_VERSION).toBe(1);
    expect(config.LLM_MONTHLY_SPEND_LIMIT_USD).toBe(50);
  });

  it('fails fast with a clear message when a required variable is missing', () => {
    const envWithoutDb = { ...validBaseEnv };
    delete envWithoutDb.DATABASE_URL;

    expect(() => loadConfig(envWithoutDb)).toThrowError(/DATABASE_URL/);
    expect(() => loadConfig(envWithoutDb)).toThrowError(
      /Invalid or missing environment configuration/,
    );
  });

  it('fails fast when ENCRYPTION_KEY_V1 is missing or not 32 bytes', () => {
    const envMissingKey = { ...validBaseEnv };
    delete envMissingKey.ENCRYPTION_KEY_V1;
    expect(() => loadConfig(envMissingKey)).toThrowError(/ENCRYPTION_KEY_V1/);

    const envShortKey = { ...validBaseEnv, ENCRYPTION_KEY_V1: 'too-short-key' };
    expect(() => loadConfig(envShortKey)).toThrowError(/ENCRYPTION_KEY_V1.*32-byte key/);
  });

  it('fails fast when VAPID keys, EMAIL_PROVIDER_API_KEY, or LLM_API_KEY are missing', () => {
    const envMissingSecrets = { ...validBaseEnv };
    delete envMissingSecrets.VAPID_PRIVATE_KEY;
    delete envMissingSecrets.EMAIL_PROVIDER_API_KEY;
    delete envMissingSecrets.LLM_API_KEY;

    expect(() => loadConfig(envMissingSecrets)).toThrowError(/VAPID_PRIVATE_KEY/);
    expect(() => loadConfig(envMissingSecrets)).toThrowError(/EMAIL_PROVIDER_API_KEY/);
    expect(() => loadConfig(envMissingSecrets)).toThrowError(/LLM_API_KEY/);
  });

  it('requires production database credentials and validates the Compose database URL', () => {
    const productionEnv: NodeJS.ProcessEnv = {
      ...validBaseEnv,
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://journal.example',
      CORS_ORIGIN: 'https://journal.example',
      SENTRY_DSN: 'https://public@example.ingest.sentry.io/123',
      DATABASE_URL: 'postgresql://writer:db-safe_password@firstwrite-db:5432/morning_pages',
      POSTGRES_USER: 'writer',
      POSTGRES_PASSWORD: 'db-safe_password',
      POSTGRES_DB: 'morning_pages',
    };

    expect(loadConfig(productionEnv).DATABASE_URL).toContain('@firstwrite-db:5432/');
    expect(() =>
      loadConfig({
        ...productionEnv,
        DATABASE_URL: 'postgresql://writer:bad@other:5432/db',
      }),
    ).toThrowError(/DATABASE_URL host must be the Compose database service/);
    expect(() =>
      loadConfig({
        ...productionEnv,
        DATABASE_URL: 'postgresql://writer:wrong@firstwrite-db:5432/morning_pages',
      }),
    ).toThrowError(/credentials and database must match POSTGRES_\* values/);
    expect(() => loadConfig({ ...validBaseEnv, NODE_ENV: 'production' })).toThrowError(
      /POSTGRES_USER/,
    );
    expect(() =>
      loadConfig({
        ...productionEnv,
        CORS_ORIGIN: undefined,
      }),
    ).toThrowError(/CORS_ORIGIN is required in production/);
    expect(() =>
      loadConfig({
        ...productionEnv,
        SENTRY_DSN: undefined,
      }),
    ).toThrowError(/SENTRY_DSN is required in production/);
  });

  it('rejects invalid trust proxy hop values', () => {
    expect(() => loadConfig({ ...validBaseEnv, TRUST_PROXY: 'nearby' })).toThrowError(
      /TRUST_PROXY must be true, false, or a non-negative hop count/,
    );
  });
});

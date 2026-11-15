import { z } from 'zod';
import { createKeyringFromEnv, type Keyring } from './crypto/encryption.js';

const encryptionKeyValidator = z
  .string()
  .min(1, 'Encryption key cannot be empty')
  .refine(
    (val) => {
      // Accept 64-char hex (32 bytes) or base64 encoding of 32 bytes
      if (/^[0-9a-fA-F]{64}$/.test(val)) {
        return true;
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(val) || val.length % 4 !== 0) {
        return false;
      }
      try {
        const buf = Buffer.from(val, 'base64');
        return buf.length === 32;
      } catch {
        return false;
      }
    },
    {
      message: 'Must be a 32-byte key encoded as 64 hex characters or 44 base64 characters',
    },
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.string().url('APP_BASE_URL must be a valid URL'),
  TRUST_PROXY: z
    .string()
    .default('1')
    .transform((val) => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      const num = Number(val);
      return Number.isNaN(num) ? val : num;
    }),

  // Database
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (url) => url.startsWith('postgres://') || url.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),

  // Encryption (AES-256-GCM keyring)
  ENCRYPTION_KEY_CURRENT_VERSION: z.coerce.number().int().positive().default(1),
  ENCRYPTION_KEY_V1: encryptionKeyValidator,
  ENCRYPTION_KEYS_JSON: z.string().optional(),

  // Auth & Session
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  TURNSTILE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // Web Push (VAPID)
  VAPID_PUBLIC_KEY: z.string().min(1, 'VAPID_PUBLIC_KEY is required'),
  VAPID_PRIVATE_KEY: z.string().min(1, 'VAPID_PRIVATE_KEY is required'),
  VAPID_SUBJECT: z
    .string()
    .min(1, 'VAPID_SUBJECT is required (e.g. mailto:support@example.com or https:// URL)'),

  // Transactional Email Provider
  EMAIL_PROVIDER: z.enum(['console', 'resend', 'postmark', 'ses']).default('console'),
  EMAIL_PROVIDER_API_KEY: z.string().min(1, 'EMAIL_PROVIDER_API_KEY is required'),
  EMAIL_FROM: z.string().min(1, 'EMAIL_FROM is required'),

  // LLM Provider & Cost Controls
  LLM_PROVIDER: z.enum(['anthropic', 'mock']).default('anthropic'),
  LLM_API_KEY: z.string().min(1, 'LLM_API_KEY is required'),
  LLM_MODEL: z.string().min(1, 'LLM_MODEL is required').default('claude-haiku-4-5'),
  LLM_MONTHLY_SPEND_LIMIT_USD: z.coerce
    .number()
    .positive('LLM_MONTHLY_SPEND_LIMIT_USD must be a positive number')
    .default(50),
});

export type AppConfig = z.infer<typeof envSchema> & {
  keyring: Keyring;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const formattedIssues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid or missing environment configuration:\n${formattedIssues}\n\nPlease check your .env file against .env.example.`,
    );
  }

  let keyring: Keyring;
  try {
    keyring = createKeyringFromEnv({
      ...env,
      ENCRYPTION_KEY_CURRENT_VERSION: String(result.data.ENCRYPTION_KEY_CURRENT_VERSION),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid encryption keyring configuration';
    throw new Error(
      `Invalid or missing environment configuration:\n  - ENCRYPTION_KEYRING: ${msg}\n\nPlease check your .env file against .env.example.`,
    );
  }

  return {
    ...result.data,
    keyring,
  };
}

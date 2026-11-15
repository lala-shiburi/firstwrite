import crypto from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2';

// ───────────── Argon2id Password Hashing ─────────────

export interface Argon2idParams {
  /** Memory cost in KiB (default 19456 KiB = 19 MiB per OWASP recommendation, or fast test profile) */
  m: number;
  /** Time cost / iterations */
  t: number;
  /** Parallelism */
  p: number;
  /** Output key length in bytes */
  dkLen: number;
}

const DEFAULT_ARGON2_PARAMS: Argon2idParams =
  process.env.NODE_ENV === 'test'
    ? { m: 1024, t: 1, p: 1, dkLen: 32 }
    : { m: 19456, t: 2, p: 1, dkLen: 32 };

function toBase64NoPad(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '');
}

function fromBase64NoPad(str: string): Buffer {
  const padLen = (4 - (str.length % 4)) % 4;
  return Buffer.from(str + '='.repeat(padLen), 'base64');
}

/**
 * Hashes a plaintext password using Argon2id and returns a standard PHC string:
 * `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt_b64>$<hash_b64>`
 */
export async function hashPassword(
  password: string,
  params: Argon2idParams = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await argon2idAsync(password, salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: params.dkLen,
  });

  return `$argon2id$v=19$m=${params.m},t=${params.t},p=${params.p}$${toBase64NoPad(salt)}$${toBase64NoPad(derived)}`;
}

/**
 * Verifies a plaintext password against a stored `$argon2id$...` PHC hash using constant-time comparison.
 */
export async function verifyPassword(password: string, phcHash: string): Promise<boolean> {
  try {
    const parts = phcHash.split('$');
    // ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', '<salt>', '<hash>']
    if (parts.length !== 6 || parts[1] !== 'argon2id') {
      return false;
    }

    const paramSegment = parts[3] ?? '';
    const saltB64 = parts[4] ?? '';
    const hashB64 = parts[5] ?? '';

    const paramMap: Record<string, number> = {};
    for (const kv of paramSegment.split(',')) {
      const [k, v] = kv.split('=');
      if (k && v) {
        paramMap[k] = Number(v);
      }
    }

    const m = paramMap.m;
    const t = paramMap.t;
    const p = paramMap.p;
    if (!m || !t || !p || m < 8 || t < 1 || p < 1) {
      return false;
    }

    const salt = fromBase64NoPad(saltB64);
    const expectedHash = fromBase64NoPad(hashB64);
    if (salt.length === 0 || expectedHash.length === 0) {
      return false;
    }

    const computed = await argon2idAsync(password, salt, {
      m,
      t,
      p,
      dkLen: expectedHash.length,
    });

    const computedBuf = Buffer.from(computed);
    if (computedBuf.length !== expectedHash.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedBuf, expectedHash);
  } catch {
    return false;
  }
}

// ───────────── Opaque Token Generation & Hashing (AGENTS.md Rule 3) ─────────────

/**
 * Generates a high-entropy random opaque token (base64url) and its SHA-256 hex hash.
 * Only `tokenHash` may ever be stored in PostgreSQL; `rawToken` exists only in the cookie or email link.
 */
export function generateOpaqueToken(byteLength = 32): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(byteLength).toString('base64url');
  const tokenHash = hashOpaqueToken(rawToken);
  return { rawToken, tokenHash };
}

/**
 * Computes the deterministic SHA-256 hex digest of a raw session or email token.
 */
export function hashOpaqueToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

// ───────────── Stateless HMAC CSRF Token Bound to Session ─────────────

/**
 * Derives a CSRF token bound to a session's `tokenHash` (or anonymous key) using `SESSION_SECRET`.
 */
export function deriveCsrfToken(sessionTokenHash: string, sessionSecret: string): string {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`csrf:${sessionTokenHash}`, 'utf8')
    .digest('base64url');
}

export function verifyCsrfToken(
  providedToken: string | undefined,
  sessionTokenHash: string,
  sessionSecret: string,
): boolean {
  if (!providedToken || typeof providedToken !== 'string') {
    return false;
  }
  const expected = deriveCsrfToken(sessionTokenHash, sessionSecret);
  const a = Buffer.from(providedToken, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

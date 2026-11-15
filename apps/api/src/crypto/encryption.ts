import crypto from 'node:crypto';

export const AES_ALGORITHM = 'aes-256-gcm';
export const KEY_BYTE_LENGTH = 32;
export const NONCE_BYTE_LENGTH = 12;
export const AUTH_TAG_BYTE_LENGTH = 16;

// ───────────── Error Types ─────────────
// Error messages are strictly static or include only numeric key versions—never plaintext or key material.

export type EncryptionErrorCode =
  | 'INVALID_KEY_LENGTH'
  | 'UNKNOWN_KEY_VERSION'
  | 'TAMPERED_DATA'
  | 'WRONG_KEY'
  | 'DECRYPTION_FAILED';

export class EncryptionError extends Error {
  public readonly code: EncryptionErrorCode;

  constructor(code: EncryptionErrorCode, message: string) {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

export class InvalidKeyLengthError extends EncryptionError {
  constructor(version?: number) {
    super(
      'INVALID_KEY_LENGTH',
      version !== undefined
        ? `Encryption key for version ${version} must be exactly 32 bytes`
        : 'Encryption key must be exactly 32 bytes',
    );
    this.name = 'InvalidKeyLengthError';
  }
}

export class UnknownKeyVersionError extends EncryptionError {
  public readonly keyVersion: number;

  constructor(keyVersion: number) {
    super('UNKNOWN_KEY_VERSION', `Unknown encryption key version: ${keyVersion}`);
    this.name = 'UnknownKeyVersionError';
    this.keyVersion = keyVersion;
  }
}

export class TamperedDataError extends EncryptionError {
  constructor(
    reason = 'Ciphertext integrity check failed or payload is malformed',
    code: EncryptionErrorCode = 'TAMPERED_DATA',
  ) {
    super(code, reason);
    this.name = 'TamperedDataError';
  }
}

export class WrongKeyError extends TamperedDataError {
  constructor() {
    super('Decryption failed: wrong key or tampered authentication tag', 'WRONG_KEY');
    this.name = 'WrongKeyError';
  }
}

// ───────────── Associated Data (AAD) Builders ─────────────
/**
 * Row-binding Additional Authenticated Data (AAD) helpers.
 * Binding each ciphertext to its owning row (`user_id` + `entry_date` or `week_start`)
 * ensures that if an attacker or bug copies `content_enc` or `summary_enc` to another
 * user or another date row, AES-GCM authentication fails immediately on decryption.
 */
export function buildEntryAad(userId: bigint | number | string, entryDate: string): string {
  return `entry:${String(userId)}:${entryDate}`;
}

export function buildSummaryAad(
  userId: bigint | number | string,
  weekStart: string,
  field: 'summary' | 'themes' = 'summary',
): string {
  return `weekly_summary:${field}:${String(userId)}:${weekStart}`;
}

// ───────────── Key Parsing & Keyring ─────────────

/**
 * Parses a 32-byte key from a Buffer, a 64-character hex string, or a base64 string.
 * Throws `InvalidKeyLengthError` if the decoded key is not exactly 32 bytes.
 */
export function parseEncryptionKey(rawKey: string | Buffer, version?: number): Buffer {
  if (Buffer.isBuffer(rawKey)) {
    if (rawKey.length !== KEY_BYTE_LENGTH) {
      throw new InvalidKeyLengthError(version);
    }
    return Buffer.from(rawKey);
  }

  if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    throw new InvalidKeyLengthError(version);
  }

  const trimmed = rawKey.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'hex');
    if (buf.length !== KEY_BYTE_LENGTH) {
      throw new InvalidKeyLengthError(version);
    }
    return buf;
  }

  // Validate strict base64 characters before decoding
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new InvalidKeyLengthError(version);
  }

  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length !== KEY_BYTE_LENGTH) {
    throw new InvalidKeyLengthError(version);
  }
  return buf;
}

export interface KeyringInput {
  currentVersion: number;
  keys: Record<number, string | Buffer>;
}

export class Keyring {
  public readonly currentVersion: number;
  private readonly keys: Map<number, Buffer>;

  constructor({ currentVersion, keys }: KeyringInput) {
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      throw new UnknownKeyVersionError(currentVersion);
    }

    this.keys = new Map<number, Buffer>();
    for (const [verStr, rawKey] of Object.entries(keys)) {
      const version = Number(verStr);
      if (!Number.isInteger(version) || version < 1) {
        throw new UnknownKeyVersionError(version);
      }
      this.keys.set(version, parseEncryptionKey(rawKey, version));
    }

    if (!this.keys.has(currentVersion)) {
      throw new UnknownKeyVersionError(currentVersion);
    }

    this.currentVersion = currentVersion;
  }

  public getKey(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new UnknownKeyVersionError(version);
    }
    return key;
  }

  public getCurrentKey(): { version: number; key: Buffer } {
    return {
      version: this.currentVersion,
      key: this.getKey(this.currentVersion),
    };
  }

  public hasVersion(version: number): boolean {
    return this.keys.has(version);
  }

  public versions(): number[] {
    return Array.from(this.keys.keys()).sort((a, b) => a - b);
  }
}

/**
 * Builds a validated `Keyring` from environment variables:
 * - `ENCRYPTION_KEY_CURRENT_VERSION` (defaults to 1)
 * - `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, ... (`ENCRYPTION_KEY_V<n>`)
 * - Optional `ENCRYPTION_KEYS_JSON` (JSON object mapping version numbers to 32-byte keys)
 */
export function createKeyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  const currentVersionRaw = env.ENCRYPTION_KEY_CURRENT_VERSION ?? '1';
  const currentVersion = Number(currentVersionRaw);
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new UnknownKeyVersionError(currentVersion);
  }

  const rawKeys: Record<number, string> = {};

  // 1. Load optional JSON map first
  if (env.ENCRYPTION_KEYS_JSON && env.ENCRYPTION_KEYS_JSON.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.ENCRYPTION_KEYS_JSON);
    } catch {
      throw new EncryptionError(
        'INVALID_KEY_LENGTH',
        'ENCRYPTION_KEYS_JSON must be a valid JSON object mapping version numbers to keys',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new EncryptionError(
        'INVALID_KEY_LENGTH',
        'ENCRYPTION_KEYS_JSON must be a JSON object mapping version numbers to keys',
      );
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const ver = Number(k);
      if (!Number.isInteger(ver) || ver < 1 || typeof v !== 'string') {
        throw new InvalidKeyLengthError(Number.isInteger(ver) ? ver : undefined);
      }
      rawKeys[ver] = v;
    }
  }

  // 2. Load any ENCRYPTION_KEY_V<n> variables from env
  for (const [envKey, envVal] of Object.entries(env)) {
    const match = /^ENCRYPTION_KEY_V(\d+)$/.exec(envKey);
    if (match && match[1] && typeof envVal === 'string' && envVal.length > 0) {
      const ver = Number(match[1]);
      rawKeys[ver] = envVal;
    }
  }

  return new Keyring({
    currentVersion,
    keys: rawKeys,
  });
}

// ───────────── Core AES-256-GCM Encrypt / Decrypt Primitives ─────────────

export interface EncryptOptions {
  associatedData?: string | Buffer;
}

export interface DecryptOptions {
  associatedData?: string | Buffer;
}

function toAadBuffer(aad?: string | Buffer): Buffer | undefined {
  if (aad === undefined) return undefined;
  return Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'utf8');
}

/**
 * Encrypts a UTF-8 string with a single 32-byte key using AES-256-GCM and a fresh
 * 12-byte random nonce. Returns `base64(nonce || ciphertext || authTag)`.
 */
export function encryptWithKey(
  plaintext: string,
  rawKey: Buffer | string,
  options: EncryptOptions = {},
): string {
  const key = parseEncryptionKey(rawKey);
  const nonce = crypto.randomBytes(NONCE_BYTE_LENGTH);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_BYTE_LENGTH,
  });

  const aadBuf = toAadBuffer(options.associatedData);
  if (aadBuf) {
    cipher.setAAD(aadBuf);
  }

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([nonce, ciphertext, authTag]).toString('base64');
}

/**
 * Decrypts a `base64(nonce || ciphertext || authTag)` payload with a single 32-byte key.
 * Throws `TamperedDataError` for malformed payloads and `WrongKeyError` (which extends
 * `EncryptionError` and is also flagged for authentication failures) when GCM tag verification fails.
 */
export function decryptWithKey(
  encodedPayload: string,
  rawKey: Buffer | string,
  options: DecryptOptions = {},
): string {
  const key = parseEncryptionKey(rawKey);

  if (
    typeof encodedPayload !== 'string' ||
    encodedPayload.length === 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedPayload) ||
    encodedPayload.length % 4 !== 0
  ) {
    throw new TamperedDataError('Ciphertext payload is not valid base64');
  }

  const combined = Buffer.from(encodedPayload, 'base64');
  if (combined.length < NONCE_BYTE_LENGTH + AUTH_TAG_BYTE_LENGTH) {
    throw new TamperedDataError('Ciphertext payload is shorter than nonce + authentication tag');
  }

  const nonce = combined.subarray(0, NONCE_BYTE_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_BYTE_LENGTH);
  const ciphertext = combined.subarray(NONCE_BYTE_LENGTH, combined.length - AUTH_TAG_BYTE_LENGTH);

  try {
    const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, nonce, {
      authTagLength: AUTH_TAG_BYTE_LENGTH,
    });
    decipher.setAuthTag(authTag);

    const aadBuf = toAadBuffer(options.associatedData);
    if (aadBuf) {
      decipher.setAAD(aadBuf);
    }

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Never leak underlying crypto error details or buffers
    throw new WrongKeyError();
  }
}

// ───────────── Versioned Keyring Encrypt / Decrypt ─────────────

export interface VersionedCiphertext {
  ciphertext: string;
  keyVersion: number;
}

/**
 * Encrypts plaintext using the keyring's `currentVersion` key.
 */
export function encrypt(
  plaintext: string,
  keyring: Keyring,
  options: EncryptOptions = {},
): VersionedCiphertext {
  const { version, key } = keyring.getCurrentKey();
  const ciphertext = encryptWithKey(plaintext, key, options);
  return {
    ciphertext,
    keyVersion: version,
  };
}

/**
 * Decrypts a ciphertext payload by selecting the key for `keyVersion` from the keyring.
 */
export function decrypt(
  ciphertext: string,
  keyVersion: number,
  keyring: Keyring,
  options: DecryptOptions = {},
): string {
  const key = keyring.getKey(keyVersion);
  return decryptWithKey(ciphertext, key, options);
}

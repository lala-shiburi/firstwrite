import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import {
  AUTH_TAG_BYTE_LENGTH,
  buildEntryAad,
  buildSummaryAad,
  createKeyringFromEnv,
  decrypt,
  decryptWithKey,
  encrypt,
  EncryptionError,
  encryptWithKey,
  InvalidKeyLengthError,
  KEY_BYTE_LENGTH,
  Keyring,
  NONCE_BYTE_LENGTH,
  parseEncryptionKey,
  TamperedDataError,
  UnknownKeyVersionError,
  WrongKeyError,
} from './encryption.js';
import {
  type EntryRotationRow,
  reencryptAll,
  type ReencryptStorageAdapter,
  type SummaryRotationRow,
} from './reencrypt.js';

const KEY_V1_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY_V2_HEX = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const KEY_V3_BASE64 = crypto.randomBytes(KEY_BYTE_LENGTH).toString('base64');

function createInMemoryStorage(
  initialEntries: EntryRotationRow[] = [],
  initialSummaries: SummaryRotationRow[] = [],
): {
  entriesStore: EntryRotationRow[];
  summariesStore: SummaryRotationRow[];
  adapter: ReencryptStorageAdapter;
} {
  const entriesStore = initialEntries.map((r) => ({ ...r }));
  const summariesStore = initialSummaries.map((r) => ({ ...r }));

  const adapter: ReencryptStorageAdapter = {
    async fetchEntriesBatch(targetVersion, afterId, batchSize) {
      return entriesStore
        .filter((r) => r.keyVersion !== targetVersion && r.id > afterId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, batchSize)
        .map((r) => ({ ...r }));
    },

    async updateEntry({ id, expectedOldKeyVersion, contentEnc, keyVersion }) {
      const idx = entriesStore.findIndex(
        (r) => r.id === id && r.keyVersion === expectedOldKeyVersion,
      );
      if (idx === -1) return false;
      const existing = entriesStore[idx];
      if (!existing) return false;
      existing.contentEnc = contentEnc;
      existing.keyVersion = keyVersion;
      return true;
    },

    async fetchSummariesBatch(targetVersion, afterId, batchSize) {
      return summariesStore
        .filter((r) => r.keyVersion !== targetVersion && r.id > afterId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, batchSize)
        .map((r) => ({ ...r }));
    },

    async updateSummary({ id, expectedOldKeyVersion, summaryEnc, themesEnc, keyVersion }) {
      const idx = summariesStore.findIndex(
        (r) => r.id === id && r.keyVersion === expectedOldKeyVersion,
      );
      if (idx === -1) return false;
      const existing = summariesStore[idx];
      if (!existing) return false;
      existing.summaryEnc = summaryEnc;
      existing.themesEnc = themesEnc;
      existing.keyVersion = keyVersion;
      return true;
    },
  };

  return { entriesStore, summariesStore, adapter };
}

describe('Brief 2: AES-256-GCM Encryption Module', () => {
  it('round-trips UTF-8 plaintext (including emoji, multiline markdown, and empty strings) and formats base64(nonce + ciphertext + tag)', () => {
    const keyring = new Keyring({
      currentVersion: 1,
      keys: { 1: KEY_V1_HEX },
    });

    const samples = [
      '',
      'Morning pages: three pages of stream-of-consciousness writing.',
      'Unicode & emoji test: 🌅 ☕️ "Quotes", — dashes, 日本語, العربية, Кириллица',
      '# Heading\n\nParagraph with **bold** and `code`.\n'.repeat(200),
    ];

    for (const sample of samples) {
      const { ciphertext, keyVersion } = encrypt(sample, keyring);
      expect(keyVersion).toBe(1);

      const rawBytes = Buffer.from(ciphertext, 'base64');
      const expectedCiphertextLen = Buffer.byteLength(sample, 'utf8');
      expect(rawBytes.length).toBe(
        NONCE_BYTE_LENGTH + expectedCiphertextLen + AUTH_TAG_BYTE_LENGTH,
      );

      const decrypted = decrypt(ciphertext, keyVersion, keyring);
      expect(decrypted).toBe(sample);
    }
  });

  it('produces different ciphertexts when encrypting the identical plaintext twice (fresh random nonce)', () => {
    const keyring = new Keyring({
      currentVersion: 1,
      keys: { 1: KEY_V1_HEX },
    });

    const text = 'Same morning thought written twice.';
    const first = encrypt(text, keyring);
    const second = encrypt(text, keyring);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decrypt(first.ciphertext, first.keyVersion, keyring)).toBe(text);
    expect(decrypt(second.ciphertext, second.keyVersion, keyring)).toBe(text);
  });

  it('detects tampered data (flipped byte in nonce, ciphertext, or auth tag, or truncated payload) and fails to decrypt', () => {
    const keyring = new Keyring({
      currentVersion: 1,
      keys: { 1: KEY_V1_HEX },
    });

    const plaintext = 'Confidential journal entry that must never be silently corrupted.';
    const { ciphertext, keyVersion } = encrypt(plaintext, keyring);
    const originalBuf = Buffer.from(ciphertext, 'base64');

    // 1. Flip a bit in the 12-byte nonce
    const flippedNonce = Buffer.from(originalBuf);
    flippedNonce[0] = (flippedNonce[0] ?? 0) ^ 0xff;
    expect(() => decrypt(flippedNonce.toString('base64'), keyVersion, keyring)).toThrowError(
      TamperedDataError,
    );

    // 2. Flip a bit in the ciphertext body
    const flippedBody = Buffer.from(originalBuf);
    const middleIndex = NONCE_BYTE_LENGTH + 5;
    flippedBody[middleIndex] = (flippedBody[middleIndex] ?? 0) ^ 0x01;
    expect(() => decrypt(flippedBody.toString('base64'), keyVersion, keyring)).toThrowError(
      TamperedDataError,
    );

    // 3. Flip a bit in the 16-byte authentication tag
    const flippedTag = Buffer.from(originalBuf);
    const lastIndex = flippedTag.length - 1;
    flippedTag[lastIndex] = (flippedTag[lastIndex] ?? 0) ^ 0x80;
    expect(() => decrypt(flippedTag.toString('base64'), keyVersion, keyring)).toThrowError(
      TamperedDataError,
    );

    // 4. Malformed / truncated payloads
    expect(() => decrypt('not-valid-base64!!!', keyVersion, keyring)).toThrowError(
      TamperedDataError,
    );
    expect(() => decrypt(Buffer.alloc(10).toString('base64'), keyVersion, keyring)).toThrowError(
      TamperedDataError,
    );
  });

  it('fails with WrongKeyError when decrypting with the wrong key', () => {
    const ciphertext = encryptWithKey('Private journal entry', KEY_V1_HEX);

    expect(() => decryptWithKey(ciphertext, KEY_V2_HEX)).toThrowError(WrongKeyError);

    // Also fails when keyring maps version 1 to a different key than was used to encrypt
    const wrongKeyring = new Keyring({
      currentVersion: 1,
      keys: { 1: KEY_V2_HEX },
    });
    expect(() => decrypt(ciphertext, 1, wrongKeyring)).toThrowError(WrongKeyError);
  });

  it('fails with UnknownKeyVersionError when decrypting an unknown key_version', () => {
    const keyring = new Keyring({
      currentVersion: 1,
      keys: { 1: KEY_V1_HEX },
    });
    const { ciphertext } = encrypt('Hello', keyring);

    expect(() => decrypt(ciphertext, 99, keyring)).toThrowError(UnknownKeyVersionError);
  });

  it('binds ciphertext to its row via Associated Data (AAD) so ciphertext copied between rows fails to decrypt', () => {
    const keyring = new Keyring({
      currentVersion: 1,
      keys: { 1: KEY_V1_HEX },
    });

    const user1Aad = buildEntryAad(42n, '2026-11-15');
    const user2Aad = buildEntryAad(99n, '2026-11-15');
    const differentDateAad = buildEntryAad(42n, '2026-11-16');

    const { ciphertext, keyVersion } = encrypt('My private entry for Nov 15', keyring, {
      associatedData: user1Aad,
    });

    // Decrypting with matching row AAD succeeds
    expect(decrypt(ciphertext, keyVersion, keyring, { associatedData: user1Aad })).toBe(
      'My private entry for Nov 15',
    );

    // Copying ciphertext to another user's row or another date fails authentication
    expect(() =>
      decrypt(ciphertext, keyVersion, keyring, { associatedData: user2Aad }),
    ).toThrowError(WrongKeyError);
    expect(() =>
      decrypt(ciphertext, keyVersion, keyring, { associatedData: differentDateAad }),
    ).toThrowError(WrongKeyError);
    expect(() => decrypt(ciphertext, keyVersion, keyring)).toThrowError(WrongKeyError);
  });

  it('never leaks plaintext or key material in any EncryptionError message or stack', () => {
    const sensitivePlaintext = 'ULTRA_SENSITIVE_JOURNAL_CONFESSION_883920';
    const ciphertext = encryptWithKey(sensitivePlaintext, KEY_V1_HEX);

    const actions: Array<() => unknown> = [
      () => parseEncryptionKey('short-key-material-secret'),
      () => decryptWithKey(ciphertext, KEY_V2_HEX),
      () => decryptWithKey('invalid-base64-payload-!@#', KEY_V1_HEX),
      () => decrypt(ciphertext, 7, new Keyring({ currentVersion: 1, keys: { 1: KEY_V1_HEX } })),
    ];

    for (const action of actions) {
      try {
        action();
        expect.unreachable('Expected encryption error to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EncryptionError);
        const serialized = `${(err as Error).message} ${(err as Error).stack ?? ''}`;
        expect(serialized).not.toContain(sensitivePlaintext);
        expect(serialized).not.toContain(KEY_V1_HEX);
        expect(serialized).not.toContain(KEY_V2_HEX);
        expect(serialized).not.toContain('short-key-material-secret');
      }
    }
  });

  it('supports key rotation: write with v1, add v2 as current, old v1 data still reads, and re-encrypt utility migrates rows in resumable batches', async () => {
    // Step 1: Start with keyring at v1
    const keyringV1 = createKeyringFromEnv({
      ENCRYPTION_KEY_CURRENT_VERSION: '1',
      ENCRYPTION_KEY_V1: KEY_V1_HEX,
    });

    const entry1Aad = buildEntryAad(1n, '2026-11-10');
    const entry2Aad = buildEntryAad(1n, '2026-11-11');
    const entry3Aad = buildEntryAad(2n, '2026-11-12');
    const summary1Aad = buildSummaryAad(1n, '2026-11-09', 'summary');
    const themes1Aad = buildSummaryAad(1n, '2026-11-09', 'themes');

    const enc1 = encrypt('Entry one written under key v1', keyringV1, {
      associatedData: entry1Aad,
    });
    const enc2 = encrypt('Entry two written under key v1', keyringV1, {
      associatedData: entry2Aad,
    });
    const enc3 = encrypt('Entry three written under key v1', keyringV1, {
      associatedData: entry3Aad,
    });
    const sumEnc1 = encrypt('Weekly summary markdown under v1', keyringV1, {
      associatedData: summary1Aad,
    });
    const thmEnc1 = encrypt('["gratitude","focus"]', keyringV1, {
      associatedData: themes1Aad,
    });

    expect(enc1.keyVersion).toBe(1);

    // Step 2: Add v2 as current version in keyring while keeping v1
    const keyringV2 = createKeyringFromEnv({
      ENCRYPTION_KEY_CURRENT_VERSION: '2',
      ENCRYPTION_KEY_V1: KEY_V1_HEX,
      ENCRYPTION_KEY_V2: KEY_V2_HEX,
    });

    expect(keyringV2.currentVersion).toBe(2);

    // New writes use v2
    const entry4Aad = buildEntryAad(2n, '2026-11-13');
    const enc4 = encrypt('Entry four written under key v2', keyringV2, {
      associatedData: entry4Aad,
    });
    expect(enc4.keyVersion).toBe(2);

    // Old v1 data still reads seamlessly through keyringV2
    expect(
      decrypt(enc1.ciphertext, enc1.keyVersion, keyringV2, { associatedData: entry1Aad }),
    ).toBe('Entry one written under key v1');

    // Step 3: Populate storage with 3 v1 entries, 1 v2 entry, and 1 v1 summary
    const { entriesStore, summariesStore, adapter } = createInMemoryStorage(
      [
        {
          id: 1n,
          userId: 1n,
          entryDate: '2026-11-10',
          contentEnc: enc1.ciphertext,
          keyVersion: 1,
        },
        {
          id: 2n,
          userId: 1n,
          entryDate: '2026-11-11',
          contentEnc: enc2.ciphertext,
          keyVersion: 1,
        },
        {
          id: 3n,
          userId: 2n,
          entryDate: '2026-11-12',
          contentEnc: enc3.ciphertext,
          keyVersion: 1,
        },
        {
          id: 4n,
          userId: 2n,
          entryDate: '2026-11-13',
          contentEnc: enc4.ciphertext,
          keyVersion: 2,
        },
      ],
      [
        {
          id: 10n,
          userId: 1n,
          weekStart: '2026-11-09',
          summaryEnc: sumEnc1.ciphertext,
          themesEnc: thmEnc1.ciphertext,
          keyVersion: 1,
        },
      ],
    );

    // Simulate partial run (batchSize: 2, maxBatches: 1) to verify safe resumability
    const partialResult = await reencryptAll({
      keyring: keyringV2,
      storage: adapter,
      batchSize: 2,
      maxBatches: 1,
    });

    expect(partialResult.entriesMigrated).toBe(2);
    expect(partialResult.summariesMigrated).toBe(0);
    expect(entriesStore[0]?.keyVersion).toBe(2);
    expect(entriesStore[1]?.keyVersion).toBe(2);
    expect(entriesStore[2]?.keyVersion).toBe(1); // Not yet migrated

    // Resume and complete remaining batches
    const resumedResult = await reencryptAll({
      keyring: keyringV2,
      storage: adapter,
      batchSize: 2,
    });

    expect(resumedResult.entriesMigrated).toBe(1);
    expect(resumedResult.summariesMigrated).toBe(1);

    // Every row is now at keyVersion 2, and ciphertexts were rotated
    for (const row of entriesStore) {
      expect(row.keyVersion).toBe(2);
    }
    expect(entriesStore[0]?.contentEnc).not.toBe(enc1.ciphertext);
    expect(summariesStore[0]?.keyVersion).toBe(2);

    // Verify all migrated rows decrypt with a keyring that ONLY has v2 (v1 retired)
    const keyringV2Only = new Keyring({
      currentVersion: 2,
      keys: { 2: KEY_V2_HEX },
    });

    expect(
      decrypt(entriesStore[0]!.contentEnc, entriesStore[0]!.keyVersion, keyringV2Only, {
        associatedData: entry1Aad,
      }),
    ).toBe('Entry one written under key v1');
    expect(
      decrypt(entriesStore[1]!.contentEnc, entriesStore[1]!.keyVersion, keyringV2Only, {
        associatedData: entry2Aad,
      }),
    ).toBe('Entry two written under key v1');
    expect(
      decrypt(entriesStore[2]!.contentEnc, entriesStore[2]!.keyVersion, keyringV2Only, {
        associatedData: entry3Aad,
      }),
    ).toBe('Entry three written under key v1');
    expect(
      decrypt(summariesStore[0]!.summaryEnc!, summariesStore[0]!.keyVersion, keyringV2Only, {
        associatedData: summary1Aad,
      }),
    ).toBe('Weekly summary markdown under v1');
    expect(
      decrypt(summariesStore[0]!.themesEnc!, summariesStore[0]!.keyVersion, keyringV2Only, {
        associatedData: themes1Aad,
      }),
    ).toBe('["gratitude","focus"]');
  });

  it('validates 32-byte key length at startup across hex, base64, ENCRYPTION_KEY_V<n>, and ENCRYPTION_KEYS_JSON', () => {
    // Valid 32-byte base64 key
    expect(parseEncryptionKey(KEY_V3_BASE64).length).toBe(32);

    // Reject 16-byte or 31-byte keys
    expect(() => parseEncryptionKey(crypto.randomBytes(16).toString('hex'))).toThrowError(
      InvalidKeyLengthError,
    );
    expect(() => parseEncryptionKey(crypto.randomBytes(31).toString('base64'))).toThrowError(
      InvalidKeyLengthError,
    );

    // Startup loadConfig fails if ENCRYPTION_KEY_CURRENT_VERSION points to a version not in the keyring
    const baseEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PORT: '3000',
      APP_BASE_URL: 'http://localhost:5173',
      TRUST_PROXY: '1',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/firstwrite',
      ENCRYPTION_KEY_CURRENT_VERSION: '2',
      ENCRYPTION_KEY_V1: KEY_V1_HEX,
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

    expect(() => loadConfig(baseEnv)).toThrowError(/Unknown encryption key version: 2/);

    // Startup loadConfig fails if a secondary key (ENCRYPTION_KEY_V2) is not 32 bytes
    expect(() =>
      loadConfig({
        ...baseEnv,
        ENCRYPTION_KEY_V2: 'too-short-v2-key',
      }),
    ).toThrowError(/must be.*32 bytes/);
  });
});

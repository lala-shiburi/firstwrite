Brief 2: Encryption module
Goal: A small, well-tested internal library that all other code uses to protect journal
content.
Requirements:
Functions to encrypt and decrypt a string using AES-256-GCM with a fresh random
nonce for each encryption, producing a single text value of the form base64(nonce +
ciphertext + auth tag), matching the content_enc and summary_enc columns.
Support key versioning: a keyring configured via environment variables mapping
version numbers to keys, a "current version" used for new writes, and decryption that
selects the key by the stored key_version .
Morning Pages: Agent Briefs
Page 3 of 12
Optionally bind each ciphertext to its row using associated data (e.g. user id and
entry date) so ciphertext copied between rows fails to decrypt. Document the choice.
A re-encryption utility (script or job) that rewrites rows from an old key version to the
current one in batches, safely resumable.
Clear error types: wrong key, tampered data, unknown key version. Errors must never
include plaintext or key material.
Acceptance criteria:
Round-trip tests, tamper tests (flipped byte fails), wrong-key tests, and a test that
two encryptions of the same text differ.
A key-rotation test: write with v1, add v2 as current, old data still reads, re-encrypt
script migrates it.
Key length is validated at startup (32 bytes).

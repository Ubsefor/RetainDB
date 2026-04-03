/**
 * At-rest encryption for sensitive memory content.
 * AES-256-GCM with per-org derived keys via HMAC-SHA256.
 *
 * Enable by setting ENCRYPTION_MASTER_KEY in your environment:
 *   - 64-char hex string (32 bytes), e.g. `openssl rand -hex 32`
 *   - Or any passphrase (derived via scrypt internally)
 *
 * When the env var is absent, all functions are no-ops (passthrough).
 * Encrypted values are prefixed with "enc:v1:" for safe forward compatibility.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const TAG_LENGTH = 16;
const NONCE_LENGTH = 12;
const ENCRYPTED_PREFIX = "enc:v1:";

let cachedMasterKey: Buffer | null | undefined = undefined; // undefined = not yet read

function getMasterKey(): Buffer | null {
  if (cachedMasterKey !== undefined) return cachedMasterKey;
  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (!raw) {
    cachedMasterKey = null;
    return null;
  }
  const hex = raw.replace(/^0x/i, "");
  if (hex.length === 64 && /^[0-9a-f]+$/i.test(hex)) {
    cachedMasterKey = Buffer.from(hex, "hex");
  } else {
    // Passphrase — derive 32 bytes with scrypt
    cachedMasterKey = scryptSync(raw, "retaindb-encryption-salt-v1", 32) as Buffer;
  }
  return cachedMasterKey;
}

function deriveOrgKey(masterKey: Buffer, orgId: string): Buffer {
  return createHmac("sha256", masterKey)
    .update(`retaindb:org-key:v1:${orgId}`)
    .digest();
}

function getKey(orgId?: string): Buffer | null {
  const master = getMasterKey();
  if (!master) return null;
  if (orgId) return deriveOrgKey(master, orgId);
  // No orgId — use master key directly (e.g. for shared/system writes)
  return master;
}

export function isEncryptionEnabled(): boolean {
  return getMasterKey() !== null;
}

/**
 * Encrypt a plaintext string. Returns an "enc:v1:..." string.
 * If encryption is not configured, returns plaintext unchanged.
 */
export function encrypt(plaintext: string, orgId?: string): string {
  const key = getKey(orgId);
  if (!key) return plaintext;

  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH } as any);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${nonce.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a value previously encrypted with encrypt().
 * If the value is not encrypted (no prefix), returns it unchanged.
 * On decryption failure (wrong key, tampered data), returns original value and logs a warning.
 */
export function decrypt(value: string, orgId?: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;

  const key = getKey(orgId);
  if (!key) {
    // Encrypted data but no key configured — cannot decrypt
    console.warn("[Encryption] Found encrypted value but ENCRYPTION_MASTER_KEY is not set");
    return value;
  }

  const rest = value.slice(ENCRYPTED_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) {
    console.warn("[Encryption] Malformed encrypted value — returning as-is");
    return value;
  }

  const [nonceHex, tagHex, ciphertextHex] = parts;
  try {
    const nonce = Buffer.from(nonceHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH } as any);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
  } catch (err) {
    console.warn("[Encryption] Decryption failed (wrong key or tampered data) — returning raw value:", err);
    return value;
  }
}

/**
 * Returns true if the value looks like an encrypted blob.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

// Reset cached key — used in tests when ENCRYPTION_MASTER_KEY changes
export function _resetKeyCache(): void {
  cachedMasterKey = undefined;
}

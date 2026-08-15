import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { keyFile, sessionFile } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

async function loadOrCreateKey(): Promise<Buffer> {
  const path = keyFile();
  if (existsSync(path)) {
    return Buffer.from(await readFile(path, 'utf8'), 'base64');
  }
  await mkdir(dirname(path), { recursive: true });
  const key = randomBytes(32);
  await writeFile(path, key.toString('base64'), { mode: 0o600 });
  // chmod is a no-op on Windows; the file still sits under the user profile.
  await chmod(path, 0o600).catch(() => {});
  return key;
}

/** Encrypt to `iv | authTag | ciphertext`, base64 on disk. */
export async function saveSecret(value: unknown): Promise<void> {
  const key = await loadOrCreateKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

  const path = sessionFile();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, blob.toString('base64'), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export async function loadSecret<T>(): Promise<T | null> {
  const path = sessionFile();
  if (!existsSync(path)) return null;
  try {
    const blob = Buffer.from(await readFile(path, 'utf8'), 'base64');
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = blob.subarray(IV_LEN + TAG_LEN);

    const decipher = createDecipheriv(ALGO, await loadOrCreateKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    // Corrupt or key-mismatched store is indistinguishable from no store —
    // either way the fix is to log in again.
    return null;
  }
}

export async function clearSecret(): Promise<void> {
  await rm(sessionFile(), { force: true });
}

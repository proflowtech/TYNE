// Shared AES-GCM encryption for OAuth tokens at rest.
// Uses Web Crypto API (available in Deno). The master key is read from the
// TOKEN_ENCRYPTION_KEY environment variable (64-char hex = 256 bits).

const KEY_ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const hexKey = Deno.env.get('TOKEN_ENCRYPTION_KEY');
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be set to a 64-char hex string (256 bits)');
  }
  const keyBytes = new Uint8Array(hexKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  cachedKey = await crypto.subtle.importKey('raw', keyBytes, { name: KEY_ALGORITHM, length: KEY_LENGTH }, false, ['encrypt', 'decrypt']);
  return cachedKey;
}

export async function encryptToken(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: KEY_ALGORITHM, iv }, key, encoded));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptToken(encrypted: string): Promise<string> {
  if (!encrypted) return '';
  const key = await getKey();
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt({ name: KEY_ALGORITHM, iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

export function isEncrypted(value: string): boolean {
  if (!value) return false;
  try {
    const combined = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    return combined.length > IV_LENGTH;
  } catch {
    return false;
  }
}

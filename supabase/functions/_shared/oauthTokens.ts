// One place for OAuth-token-at-rest handling, so every function reads and
// writes credentials the same way and no path can silently fall back to
// plaintext. Reads are tolerant of legacy plaintext rows (returned untouched by
// decryptToken); writes always seal.

import { encryptToken, decryptToken, isEncrypted } from './crypto.ts';

/** Seal a token for storage. Empty in -> empty out. */
export async function sealToken(plaintext: string | null | undefined): Promise<string> {
  return plaintext ? await encryptToken(plaintext) : '';
}

/**
 * Read a stored token. Handles the transition window: a value we sealed is
 * decrypted; a legacy plaintext value is returned as-is. `plainFallback` covers
 * schemas that kept a separate plaintext column during migration.
 */
export async function openToken(stored: string | null | undefined, plainFallback?: string | null): Promise<string> {
  if (stored && isEncrypted(stored)) {
    const opened = await decryptToken(stored).catch(() => '');
    if (opened) return opened;
  }
  return stored || plainFallback || '';
}

/** True when a stored value still needs sealing (present but not our ciphertext). */
export function needsSealing(stored: string | null | undefined): boolean {
  return !!stored && !isEncrypted(stored);
}

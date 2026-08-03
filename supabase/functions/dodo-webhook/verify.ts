const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Verifies a Dodo Payments webhook signature.
 *
 * Dodo follows the Standard Webhooks spec (svix-style headers):
 *   - webhook-id, webhook-timestamp, webhook-signature
 *   - signed content is `${id}.${timestamp}.${body}`
 *   - the secret is `whsec_<base64>`; the HMAC key is the base64-decoded bytes
 *   - the signature is base64, and the header is a space-separated list of
 *     `v1,<base64sig>` entries.
 *
 * We compute the Standard Webhooks (base64) signature as the primary check and
 * also a legacy hex/raw-secret variant for backward compatibility, then compare
 * every provided signature against both using a constant-time comparison. Any
 * match passes; otherwise the request is rejected (fail closed).
 */
export async function verifyWebhookSignature(req: Request, secret: string): Promise<boolean> {
  const webhookId = req.headers.get('webhook-id')
  const webhookTimestamp = req.headers.get('webhook-timestamp')
  const webhookSignature = req.headers.get('webhook-signature')

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return false
  }

  const timestamp = parseInt(webhookTimestamp, 10)
  if (Number.isNaN(timestamp)) {
    return false
  }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_MS / 1000) {
    return false
  }

  // Clone the request so the original body is preserved for later parsing.
  const rawBody = await req.clone().text()
  const signedMessage = `${webhookId}.${webhookTimestamp}.${rawBody}`
  const encoder = new TextEncoder()

  // Build the set of acceptable signatures we can compute from the secret.
  const expected: string[] = []

  // Variant A — Standard Webhooks: base64 signature, whsec_-decoded key.
  try {
    const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
    const keyBytes = base64ToBytes(rawSecret)
    if (keyBytes) {
      const key = await crypto.subtle.importKey(
        'raw', Uint8Array.from(keyBytes).buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      )
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedMessage))
      expected.push(bytesToBase64(new Uint8Array(sig)))
    }
  } catch {
    // Ignore and fall back to the legacy variant.
  }

  // Variant B — legacy: hex signature, raw (non-decoded) secret bytes.
  try {
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedMessage))
    expected.push(bytesToHex(new Uint8Array(sig)))
  } catch {
    // Ignore.
  }

  if (expected.length === 0) {
    return false
  }

  // The header is a space-separated list of entries; each entry may be a bare
  // signature or carry a version prefix (`v1,<sig>` per spec, or legacy `v1=<sig>`).
  const provided = webhookSignature
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(stripVersionPrefix)
    .filter(Boolean)

  for (const candidate of provided) {
    for (const exp of expected) {
      if (constantTimeCompare(candidate, exp)) {
        return true
      }
    }
  }
  return false
}

function stripVersionPrefix(entry: string): string {
  // Handles "v1,<sig>", "v1=<sig>", "v1a,<sig>", and bare "<sig>".
  const commaIdx = entry.indexOf(',')
  if (commaIdx !== -1 && /^v\d+[a-z]?$/i.test(entry.slice(0, commaIdx))) {
    return entry.slice(commaIdx + 1)
  }
  if (entry.startsWith('v1=')) {
    return entry.slice(3)
  }
  return entry
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    // Support both standard and URL-safe base64.
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(normalized)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i])
  }
  return btoa(bin)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

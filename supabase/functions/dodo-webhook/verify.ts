const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000 // 5 minutes

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
  const bodyReq = req.clone()
  const rawBody = await bodyReq.text()
  const signedMessage = `${webhookId}.${webhookTimestamp}.${rawBody}`

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedMessage))
  const computedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  const signatures = webhookSignature.split(',').map(s => s.trim()).filter(Boolean)
  for (const sig of signatures) {
    const expected = sig.startsWith('v1=') ? sig.slice(3) : sig
    if (constantTimeCompare(expected, computedSignature)) {
      return true
    }
  }
  return false
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

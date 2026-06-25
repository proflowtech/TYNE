import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { verifyWebhookSignature } from './verify.ts'

async function sign(secret: string, webhookId: string, timestamp: string, body: string): Promise<string> {
  const signedMessage = `${webhookId}.${timestamp}.${body}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedMessage))
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return signature
}

Deno.test('accepts valid Dodo webhook signature', async () => {
  const secret = 'whsec_test_secret'
  const webhookId = 'msg_123'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const body = JSON.stringify({ event_type: 'subscription.active', payload: { id: 'sub_123' } })
  const signature = await sign(secret, webhookId, timestamp, body)

  const req = new Request('https://example.com/webhook', {
    method: 'POST',
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1=${signature}`,
    },
    body,
  })

  const ok = await verifyWebhookSignature(req, secret)
  assertEquals(ok, true)
})

Deno.test('rejects invalid Dodo webhook signature', async () => {
  const secret = 'whsec_test_secret'
  const body = JSON.stringify({ event_type: 'subscription.active' })
  const timestamp = Math.floor(Date.now() / 1000).toString()

  const req = new Request('https://example.com/webhook', {
    method: 'POST',
    headers: {
      'webhook-id': 'msg_123',
      'webhook-timestamp': timestamp,
      'webhook-signature': 'v1=invalid',
    },
    body,
  })

  const ok = await verifyWebhookSignature(req, secret)
  assertEquals(ok, false)
})

Deno.test('rejects stale timestamp', async () => {
  const secret = 'whsec_test_secret'
  const body = JSON.stringify({ event_type: 'subscription.active' })
  const timestamp = (Math.floor(Date.now() / 1000) - 10 * 60).toString()
  const signature = await sign(secret, 'msg_123', timestamp, body)

  const req = new Request('https://example.com/webhook', {
    method: 'POST',
    headers: {
      'webhook-id': 'msg_123',
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1=${signature}`,
    },
    body,
  })

  const ok = await verifyWebhookSignature(req, secret)
  assertEquals(ok, false)
})

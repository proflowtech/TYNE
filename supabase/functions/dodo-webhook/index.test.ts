import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { verifyWebhookSignature } from './verify.ts'

async function sign(
  keyBytes: Uint8Array,
  webhookId: string,
  timestamp: string,
  body: string,
  encoding: 'base64' | 'hex',
): Promise<string> {
  const signedMessage = `${webhookId}.${timestamp}.${body}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(keyBytes).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedMessage))
  const bytes = new Uint8Array(signatureBuffer)
  if (encoding === 'base64') {
    return btoa(String.fromCharCode(...bytes))
  }
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

Deno.test('accepts Standard Webhooks base64 signature', async () => {
  const keyBytes = new TextEncoder().encode('test-secret')
  const secret = `whsec_${btoa(String.fromCharCode(...keyBytes))}`
  const webhookId = 'msg_123'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const body = JSON.stringify({ type: 'subscription.active', data: { subscription_id: 'sub_123' } })
  const signature = await sign(keyBytes, webhookId, timestamp, body, 'base64')

  const req = new Request('https://example.com/webhook', {
    method: 'POST',
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,invalid v1,${signature}`,
    },
    body,
  })

  const ok = await verifyWebhookSignature(req, secret)
  assertEquals(ok, true)
})

Deno.test('accepts legacy raw-secret hex signature', async () => {
  const secret = 'whsec_test_secret'
  const webhookId = 'msg_legacy'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const body = JSON.stringify({ type: 'subscription.active' })
  const signature = await sign(new TextEncoder().encode(secret), webhookId, timestamp, body, 'hex')
  const req = new Request('https://example.com/webhook', {
    method: 'POST',
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1=${signature}`,
    },
    body,
  })

  assertEquals(await verifyWebhookSignature(req, secret), true)
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
  const signature = await sign(new TextEncoder().encode(secret), 'msg_123', timestamp, body, 'hex')

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

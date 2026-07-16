export const AICREDITS_BASE_URL = 'https://api.aicredits.in/v1'

export type AicreditsTier = 'free' | 'pro' | 'max'

export type AicreditsFeature =
  | 'generate_commit'
  | 'generate_commit_deep_review'
  | 'code_review'
  | 'pm_task_intelligence'
  | 'pm_task_normalization'
  | 'pm_task_validation'
  | 'validate_review_primary'
  | 'validate_review_secondary'

export type AicreditsLlmConfig = {
  provider: 'openai'
  apiKey: string
  baseUrl: string
  model: string
}

const MODEL_CANDIDATES: Record<AicreditsFeature, Record<AicreditsTier, string[]>> = {
  generate_commit: {
    free: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    pro: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    max: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
  },
  generate_commit_deep_review: {
    free: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
    pro: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
    max: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
  },
  code_review: {
    free: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    pro: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
    max: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
  },
  pm_task_intelligence: {
    free: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    pro: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    max: ['google/gemini-2.5-pro', 'deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
  },
  pm_task_normalization: {
    free: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
    pro: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
    max: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
  },
  pm_task_validation: {
    free: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    pro: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
    max: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
  },
  validate_review_primary: {
    free: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    pro: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
    max: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
  },
  validate_review_secondary: {
    free: [],
    pro: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    max: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
  },
}

let supportedModelIdsCache: string[] | null = null

export function normalizeAicreditsTier(rawTier: string): AicreditsTier {
  const tier = rawTier.toLowerCase()
  if (tier === 'pro') return 'pro'
  if (tier === 'max') return 'max'
  return 'free'
}

export function readAicreditsApiKey(): string | null {
  const value = Deno.env.get('AICREDITS_API_KEY')?.replace(/\s+/g, '')
  return value ? value : null
}

export async function fetchAicreditsModelIds(apiKey = readAicreditsApiKey()): Promise<string[]> {
  if (!apiKey) throw new Error('AICREDITS_API_KEY is missing')
  if (supportedModelIdsCache) return supportedModelIdsCache
  const res = await fetch(`${AICREDITS_BASE_URL}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AICredits models lookup failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const payload = await res.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null
  supportedModelIdsCache = (payload?.data || [])
    .map(model => typeof model.id === 'string' ? model.id.trim() : '')
    .filter(Boolean)
  return supportedModelIdsCache
}

export async function logAicreditsSupportedModels(): Promise<string[]> {
  const ids = await fetchAicreditsModelIds()
  console.log(JSON.stringify({ event: 'aicredits_supported_models', count: ids.length, modelIds: ids }))
  return ids
}

export async function getAicreditsModelFallbacks(feature: AicreditsFeature, tier: string, override?: string): Promise<string[]> {
  const supported = new Set(await fetchAicreditsModelIds())
  const normalizedTier = normalizeAicreditsTier(tier)
  const candidates = [
    ...(override ? [override] : []),
    ...(MODEL_CANDIDATES[feature]?.[normalizedTier] || []),
  ]
  const filtered = candidates.filter((model, index) => candidates.indexOf(model) === index && supported.has(model))
  if (filtered.length === 0) {
    throw new Error(`No supported AICredits models found for ${feature}/${normalizedTier}. Check /v1/models.`)
  }
  return filtered
}

export async function resolveAicreditsLlmConfig(feature: AicreditsFeature, tier: string, override?: string): Promise<AicreditsLlmConfig[]> {
  const apiKey = readAicreditsApiKey()
  if (!apiKey) return []
  const models = await getAicreditsModelFallbacks(feature, tier, override)
  return models.map(model => ({
    provider: 'openai' as const,
    apiKey,
    baseUrl: AICREDITS_BASE_URL,
    model,
  }))
}

export function shouldTryNextAicreditsModel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const status = Number(message.match(/\((\d{3})\)/)?.[1] || 0)
  if (status === 404 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true
  return /No endpoints found|model.*not.*found|not found|route.*unavailable|endpoint/i.test(message)
}

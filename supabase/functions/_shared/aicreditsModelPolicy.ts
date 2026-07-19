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
  | 'validate_review_chunk'
  | 'validate_review_final'

export type AicreditsLlmConfig = {
  provider: 'openai'
  apiKey: string
  baseUrl: string
  model: string
}

/** Soft preference hints only — full live catalog is appended after these. */
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
  validate_review_chunk: {
    free: ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'],
    pro: [
      'deepseek/deepseek-v4-pro',
      'kimi/kimi-code',
      'google/gemini-2.5-flash',
      'mistralai/mistral-large',
      'nvidia/llama',
      'z-ai/glm',
    ],
    max: [
      'deepseek/deepseek-v4-pro',
      'kimi/kimi-code',
      'google/gemini-2.5-flash',
      'mistralai/mistral-large',
      'nvidia/llama',
      'z-ai/glm',
      'google/gemini-2.5-pro',
    ],
  },
  validate_review_final: {
    free: [],
    pro: [],
    max: [
      'anthropic/claude-sonnet-4',
      'anthropic/claude-3.7-sonnet',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-v4-pro',
    ],
  },
}

const CHUNK_PREFERENCE_RE = /deepseek|kimi|mistral|glm|nvidia|flash|qwen|llama|codellama|codestral/i
const FINAL_PREFERENCE_RE = /claude|anthropic|gemini-2\.5-pro|gemini-pro|gpt-4|o3|o1/i

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

function dedupePreserve(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Match preference prefixes/substrings against live catalog IDs. */
export function expandPreferenceHints(hints: string[], catalog: string[]): string[] {
  const matched: string[] = []
  for (const hint of hints) {
    const exact = catalog.find(id => id === hint)
    if (exact) {
      matched.push(exact)
      continue
    }
    const needle = hint.toLowerCase()
    for (const id of catalog) {
      if (id.toLowerCase().includes(needle) || needle.includes(id.toLowerCase())) {
        matched.push(id)
      }
    }
  }
  return dedupePreserve(matched)
}

/**
 * Soft preferences first, then the rest of the live AICredits catalog.
 * Chunk prefers fast/code models; final prefers Claude-class judges.
 */
export function buildCatalogAwareCandidates(
  feature: AicreditsFeature,
  tier: AicreditsTier,
  catalog: string[],
  override?: string,
): string[] {
  const hints = MODEL_CANDIDATES[feature]?.[tier] || []
  const preferred = expandPreferenceHints(hints, catalog)

  let rest = catalog.slice().sort((a, b) => a.localeCompare(b))
  if (feature === 'validate_review_chunk') {
    rest = rest.sort((a, b) => Number(CHUNK_PREFERENCE_RE.test(b)) - Number(CHUNK_PREFERENCE_RE.test(a)))
  }
  if (feature === 'validate_review_final') {
    rest = rest.sort((a, b) => Number(FINAL_PREFERENCE_RE.test(b)) - Number(FINAL_PREFERENCE_RE.test(a)))
  }

  const combined = dedupePreserve([
    ...(override ? [override] : []),
    ...preferred,
    ...rest,
  ]).filter(id => catalog.includes(id))

  if (feature === 'validate_review_final' && tier !== 'max') {
    return []
  }
  if (feature === 'validate_review_secondary' && tier === 'free') {
    return []
  }
  return combined
}

export async function getAicreditsModelFallbacks(
  feature: AicreditsFeature,
  tier: string,
  override?: string,
  options?: { maxCandidates?: number },
): Promise<string[]> {
  const catalog = await fetchAicreditsModelIds()
  const normalizedTier = normalizeAicreditsTier(tier)
  const useCatalog = feature === 'validate_review_chunk' || feature === 'validate_review_final'
  const candidates = useCatalog
    ? buildCatalogAwareCandidates(feature, normalizedTier, catalog, override)
    : dedupePreserve([
      ...(override ? [override] : []),
      ...(MODEL_CANDIDATES[feature]?.[normalizedTier] || []),
    ]).filter(model => catalog.includes(model))

  const filtered = candidates.slice(0, maxCandidates)
  if (filtered.length === 0) {
    if (
      feature === 'validate_review_final'
      || (feature === 'validate_review_secondary' && normalizedTier === 'free')
    ) {
      return []
    }
    throw new Error(`No supported AICredits models found for ${feature}/${normalizedTier}. Check /v1/models.`)
  }
  return filtered
}

export async function resolveAicreditsLlmConfig(
  feature: AicreditsFeature,
  tier: string,
  override?: string,
  options?: { maxCandidates?: number },
): Promise<AicreditsLlmConfig[]> {
  const apiKey = readAicreditsApiKey()
  if (!apiKey) return []
  try {
    const models = await getAicreditsModelFallbacks(feature, tier, override, options)
    return models.map(model => ({
      provider: 'openai' as const,
      apiKey,
      baseUrl: AICREDITS_BASE_URL,
      model,
    }))
  } catch {
    if (feature === 'validate_review_final' || feature === 'validate_review_secondary') return []
    throw new Error(`No supported AICredits models found for ${feature}`)
  }
}

/** Round-robin starting model for a pack index, then up to maxFallbacks configs. */
export function rotateConfigsForPack<T extends { model: string }>(
  configs: T[],
  packIndex: number,
  maxFallbacks = 2,
): T[] {
  if (!configs.length) return []
  const start = ((packIndex % configs.length) + configs.length) % configs.length
  const rotated = [...configs.slice(start), ...configs.slice(0, start)]
  return rotated.slice(0, Math.max(1, maxFallbacks))
}

export function shouldTryNextAicreditsModel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const status = Number(message.match(/\((\d{3})\)/)?.[1] || 0)
  if (status === 404 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true
  return /No endpoints found|model.*not.*found|not found|route.*unavailable|endpoint/i.test(message)
}

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  resolveAicreditsLlmConfig,
  shouldTryNextAicreditsModel,
} from '../_shared/aicreditsModelPolicy.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_DIFF_LENGTH = 25_000

export type TyneReviewMode =
  | 'staged_changes'
  | 'current_branch'
  | 'pm_task'
  | 'before_commit'
  | 'before_pr'

export type TynePmAlignment = {
  status: 'aligned' | 'partially_aligned' | 'not_aligned' | 'unknown'
  completedGoals: string[]
  pendingGoals: string[]
}

export type TynePmValidation = {
  status: 'addressed' | 'not_addressed' | 'unclear' | 'unknown'
  issueIdentifier: string | undefined
  summary: string | undefined
  completedRequirements: string[]
  gaps: string[]
  actionRequired: string | undefined
}

export type TyneReviewEffort = {
  score: 1 | 2 | 3 | 4 | 5
  label: string
  estimatedMinutes: number
  reason: string | undefined
}

export type TyneSequenceDiagram = {
  title: string
  mermaid: string
  relatedFiles: string[]
}

export type TyneChangedFilesSummary = {
  title: string
  files: string[]
  summary: string
}

export type TyneReviewDetails = {
  reviewedFileCount: number
  filesSelected: string[]
  filesSkipped: string[]
  noReviewableChangeFiles: string[]
}

export type TyneMustFixItem = {
  title: string
  file: string | undefined
  line: number | undefined
  category: 'correctness' | 'security' | 'performance' | 'test_coverage' | 'maintainability'
  severity: 'critical' | 'high' | 'medium'
  reason: string
  suggestedFix: string | undefined
}

export type TyneSuggestionItem = {
  title: string
  file: string | undefined
  line: number | undefined
  reason: string
  suggestedFix: string | undefined
}

export type TyneGoodPointItem = {
  title: string
  evidence: string | undefined
}

export type TyneMissingTestItem = {
  title: string
  testType: 'unit' | 'integration' | 'e2e' | 'manual'
  relatedFile: string | undefined
  reason: string
}

export type TyneInlineCommentItem = {
  file: string
  line: number | undefined
  severity: 'critical' | 'high' | 'medium' | 'low'
  category: string
  title: string | undefined
  comment: string
  body: string | undefined
  suggestion: string | undefined
  diffSuggestion: string | undefined
  committableSuggestion: boolean | undefined
}

export type TyneCodeReviewResult = {
  status: 'passed' | 'needs_work' | 'blocked'
  score: number
  riskLevel: 'low' | 'medium' | 'high'
  summary: string
  pmAlignment?: TynePmAlignment
  pmValidation?: TynePmValidation
  reviewEffort: TyneReviewEffort
  sequenceDiagrams: TyneSequenceDiagram[]
  changedFilesSummary: TyneChangedFilesSummary[]
  reviewDetails: TyneReviewDetails
  mustFix: TyneMustFixItem[]
  suggestions: TyneSuggestionItem[]
  goodPoints: TyneGoodPointItem[]
  missingTests: TyneMissingTestItem[]
  inlineComments: TyneInlineCommentItem[]
  fullReport: string | undefined
}

type TynePmSubtask = NonNullable<NonNullable<TyneReviewContextPack['pmTask']>['subtasks']>[number]
type TyneDeveloperTaskPlan = NonNullable<NonNullable<TyneReviewContextPack['pmTask']>['developerTaskPlan']>
type TyneImplementationTask = TyneDeveloperTaskPlan['implementationTasks'][number]
type TyneTestingTask = TyneDeveloperTaskPlan['testingTasks'][number]

export type TyneReviewContextPack = {
  repositoryName: string
  currentBranch: string
  reviewMode: TyneReviewMode

  projectHints: {
    language?: string
    framework?: string
    packageManager?: string
    testFramework?: string
  }

  git: {
    changedFiles: string[]
    stagedDiff?: string
    branchDiff?: string
  }

  pmTask?: {
    source: 'jira' | 'linear'
    issueId?: string
    issueIdentifier?: string
    title: string
    description?: string
    acceptanceCriteria?: string[]
    subtasks?: Array<{
      title: string
      description?: string
      status?: string
    }>
    developerTaskPlan?: {
      issueKey: string
      title: string
      technicalSummary: string
      implementationTasks: Array<{
        title: string
        description: string
        likelyFiles: string[]
        dependencies?: string[]
        status: 'not_started' | 'in_progress' | 'completed'
      }>
      testingTasks: Array<{
        title: string
        testType: 'unit' | 'integration' | 'e2e' | 'manual'
        likelyFiles?: string[]
      }>
      riskNotes: string[]
      questionsForPM?: string[]
    }
  }

  relevantFiles: Array<{
    path: string
    reason: string
    snippet?: string
  }>

  existingTests: Array<{
    path: string
    reason: string
  }>

  guardrails?: {
    requireTests?: boolean
    allowedCommitTypes?: string[]
    customRules?: string[]
  }
}

type ManagedLlmConfig =
  | { provider: 'openai'; apiKey: string; baseUrl: string; model: string }
  | { provider: 'anthropic'; apiKey: string; model: string }

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function readEnvSecret(name: string): string | null {
  const value = Deno.env.get(name)?.replace(/\s+/g, '')
  return value ? value : null
}

function normalizeTier(rawTier: string): 'free' | 'pro' | 'max' {
  const tier = rawTier.toLowerCase()
  if (tier === 'pro') return 'pro'
  if (tier === 'max') return 'max'
  return 'free'
}

function resolveByokConfig(byokKey: string, byokProvider?: string): ManagedLlmConfig {
  const provider = byokProvider === 'openai' ? 'openai' : 'anthropic'
  if (provider === 'openai') {
    return {
      provider: 'openai',
      apiKey: byokKey,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    }
  }
  return { provider: 'anthropic', apiKey: byokKey, model: 'claude-sonnet-5' }
}

async function checkValidationUsage(supabase: any, userId: string, tier: string): Promise<{ allowed: boolean; used: number; limit: number | null; remaining: number | null }> {
  const { data: used, error: usageError } = await supabase.rpc('validation_usage', { uid: userId })
  if (usageError) {
    console.error('validation_usage error:', usageError)
    return { allowed: false, used: 0, limit: null, remaining: null }
  }

  const { data: limit, error: limitError } = await supabase.rpc('tier_validation_limit', { t: tier })
  if (limitError) {
    console.error('tier_validation_limit error:', limitError)
    return { allowed: false, used: Number(used || 0), limit: null, remaining: null }
  }

  const normalizedUsed = Number(used || 0)
  const remaining = limit === null ? null : Math.max(0, Number(limit) - normalizedUsed)
  const allowed = limit === null || normalizedUsed < Number(limit)
  return { allowed, used: normalizedUsed, limit, remaining }
}

function cleanJsonText(raw: string): string {
  return raw.replace(/```(?:json)?\s*|\s*```/g, '').trim()
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean)
}

function truncateDiff(diff: string, max = MAX_DIFF_LENGTH): string {
  if (!diff) return ''
  return diff.length > max ? `${diff.slice(0, max)}\n... [truncated] ...` : diff
}

function sanitizeContextPack(raw: unknown): TyneReviewContextPack | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const allowedModes = new Set<TyneReviewMode>(['staged_changes', 'current_branch', 'pm_task', 'before_commit', 'before_pr'])
  const mode = typeof r.reviewMode === 'string' && allowedModes.has(r.reviewMode as TyneReviewMode)
    ? (r.reviewMode as TyneReviewMode)
    : 'staged_changes'

  const projectHints = typeof r.projectHints === 'object' && r.projectHints !== null
    ? r.projectHints as TyneReviewContextPack['projectHints']
    : {}

  const gitRaw = typeof r.git === 'object' && r.git !== null ? r.git as Record<string, unknown> : {}
  const git: TyneReviewContextPack['git'] = {
    changedFiles: toStringArray(gitRaw.changedFiles).slice(0, 50),
    stagedDiff: typeof gitRaw.stagedDiff === 'string' ? truncateDiff(gitRaw.stagedDiff) : undefined,
    branchDiff: typeof gitRaw.branchDiff === 'string' ? truncateDiff(gitRaw.branchDiff) : undefined,
  }

  const relevantFiles: TyneReviewContextPack['relevantFiles'] = Array.isArray(r.relevantFiles)
    ? (r.relevantFiles.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const path = typeof x.path === 'string' ? x.path.trim() : ''
        if (!path) return null
        return {
          path,
          reason: typeof x.reason === 'string' ? x.reason.slice(0, 240) : '',
          snippet: typeof x.snippet === 'string' ? x.snippet.slice(0, 2000) : undefined,
        }
      }).filter(Boolean) as TyneReviewContextPack['relevantFiles']).slice(0, 15)
    : []

  const existingTests: TyneReviewContextPack['existingTests'] = Array.isArray(r.existingTests)
    ? (r.existingTests.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const path = typeof x.path === 'string' ? x.path.trim() : ''
        if (!path) return null
        return { path, reason: typeof x.reason === 'string' ? x.reason.slice(0, 240) : '' }
      }).filter(Boolean) as TyneReviewContextPack['existingTests']).slice(0, 10)
    : []

  const guardrailsRaw = typeof r.guardrails === 'object' && r.guardrails !== null
    ? r.guardrails as Record<string, unknown>
    : {}
  const guardrails: TyneReviewContextPack['guardrails'] = {
    requireTests: typeof guardrailsRaw.requireTests === 'boolean' ? guardrailsRaw.requireTests : undefined,
    allowedCommitTypes: toStringArray(guardrailsRaw.allowedCommitTypes).slice(0, 10),
    customRules: toStringArray(guardrailsRaw.customRules).slice(0, 10),
  }

  return {
    repositoryName: typeof r.repositoryName === 'string' ? r.repositoryName : 'unknown',
    currentBranch: typeof r.currentBranch === 'string' ? r.currentBranch : '',
    reviewMode: mode,
    projectHints,
    git,
    pmTask: undefined,
    relevantFiles,
    existingTests,
    guardrails,
  }
}

function sanitizeDeveloperTaskPlan(raw: unknown): TyneDeveloperTaskPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>

  const implementationTasks: TyneImplementationTask[] = Array.isArray(r.implementationTasks)
    ? (r.implementationTasks.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const title = typeof x.title === 'string' ? x.title.trim() : ''
        if (!title) return null
        const status = x.status === 'completed' || x.status === 'in_progress' ? x.status : 'not_started'
        return {
          title,
          description: typeof x.description === 'string' ? x.description : '',
          likelyFiles: toStringArray(x.likelyFiles).slice(0, 6),
          dependencies: toStringArray(x.dependencies).slice(0, 5),
          status,
        }
      }).filter(Boolean) as TyneImplementationTask[]).slice(0, 8)
    : []

  const testingTasks: TyneTestingTask[] = Array.isArray(r.testingTasks)
    ? (r.testingTasks.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const title = typeof x.title === 'string' ? x.title.trim() : ''
        if (!title) return null
        const testType = x.testType === 'integration' || x.testType === 'e2e' || x.testType === 'manual' ? x.testType : 'unit'
        return {
          title,
          testType,
          likelyFiles: toStringArray(x.likelyFiles).slice(0, 6),
        }
      }).filter(Boolean) as TyneTestingTask[]).slice(0, 6)
    : []

  if (!implementationTasks.length && !testingTasks.length) return undefined

  return {
    issueKey: typeof r.issueKey === 'string' ? r.issueKey : '',
    title: typeof r.title === 'string' ? r.title : '',
    technicalSummary: typeof r.technicalSummary === 'string' ? r.technicalSummary : '',
    implementationTasks,
    testingTasks,
    riskNotes: toStringArray(r.riskNotes).slice(0, 5),
    questionsForPM: toStringArray(r.questionsForPM).slice(0, 5),
  }
}

function formatContextPack(context: TyneReviewContextPack): string {
  const hints = context.projectHints || {}
  const gitLines = [
    `Review mode: ${context.reviewMode}`,
    `Repository: ${context.repositoryName}`,
    `Current branch: ${context.currentBranch}`,
    `Changed files: ${context.git.changedFiles.join(', ') || 'none'}`,
  ]

  const hintText = Object.entries(hints)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ') || 'none'

  const relevant = context.relevantFiles.map(f => `- ${f.path}: ${f.reason}${f.snippet ? `\n  Snippet:\n${f.snippet}` : ''}`).join('\n') || 'None'
  const tests = context.existingTests.map(f => `- ${f.path}: ${f.reason}`).join('\n') || 'None'

  const guardrails = context.guardrails || {}
  const guardrailLines = [
    guardrails.requireTests ? '- Tests required: yes' : '',
    guardrails.allowedCommitTypes?.length ? `- Allowed commit types: ${guardrails.allowedCommitTypes.join(', ')}` : '',
    guardrails.customRules?.length ? `Custom rules:\n${guardrails.customRules.map(rule => `- ${rule}`).join('\n')}` : '',
  ].filter(Boolean)

  return `Repository Context:
${gitLines.join('\n')}
Project hints: ${hintText}

Relevant files:
${relevant}

Existing tests:
${tests}
${guardrailLines.length ? `\nGuardrails:\n${guardrailLines.join('\n')}` : ''}

Git diff (staged):
\`\`\`
${context.git.stagedDiff || '(no staged diff)'}
\`\`\`

Git diff (branch):
\`\`\`
${context.git.branchDiff || '(no branch diff)'}
\`\`\``
}

function buildReviewPrompt(context: TyneReviewContextPack): string {
  return `You are Tyne, a technical AI Scrum Master and senior code reviewer inside VS Code. Review the code diff using local codebase context, project guardrails, and test files. Return short, actionable technical findings. Do not invent files or line numbers. Mention file paths only when they appear in context. Prioritize correctness, security, missing tests, maintainability, performance, and risky changes.

Scope/task-fit rule:
- Do NOT assess Jira/Linear scope alignment, PM task completion, acceptance criteria, or requirement gaps.
- Do NOT include PM/scope validation in the score.
- If PM context appears in the input, treat it only as background for naming likely files; the canonical task-fit report is produced by Validate & Review.
- Do not return pmAlignment or pmValidation fields.

${formatContextPack(context)}

Return strictly JSON matching this schema:
{
  "status": "passed" | "needs_work" | "blocked",
  "score": number (0-100),
  "riskLevel": "low" | "medium" | "high",
  "summary": "max 2 sentences",
  "reviewEffort": {
    "score": 1 | 2 | 3 | 4 | 5,
    "label": "Trivial" | "Light" | "Moderate" | "Complex" | "Very complex",
    "estimatedMinutes": number,
    "reason": "string (optional)"
  },
  "sequenceDiagrams": [
    {
      "title": "string",
      "mermaid": "string starting with sequenceDiagram or graph TD",
      "relatedFiles": ["string"]
    }
  ],
  "changedFilesSummary": [
    {
      "title": "string",
      "files": ["string"],
      "summary": "string"
    }
  ],
  "reviewDetails": {
    "reviewedFileCount": number,
    "filesSelected": ["string"],
    "filesSkipped": ["string"],
    "noReviewableChangeFiles": ["string"]
  },
  "mustFix": [
    {
      "title": "string",
      "file": "string (only from context)",
      "line": number (optional, only if confident),
      "category": "correctness" | "security" | "performance" | "test_coverage" | "maintainability",
      "severity": "critical" | "high" | "medium",
      "reason": "string",
      "suggestedFix": "string (optional)"
    }
  ],
  "suggestions": [
    {
      "title": "string",
      "file": "string (only from context)",
      "line": number (optional, only if confident),
      "reason": "string",
      "suggestedFix": "string (optional)"
    }
  ],
  "goodPoints": [
    {
      "title": "string",
      "evidence": "string (optional)"
    }
  ],
  "missingTests": [
    {
      "title": "string",
      "testType": "unit" | "integration" | "e2e" | "manual",
      "relatedFile": "string (only from context)",
      "reason": "string"
    }
  ],
  "inlineComments": [
    {
      "file": "string (only from context)",
      "line": number (optional, only if confident),
      "severity": "critical" | "high" | "medium" | "low",
      "category": "string",
      "title": "string",
      "comment": "string",
      "body": "string (optional)",
      "suggestion": "string (optional)",
      "diffSuggestion": "string (optional, unified diff or GitHub suggestion block)",
      "committableSuggestion": boolean
    }
  ],
  "fullReport": "string (optional, concise expanded report)"
}

Scoring model:
- Correctness: 35%
- Test coverage: 20%
- Security/risk: 20%
- Maintainability: 15%
- Performance: 10%

Score bands:
- 90-100: passed
- 70-89: needs_work
- 40-69: needs_work
- 0-39: blocked

Default limits (do not exceed):
- summary: max 2 sentences
- mustFix: max 5
- suggestions: max 5
- goodPoints: max 3
- missingTests: max 4
- inlineComments: max 8
- sequenceDiagrams: max 3
- changedFilesSummary: max 6

Important:
- Do not auto-apply fixes.
- If a line number is uncertain, omit it.
- If a file path is not in the context, omit it.
- Keep ordinary code quality feedback in mustFix/suggestions/inlineComments.
- Generate diagrams only when they clarify API calls, data flow, async workflows, auth/session flow, state machines, or database interaction. Prefer one compact Mermaid diagram over prose.
- Inline comments should read like CodeRabbit cards: a short title, concise body, severity/category, and a concrete diffSuggestion when the fix is obvious.
- Return only the JSON object, no markdown fences.`
}

function parseStatus(value: unknown): TyneCodeReviewResult['status'] {
  const s = typeof value === 'string' ? value.toLowerCase() : ''
  if (s === 'passed' || s === 'pass') return 'passed'
  if (s === 'blocked' || s === 'fail') return 'blocked'
  return 'needs_work'
}

function parseRiskLevel(value: unknown): TyneCodeReviewResult['riskLevel'] {
  const r = typeof value === 'string' ? value.toLowerCase() : ''
  if (r === 'low' || r === 'medium' || r === 'high') return r
  return 'medium'
}

function parseScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function parseSeverity(value: unknown): TyneMustFixItem['severity'] {
  const s = typeof value === 'string' ? value.toLowerCase() : ''
  if (s === 'critical' || s === 'high' || s === 'medium') return s
  return 'medium'
}

function parseCategory(value: unknown): TyneMustFixItem['category'] {
  const c = typeof value === 'string' ? value.toLowerCase() : ''
  const allowed: TyneMustFixItem['category'][] = ['correctness', 'security', 'performance', 'test_coverage', 'maintainability']
  return allowed.includes(c as TyneMustFixItem['category']) ? (c as TyneMustFixItem['category']) : 'maintainability'
}

function parseTestType(value: unknown): TyneMissingTestItem['testType'] {
  const t = typeof value === 'string' ? value.toLowerCase() : ''
  const allowed: TyneMissingTestItem['testType'][] = ['unit', 'integration', 'e2e', 'manual']
  return allowed.includes(t as TyneMissingTestItem['testType']) ? (t as TyneMissingTestItem['testType']) : 'unit'
}

function parsePmValidationStatus(value: unknown): TynePmValidation['status'] {
  const s = typeof value === 'string' ? value.toLowerCase() : ''
  if (s === 'addressed' || s === 'not_addressed' || s === 'unclear' || s === 'unknown') return s
  return 'unknown'
}

function parseEffortScore(value: unknown): TyneReviewEffort['score'] {
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return 1
  if (n <= 1) return 1
  if (n === 2) return 2
  if (n === 3) return 3
  if (n === 4) return 4
  return 5
}

function defaultEffortFromContext(raw: Record<string, unknown>): TyneReviewEffort {
  const changedFiles = Array.isArray(raw.changedFiles) ? raw.changedFiles.length : 0
  const score: TyneReviewEffort['score'] = changedFiles >= 12 ? 4 : changedFiles >= 6 ? 3 : changedFiles >= 2 ? 2 : 1
  const label = score === 1 ? 'Trivial' : score === 2 ? 'Light' : score === 3 ? 'Moderate' : score === 4 ? 'Complex' : 'Very complex'
  return {
    score,
    label,
    estimatedMinutes: score * 10,
    reason: undefined,
  }
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/\\/g, '/').trim()
  if (!clean || clean.includes('\0') || clean.startsWith('/') || clean.includes('..')) return undefined
  return clean
}

function allowedReviewFiles(context: TyneReviewContextPack): Set<string> {
  return new Set([
    ...context.git.changedFiles,
    ...context.relevantFiles.map(f => f.path),
    ...context.existingTests.map(f => f.path),
  ].map(f => f.replace(/\\/g, '/').trim()).filter(Boolean))
}

function groundedPath(value: unknown, allowedFiles: Set<string>): string | undefined {
  const clean = normalizePath(value)
  return clean && allowedFiles.has(clean) ? clean : undefined
}

function sanitizeReviewResult(raw: unknown, context: TyneReviewContextPack): TyneCodeReviewResult {
  const allowedFiles = allowedReviewFiles(context)
  if (!raw || typeof raw !== 'object') {
    return {
      status: 'needs_work',
      score: 0,
      riskLevel: 'medium',
      summary: 'Unable to parse review result.',
      reviewEffort: { score: 1, label: 'Trivial', estimatedMinutes: 10, reason: undefined },
      sequenceDiagrams: [],
      changedFilesSummary: [],
      reviewDetails: { reviewedFileCount: context.git.changedFiles.length, filesSelected: context.git.changedFiles.slice(0, 20), filesSkipped: [], noReviewableChangeFiles: [] },
      mustFix: [],
      suggestions: [],
      goodPoints: [],
      missingTests: [],
      inlineComments: [],
      fullReport: undefined,
    }
  }
  const r = raw as Record<string, unknown>

  const mustFix: TyneCodeReviewResult['mustFix'] = Array.isArray(r.mustFix)
    ? (r.mustFix.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const title = typeof x.title === 'string' ? x.title.trim() : ''
        if (!title) return null
        return {
          title,
          file: groundedPath(x.file, allowedFiles),
          line: typeof x.line === 'number' && Number.isInteger(x.line) && x.line > 0 ? x.line : undefined,
          category: parseCategory(x.category),
          severity: parseSeverity(x.severity),
          reason: typeof x.reason === 'string' ? x.reason : '',
          suggestedFix: typeof x.suggestedFix === 'string' ? x.suggestedFix : undefined,
        }
      }).filter(Boolean) as TyneCodeReviewResult['mustFix']).slice(0, 5)
    : []

  const suggestions: TyneCodeReviewResult['suggestions'] = Array.isArray(r.suggestions)
    ? (r.suggestions.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const title = typeof x.title === 'string' ? x.title.trim() : ''
        if (!title) return null
        return {
          title,
          file: groundedPath(x.file, allowedFiles),
          line: typeof x.line === 'number' && Number.isInteger(x.line) && x.line > 0 ? x.line : undefined,
          reason: typeof x.reason === 'string' ? x.reason : '',
          suggestedFix: typeof x.suggestedFix === 'string' ? x.suggestedFix : undefined,
        }
      }).filter(Boolean) as TyneCodeReviewResult['suggestions']).slice(0, 5)
    : []

  const goodPoints: TyneCodeReviewResult['goodPoints'] = Array.isArray(r.goodPoints)
    ? (r.goodPoints.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const title = typeof x.title === 'string' ? x.title.trim() : ''
        if (!title) return null
        return {
          title,
          evidence: typeof x.evidence === 'string' ? x.evidence : undefined,
        }
      }).filter(Boolean) as TyneCodeReviewResult['goodPoints']).slice(0, 3)
    : []

  const missingTests: TyneCodeReviewResult['missingTests'] = Array.isArray(r.missingTests)
    ? (r.missingTests.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const title = typeof x.title === 'string' ? x.title.trim() : ''
        if (!title) return null
        return {
          title,
          testType: parseTestType(x.testType),
          relatedFile: groundedPath(x.relatedFile, allowedFiles),
          reason: typeof x.reason === 'string' ? x.reason : '',
        }
      }).filter(Boolean) as TyneCodeReviewResult['missingTests']).slice(0, 4)
    : []

  const inlineComments: TyneCodeReviewResult['inlineComments'] = Array.isArray(r.inlineComments)
    ? (r.inlineComments.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const file = groundedPath(x.file, allowedFiles) || ''
        const comment = typeof x.comment === 'string' ? x.comment.trim() : ''
        if (!file || !comment) return null
        const rawSeverity = typeof x.severity === 'string' ? x.severity.toLowerCase() : 'medium'
        const severity: TyneInlineCommentItem['severity'] = ['critical', 'high', 'medium', 'low'].includes(rawSeverity) ? (rawSeverity as TyneInlineCommentItem['severity']) : 'medium'
        return {
          file,
          line: typeof x.line === 'number' && Number.isInteger(x.line) && x.line > 0 ? x.line : undefined,
          severity,
          category: typeof x.category === 'string' ? x.category : 'general',
          title: typeof x.title === 'string' ? x.title.trim() : undefined,
          comment,
          body: typeof x.body === 'string' ? x.body : undefined,
          suggestion: typeof x.suggestion === 'string' ? x.suggestion : undefined,
          diffSuggestion: typeof x.diffSuggestion === 'string' ? x.diffSuggestion : undefined,
          committableSuggestion: typeof x.committableSuggestion === 'boolean' ? x.committableSuggestion : undefined,
        }
      }).filter(Boolean) as TyneCodeReviewResult['inlineComments']).slice(0, 8)
    : []

  const effortRaw = typeof r.reviewEffort === 'object' && r.reviewEffort !== null
    ? r.reviewEffort as Record<string, unknown>
    : {}
  const effortScore = parseEffortScore(effortRaw.score)
  const fallbackEffort = defaultEffortFromContext(r)
  const reviewEffort: TyneReviewEffort = {
    score: effortScore || fallbackEffort.score,
    label: typeof effortRaw.label === 'string' ? effortRaw.label.slice(0, 40) : fallbackEffort.label,
    estimatedMinutes: Math.max(5, Math.min(120, Math.round(typeof effortRaw.estimatedMinutes === 'number' ? effortRaw.estimatedMinutes : fallbackEffort.estimatedMinutes))),
    reason: typeof effortRaw.reason === 'string' ? effortRaw.reason.slice(0, 400) : undefined,
  }

  const sequenceDiagrams: TyneSequenceDiagram[] = Array.isArray(r.sequenceDiagrams)
    ? (r.sequenceDiagrams.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const title = typeof x.title === 'string' ? x.title.trim() : ''
        const mermaid = typeof x.mermaid === 'string' ? x.mermaid.trim() : ''
        if (!title || !mermaid) return null
        const relatedFiles = toStringArray(x.relatedFiles).map(f => groundedPath(f, allowedFiles)).filter(Boolean) as string[]
        if (!relatedFiles.length) return null
        return { title, mermaid: mermaid.slice(0, 3000), relatedFiles: relatedFiles.slice(0, 8) }
      }).filter(Boolean) as TyneSequenceDiagram[]).slice(0, 3)
    : []

  const changedFilesSummary: TyneChangedFilesSummary[] = Array.isArray(r.changedFilesSummary)
    ? (r.changedFilesSummary.map(item => {
        if (!item || typeof item !== 'object') return null
        const x = item as Record<string, unknown>
        const title = typeof x.title === 'string' ? x.title.trim() : ''
        const summaryText = typeof x.summary === 'string' ? x.summary.trim() : ''
        if (!title || !summaryText) return null
        const files = toStringArray(x.files).map(f => groundedPath(f, allowedFiles)).filter(Boolean) as string[]
        if (!files.length) return null
        return { title, files: files.slice(0, 10), summary: summaryText.slice(0, 500) }
      }).filter(Boolean) as TyneChangedFilesSummary[]).slice(0, 6)
    : []

  const detailsRaw = typeof r.reviewDetails === 'object' && r.reviewDetails !== null
    ? r.reviewDetails as Record<string, unknown>
    : {}
  const modelSelected = toStringArray(detailsRaw.filesSelected).map(f => groundedPath(f, allowedFiles)).filter(Boolean) as string[]
  const filesSelected = (modelSelected.length ? modelSelected : context.git.changedFiles).slice(0, 20)
  const reviewDetails: TyneReviewDetails = {
    reviewedFileCount: filesSelected.length,
    filesSelected,
    filesSkipped: toStringArray(detailsRaw.filesSkipped).map(f => normalizePath(f)).filter(Boolean).slice(0, 20) as string[],
    noReviewableChangeFiles: toStringArray(detailsRaw.noReviewableChangeFiles).map(f => normalizePath(f)).filter(Boolean).slice(0, 20) as string[],
  }

  const summary = typeof r.summary === 'string' ? r.summary.trim() : 'No summary provided.'
  const shortSummary = summary.split(/\.\s+/).slice(0, 2).join('. ') + (summary.endsWith('.') ? '' : '.')

  return {
    status: parseStatus(r.status),
    score: parseScore(r.score),
    riskLevel: parseRiskLevel(r.riskLevel),
    summary: shortSummary,
    reviewEffort,
    sequenceDiagrams,
    changedFilesSummary,
    reviewDetails,
    mustFix,
    suggestions,
    goodPoints,
    missingTests,
    inlineComments,
    fullReport: typeof r.fullReport === 'string' ? r.fullReport.slice(0, 4000) : undefined,
  }
}

async function callLlm(config: ManagedLlmConfig, prompt: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    if (config.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Anthropic API failed (${res.status}): ${text.slice(0, 200)}`)
      }
      const data = await res.json() as { content: Array<{ type: string; text: string }> }
      return data.content?.find(c => c.type === 'text')?.text || ''
    }

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`OpenAI API failed (${res.status}): ${text.slice(0, 200)}`)
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content || ''
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Code review timed out after 60 seconds.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function callManagedFallbacks(
  configs: ManagedLlmConfig[],
  prompt: string,
): Promise<{ text: string; config: ManagedLlmConfig }> {
  let lastError: unknown = null
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i]
    try {
      return { text: await callLlm(config, prompt), config }
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const isLast = i === configs.length - 1
      if (isLast || !shouldTryNextAicreditsModel(err)) throw err
      console.warn(`Tyne code review: model "${config.model}" unavailable (${message.slice(0, 120)}); trying "${configs[i + 1].model}"`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All AICredits code review models failed')
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    const machineId = req.headers.get('X-Machine-ID')
    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401)
    }

    const githubToken = authHeader.replace(/^bearer\s+/i, '').trim()
    const payload = await req.json()
    const context = sanitizeContextPack(payload.context)
    if (!context) {
      return jsonResponse({ error: 'Invalid or missing review context' }, 400)
    }

    const ghUserRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/json',
        'User-Agent': 'Tyne-Backend',
      },
    })
    if (!ghUserRes.ok) {
      return jsonResponse({ error: 'Invalid GitHub token' }, 401)
    }

    const ghUser = await ghUserRes.json()
    const githubId = String(ghUser.id)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseServiceKey) {
      return jsonResponse({ error: 'Missing Supabase configuration' }, 500)
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    if (machineId) {
      const { data: blocked } = await supabase
        .from('hardware_blocklist')
        .select('machine_id')
        .eq('machine_id', machineId)
        .maybeSingle()
      if (blocked) {
        return jsonResponse({ error: 'Hardware ID is blocked' }, 403)
      }
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, tier, api_credits_remaining, github_username')
      .eq('github_id', githubId)
      .maybeSingle()

    const userTier = profile?.tier || 'CORE'
    const normalizedTier = normalizeTier(userTier)
    const creditsRemaining = profile?.api_credits_remaining ?? 100
    const profileId = profile?.id

    const byokKey = typeof payload.byokKey === 'string' ? payload.byokKey.replace(/\s+/g, '') : undefined
    const byokProvider = typeof payload.byokProvider === 'string' ? payload.byokProvider : undefined
    const isManaged = !byokKey

    if (isManaged) {
      if (profileId) {
        // Record usage atomically with advisory lock (fixes race condition).
        const { data: usageResult } = await supabase.rpc('record_usage_atomic', {
          uid: profileId,
          p_event: 'code_review',
          p_tokens: 0,
          p_cost: 0,
          p_metadata: { tier: normalizedTier } as unknown as never,
        })
        if (usageResult && usageResult.allowed === false) {
          return jsonResponse({ error: 'Review limit reached. Use BYOK or upgrade.' }, 402)
        }
      } else if (normalizedTier === 'max' && creditsRemaining <= 0) {
        return jsonResponse({ error: 'MAX API credits exhausted. Use BYOK or upgrade.' }, 402)
      }
    }

    const prompt = buildReviewPrompt(context)
    const byokConfig = byokKey ? resolveByokConfig(byokKey, byokProvider) : null
    const managedConfigs = byokConfig
      ? []
      : await resolveAicreditsLlmConfig('code_review', userTier, typeof payload.model === 'string' ? payload.model : undefined)
    if (!byokConfig && !managedConfigs.length) {
      return jsonResponse({ error: 'LLM configuration key is missing' }, 500)
    }
    const reviewAttempt = byokConfig
      ? { text: await callLlm(byokConfig, prompt), config: byokConfig }
      : await callManagedFallbacks(managedConfigs, prompt)
    const config = reviewAttempt.config
    const rawText = cleanJsonText(reviewAttempt.text)
    const parsed = safeJsonParse<unknown>(rawText)
    const result = sanitizeReviewResult(parsed, context)

    if (isManaged && profileId && normalizedTier === 'max') {
      await supabase.rpc('decrement_user_credits', { p_github_id: githubId })
    }

    return jsonResponse({ result, provider: config.provider, model: config.model }, 200)
  } catch (err: unknown) {
    console.error('Tyne code review error:', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

# Tyne PM Intelligence — LLM Provider Audit Report

**Date:** 2026-06-28
**Auditor:** Cascade (AI pair programmer)
**Scope:** Supabase Edge Functions that call managed LLMs
**Objective:** Confirm that every LLM call in the backend routes through the AICredits API only, with no remaining fallback to OpenAI or Anthropic keys.

## 1. Findings

Only three Edge Functions in the backend invoke managed LLMs:

| Function | File | LLM Use | AICredits Only | Notes |
|----------|------|---------|----------------|-------|
| `generate-commit` | `supabase/functions/generate-commit/index.ts` | Commit synthesis + deep validation review | ✅ Yes | Previously had OPENAI/ANTHROPIC fallbacks; removed. |
| `pm-task-intelligence` | `supabase/functions/pm-task-intelligence/index.ts` | Extract Goal/Subtasks/AC/Proof Points/Validation Plan | ✅ Yes | Previously had OPENAI/ANTHROPIC fallbacks; removed. |
| `pm-task-validation` | `supabase/functions/pm-task-validation/index.ts` | Validate code diff against acceptance criteria | ✅ Yes | Previously had OPENAI/ANTHROPIC fallbacks; removed. |

All other Edge Functions were inspected and do **not** make LLM calls:

- `atlassian-personal-data-report`
- `atlassian-report-oauth-callback`
- `atlassian-report-oauth-start`
- `complete-jira-oauth-exchange`
- `dodo-webhook`
- `get-jira-tokens`
- `jira-api-request`
- `jira-oauth-callback`
- `jira-oauth-state`
- `list-jira-projects`
- `ping`
- `save-jira-project-mapping`
- `usage`
- `validate-code` (empty)

## 2. Configuration Audit

### 2.1 Required environment variables

Every LLM-invoking function now reads only these keys for model calls:

```env
AICREDITS_API_KEY=...
AICREDITS_BASE_URL=https://api.aicredits.in/v1   # optional, defaults to this value
```

The following keys are no longer used in any Edge Function and are safe to remove from the Supabase Function Secrets if desired:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

### 2.2 Model routing used by AICredits

All models are passed as provider-prefixed identifiers to the AICredits OpenAI-compatible endpoint.

| Function | Tier / Mode | Model used |
|----------|-------------|------------|
| `generate-commit` | Default (commit synthesis) | `deepseek/deepseek-v4-pro` |
| `generate-commit` | Deep review — Free | `google/gemini-2.5-flash` |
| `generate-commit` | Deep review — Pro/Max | `anthropic/claude-3.5-haiku` |
| `pm-task-intelligence` | Extraction (all tiers) | `deepseek/deepseek-v4-pro` |
| `pm-task-intelligence` | Normalization fallback | `google/gemini-2.5-flash` |
| `pm-task-validation` | Free | `deepseek/deepseek-v4-pro` |
| `pm-task-validation` | Pro/Max | `anthropic/claude-3.5-haiku` |

> Note: the Pro/Max deep-review/validation models were first set to `anthropic/claude-3-5-sonnet-20241022`, but AICredits returned `"No endpoints found"` for that identifier. They were corrected to `anthropic/claude-3.5-haiku`, which is supported by AICredits. DeepSeek calls were also updated from `deepseek/deepseek-chat` to `deepseek/deepseek-v4-pro`.

### 2.3 AICredits compatibility

The AICredits API is OpenAI-compatible, so every function now uses a single `provider: 'openai'` configuration and posts to `${AICREDITS_BASE_URL}/chat/completions`. The `anthropic` branch in `callLlm` is unreachable when only AICredits is configured, but remains harmless defensive code.

## 3. Security Checklist

| Requirement | Status |
|-------------|--------|
| No LLM calls from the VS Code extension | ✅ All AI calls happen in Edge Functions |
| No raw LLM keys shipped to the client | ✅ Keys are only in Supabase Function Secrets |
| No OpenAI/Anthropic direct calls | ✅ Removed from all three LLM functions |
| No provider secrets exposed in responses | ✅ Functions return only the `modelProvider` label (e.g. `openai`) and never the key |
| Diff sanitized before validation | ✅ `pm-task-validation` drops sensitive paths and ignored files |
| Jira OAuth token kept server-side | ✅ Refresh and API calls happen inside Edge Functions |

## 4. Changes Made During This Audit

1. `supabase/functions/generate-commit/index.ts`
   - Removed `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` branches in `resolveManagedLlmConfig`.
   - Corrected Pro/Max deep-review model to `anthropic/claude-3-5-sonnet-20241022`.

2. `supabase/functions/pm-task-intelligence/index.ts`
   - Removed `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` branches in `resolveManagedLlmConfig`.

3. `supabase/functions/pm-task-validation/index.ts`
   - Removed `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` branches in `resolveManagedLlmConfig`.

4. `supabase/config.toml`
   - Registered `[functions.pm-task-intelligence]` and `[functions.pm-task-validation]` with `verify_jwt = false` (the functions authenticate the GitHub token internally).

## 5. Deployment Status

| Step | Status | Detail |
|------|--------|--------|
| Migration applied | ✅ Complete | `public.tyne_pm_task_contexts` created via `20260628100000_create_tyne_pm_task_contexts.sql` |
| `generate-commit` deployed | ✅ Complete | Version updated, status `ACTIVE`, `verify_jwt = false` |
| `pm-task-intelligence` deployed | ✅ Complete | Version updated, status `ACTIVE`, `verify_jwt = false` |
| `pm-task-validation` deployed | ✅ Complete | Version updated, status `ACTIVE`, `verify_jwt = false` |
| AICredits model compatibility | ✅ Fixed | Pro/Max now use `anthropic/claude-3.5-haiku`; DeepSeek uses `deepseek/deepseek-v4-pro` |

## 6. Deployment Verification Steps

After deployment, verify AICredits-only mode by checking the function logs in the Supabase Dashboard:

1. Open https://supabase.com/dashboard/project/mvzcfqjtleasuawvvmtg/functions
2. Select each function and view the **Logs** tab.
3. Confirm no logs reference `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

You can also set a temporary `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` to a dummy value in the function secrets; if configured correctly, the functions should still work because they now ignore those keys entirely.

## 7. Remaining Manual Step

The `.env` / `.envT` files in the local repo still contain `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` variables. These are **not** used by any deployed Edge Function after this audit, but they are still in the local environment files. Clean them up in the next credentials hygiene pass if you want to eliminate them from the workspace entirely.

## 8. Summary

All managed LLM calls in the Tyne backend now route exclusively through the AICredits API using AICredits-supported model identifiers. The migration has been applied, and the three LLM-invoking Edge Functions have been deployed to Supabase.

# Eval & agent harnesses

TYNE keeps **one** production path for detection and review composition (host `src/` + edge `tyne-validate-review`). Offline harnesses only call those pure functions — they do not reimplement engines.

| Script | Kind | What it measures | CI |
|--------|------|------------------|----|
| `npm run test:eval` | `detector_eval` | Golden diffs → secrets / injection / static heuristics + deterministic `scopeDriftHarness` | **Hard** (`EVAL_ENFORCE=1`) |
| `npm run test:replay` | replay | Grounding + `postProcessReviewFindings` + `verdictFromFindings` fixtures | **Hard** |
| `npm run test:agent-harness` | `agent_composition` | Bags of multi-engine findings → merge / NEVER_BLOCK / grounding / mode flags | **Hard** (`AGENT_HARNESS_ENFORCE=1`) |
| `npm run test:llm-smoke` | `llm_contract` | Recorded LLM-shaped JSON → post-process contracts (no invented paths) | Soft (`LLM_SMOKE_ENFORCE=1` to hard-fail; `EVAL_LLM=1` live reserved) |

**Not in these harnesses (deferred product work):** live LLM debate, trust score, Product Hunt / tiers rewrite, hierarchical orchestrator.

Reports: `eval/last-report.json`, `eval/agentHarness/last-report.json`, `eval/llmSmoke/last-report.json`.

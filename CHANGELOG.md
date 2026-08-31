# Changelog

All notable changes to Tyne are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-31

### Added
- **Team Learnings** — `.tyne/learnings.md`, a suppression list that lives in the repo, so a suppression is reviewed in a pull request before it takes effect, `git blame`s to whoever added it, and is inherited by every clone. Matching runs in four tiers, strongest first: exact title, exact title inside a path glob, exact `ruleId`, then a conservative concept match so a learning survives the model rephrasing a finding.
- **Every suppression is visible.** A "Checked but not shown" panel lists each hidden finding with the learning that hid it, how it matched, and — via git blame — who added it and when. Each row can be unsuppressed, which removes that one line from the file.
- **"Suppress for team…"** on any finding, with a scope picker (this file / this directory / everywhere) and an optional reason. Previously a suppression could only ever be repo-wide.
- **House rules** — a `## Require` section holds conventions the team wants enforced, which *generate* findings instead of hiding them. Rule-generated findings carry a `team rule` chip and link back to the exact file line, because unlike every other detector these are model judgment rather than deterministic evidence.
- **Stale learning detection** — learnings evaluated repeatedly that have never once acted are surfaced for review. Suppressions are reported first and at a lower bar than rules: a stale suppression silently hides real bugs, while a stale rule merely never fires.
- **Prior-decision context** — commits that touched the same lines as the diff are surfaced to answer "why was this written this way", scoped to the exact changed ranges rather than "this file changed recently".
- **Container and IaC scanning** via Trivy for Dockerfiles, Terraform, Kubernetes and CloudFormation. Deliberately config-only: npm CVEs are already covered, and re-scanning the same lockfile with a second tool adds noise rather than coverage.
- **Feature documentation** under `docs/features/`, grouping each capability as flagship, premium or normal with its trigger points and degradation behaviour.

### Changed
- **Nearby-file selection now uses the import graph.** Ranking was keyword-only, so a file one import away from the change lost to any file that merely shared a word with the ticket title, even though the graph was already computed for every review. A direct import edge now outranks a loose keyword match, and the reported reason names the relationship.
- Team learnings are sent to the model so it stops *generating* already-accepted findings, instead of generating them and having the client drop them afterwards.
- House-rule usage is recorded in Supabase (`house_rule_events`) to support staleness. The rules themselves stay in the repo file — moving them to a database would cost the review, blame and portability properties the feature exists for.

### Fixed
- Interface contracts no longer read as duplication: same-named implementations of a declared interface method are recognised as polymorphism rather than clones.
- Public settings no longer advertise Asana and Notion as working integrations; their adapters return no tasks, and the descriptions now say so.

### Security
- **The billing webhook granted a paid tier on any status it did not explicitly recognise as a failure.** A `subscription.updated` event carrying `pending` — or any status Dodo adds in future — was treated as a successful payment and upgraded the account. Replaced the denylist with a fail-closed allowlist: a tier is granted only when payment is confirmed, an unconfirmed event holds the current tier rather than granting or demoting, and every failure state still downgrades.

## [0.3.3] - 2026-08-19

Compiled VS Code extension build of 0.3.2 (codegraph review context, PM enrichment, semantic clones).

## [0.3.2] - 2026-08-19

### Added
- **Codegraph review context** — Validate & Review queries a local 1-hop import graph (callers, callees, similar functions) instead of nearby-by-keyword files. Impact findings on those callers are kept; invented paths are still dropped. Optional LSP Find All References (800ms budget) enriches hop-1.
- **PM enrichment product context** — Jira Epic children are loaded via `parent = KEY` (with legacy Epic Link fallback), child issue descriptions reach the model, and screenshot/PDF attachments are sent to vision-capable models (Claude/Gemini). Linear parent descriptions are included the same way.
- **Semantic clone detection** in the local quality engine (function-level), with file-level clone findings pruned when a more specific semantic hit exists.
- **Ship-comment review pack** — HTML evidence can be attached as a file on PM tools that support `attachFile`, instead of dumping markup into the comment body.

### Changed
- Staff Engineer and managed Validate & Review prompts consume a capped `<codegraph_neighborhood>` slice (8k). The `tyne-validate-review` edge function is deployed with matching grounding.
- Enrichment prompt is budgeted (per-section caps plus a 320k backstop) so large tickets no longer blow the model context window. Oversized first attachments/comments are truncated rather than dropping the whole section.
- When a ticket has mockups/PDFs, extraction prefers a vision model; DeepSeek stays as a text-only fallback. PDFs are sent only to Anthropic.

### Fixed
- Epic enrichment no longer invents subtasks that already exist as child stories (`fields.subtasks` is empty on Epics).

## [0.3.1] - 2026-08-13

Packaged Marketplace build on top of 0.3.0 (existing `tyne-0.3.1.vsix`).

## [0.3.0] - 2026-08-12

### Added
- **Guided first-run** — after GitHub sign-in, a one-time tour (Solo or PM → Thread → first Validate & Review) for every tier; auth is required (Skip for now removed).
- **Jira / Linear create & edit** from Tyne (Pro/Max write gate); hosted API allowlists extended for issue create/update.
- **Marketplace listing metadata** — categories, keywords, homepage, bugs URL, gallery banner color, `media/marketplace-banner.png`.
- **Sellable beta (0.3.0)** — founder-led design partners (10–20) before broad Marketplace PLG; billing E2E and brand-domain unification remain deferred.
- **Terms & Privacy** links on welcome and Settings → About.
- **Core → Pro volume CTA** after a successful review when Core quota is low.
- **Packaging guard** — `scripts/guard-vsix-no-deps.mjs` blocks `--no-dependencies` regressions.
- **LLM smoke hard gate** in CI (`LLM_SMOKE_ENFORCE=1`).

### Changed
- Settings Integrations shows **live tools only** (GitHub, Jira, Linear).
- README plans table aligned with code (Core quality parity, 5/month, optional PM task).
- Tree-sitter documented as optional grammars (TS/JS via TypeScript compiler by default).

### Fixed
- Demo/Coming-soon PM adapters no longer pretend to connect or invent tasks in product paths.

## [0.2.10] - 2026-08-03

### Added
- **Compile → DB changelog** — `npm run compile` / `npm run vsix` record a row in Supabase `public.changelog` (title, version, description, publish flag) via `scripts/record-changelog.mjs`. Soft-skips if `SUPABASE_SERVICE_ROLE_KEY` is missing or is not a real service-role JWT.

### Changed
- **UI quieting (anti–AI-slop)** — Reviews first viewport is verdict → Action Needed (gauges/chips/insights collapsed); sharp 1px radius; status text+dot (no glow pills); Analytics flat (no radial candy / purple); orphan Technical Review page removed; Thread scorecard CTAs collapsed to primary + More.

## [0.2.9] - 2026-07-28

### Added
- **Validate & Review PDF export** — Modern print-ready HTML report with Tyne branding, generator + code authorship, quality scorecard, findings, changed files, and technical appendix. Open → Print → Save as PDF.

## [0.2.8] - 2026-07-28

### Fixed
- **Validation report Contributors** — No longer scans the code diff for words like “Cursor” / “Claude” (which falsely listed Tyne’s own tooling as authors). Attribution uses git author + commit co-author trailers only.

## [0.2.7] - 2026-07-28

### Fixed
- **Jira tasks not appearing / yellow refresh dot** — Hosted Jira task pull, project list, and project mapping now authenticate with the active Tyne session (device-auth JWT or GitHub token), not GitHub-token-only. Connect prompts for a project when none is mapped. Sync tooltip and empty list show the real pull error (including “assign to yourself”).

## [0.2.6] - 2026-07-27

### Fixed
- **Jira / Linear Connect opens no browser** — Connect clicks no longer get stolen by BYOK provider toggles; stuck in-progress OAuth is cancelled so a new click reopens the browser; auth for PM OAuth accepts Tyne session JWT or GitHub token; Settings no longer shows a sticky false Connected / false GitHub-ready state from webview persist.

## [0.2.5] - 2026-07-27

### Fixed
- **PM Connect / Disconnect stuck on Connected** — Settings no longer sticky-ORs old connected state after Disconnect. Jira disconnect also sets a local opt-out so hosted session recovery cannot silently reconnect until the user Connects again. Stale `connectedTools` entries are pruned when a tool is not actually connected.

## [0.2.4] - 2026-07-27

### Fixed
- **Marketplace infinite loading / failed activation** — `0.2.2` and `0.2.3` VSIX builds were packaged with `--no-dependencies`, which stripped required runtime packages (`typescript`, `web-tree-sitter`) that esbuild leaves external. Activation then hung with `MODULE_NOT_FOUND`. Packaging again includes those deps (same as `0.2.1`).

## [0.2.3] - 2026-07-27

### Fixed
- **Core validation quota** — Validate & Review now hard-stops after 5 runs/month with a clear upgrade prompt (BYOK no longer silently bypasses the Core cap).
- **Task-bound validation** — Direct BYOK and managed review score the diff against the linked Jira/Linear Golden Contract (goal, AC, constraints), not a free-floating repo code-quality pass.
- **Quota edge cases** — Core Direct BYOK is metered server-side; 402 / limit errors no longer fall back to an unmetered local review; usage checks fail closed when the API is unavailable.
- **Validate & Review gating** — Requires a linked Jira or Linear task with goal/AC before running.

### Changed
- **Core Validate & Review ≈ Pro quality (5/month)** — Same PM alignment, missing-test review, full report, and chunked/PEV/scope-drift pipeline as Pro.
- **Core managed LLM** — Routes to Google Gemini (not Claude) for the 5 managed validations; Core skips Direct BYOK so those runs stay on Tyne Gemini.
- Upgrade CTA on Core now emphasizes volume (Pro 50 / Max unlimited) instead of “missing” PM or full reports.

### Security
- Usage metering continues to fail closed on RPC errors; Core quota cannot be skipped via client-only paths.

## [0.2.2] - 2026-07-27

### Fixed
- Initial packaging of Core quota + PM-binding hardening for Validate & Review (superseded and completed in 0.2.3).

### Known issue
- VSIX built with `--no-dependencies` omitted runtime deps — fixed in **0.2.4**. Prefer upgrading to 0.2.4.

## [0.2.1] - 2026-07-26

### Fixed
- Marketplace activation hang — ship runtime deps (`typescript`, `web-tree-sitter`) that esbuild left external so the extension activates from the VSIX.
- Branding assets and packaging for Marketplace install.

### Added
- In-extension upgrade CTAs for free-tier validation and Settings (Upgrade / Manage billing).

## [0.2.0] - 2026-07

### Added
- Validate & Review privacy modes with Direct BYOK.
- Quality scanners, PEV scope drift, and parallel file review.
- Beta validation reminders and launch polish.
- PM task intelligence, Jira/Linear OAuth flows, hosted Linear sync.

### Changed
- Refined thread review UX and architecture flowchart readability.

## [0.1.0] - 2026-06

### Added
- Initial Tyne VS Code extension: goal enforcement, thread workflow, validation, and Supabase-backed services.

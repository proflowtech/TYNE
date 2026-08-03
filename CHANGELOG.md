# Changelog

All notable changes to Tyne are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

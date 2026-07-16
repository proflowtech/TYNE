# Tyne

**Goal-enforcement layer for AI-assisted coding sessions.**

> Beta — Tyne is in active beta testing. Core workflows (threads, Validate & Review, Jira/Linear) are functional; some integrations are marked *Coming soon* in-app.

Tyne keeps you on track during "vibe coding" by anchoring each session to a stated goal, isolating the work on its own git branch, and validating that your commits actually serve that goal before you merge. It reviews your code for correctness, security, compliance, and quality — without shipping your whole repository to a server.

---

## Requirements

- VS Code (or a compatible editor) `^1.85.0`
- A git repository open in the workspace
- A GitHub account (connected via device flow)
- For AI validation: a Tyne plan (hosted models) **or** your own Claude/OpenAI API key (BYOK)

## Install & activate

1. Install the extension.
2. Open a git repository.
3. Click the **Tyne** icon in the activity bar.
4. Connect **GitHub** from Settings (device flow — no password stored).

## Core workflow

1. Open the **Thread** panel and set your App, Task ID, and Goal.
2. **Start Thread** — Tyne creates an isolated `tyne/<taskId>-<goal>` branch.
3. Code. Commit checkpoints as you go.
4. **Validate & Review** (`Cmd/Ctrl+Shift+T`) — Tyne checks your changes against the goal.
5. **Tie the Knot** — merge the thread once validation passes.

## Features

Tyne's sidebar is organized into panels:

- **Thread** — goal-anchored session with branch isolation and drift detection.
- **Validate & Review** — one combined report covering:
  - PM/goal alignment (does the code match the stated task?)
  - Code review (correctness, bugs, maintainability)
  - Security scan (deterministic + AI, with evidence redaction)
  - Compliance checks (Max tier, opt-in; e.g. HIPAA controls)
  - Code quality (complexity, clones, "vibe code" smells, architecture)
- **Tasks** — pull and act on tickets from connected PM tools.
- **Branches** — see and switch between thread branches.
- **Commits** — commit history, AI commit synthesis, and linking.
- **Time** — lightweight time tracking and summaries per thread.
- **Automation** — Project Lead Mode: workspace prep, drift detection, and auto ticket close.
- **Settings** — account, integrations, AI/API keys, and privacy.

### Automatic validation reminders

Tyne nudges you to run **Validate & Review** at sensible moments — after a large edit, when new syntax errors appear, or during a long active coding session. Reminders are advisory, rate-limited, and fully configurable (see settings below).

## Integrations

| Tool    | Status        |
| ------- | ------------- |
| GitHub  | Live          |
| Jira    | Live (OAuth)  |
| Linear  | Live (OAuth)  |
| Slack   | Coming soon   |
| Asana   | Coming soon   |
| Monday  | Coming soon   |

Free plans support one PM tool at a time; Pro/Max unlock all live integrations.

## Privacy

Tyne is built to keep source code local by default. Choose a privacy mode in settings:

- **Cloud** — hosted models via Tyne's managed backend.
- **Privacy-enhanced** — client-side redaction and payload sanitization before anything leaves your machine.
- **Local compliance** — deterministic local engines for security/compliance, minimizing outbound data.

**BYOK (Bring Your Own Key):** when you use your own Claude/OpenAI key, requests go directly to the provider — your key is never sent to Tyne's backend. Data residency (US/EU) is configurable.

## Key settings

Configure under **Tyne** in VS Code settings:

- `tyne.byokProvider` — `claude` or `openai` for BYOK validation.
- `tyne.validateReviewLineThreshold` — net new lines before a reminder (default `50`).
- `tyne.validationReminders.enabled` — toggle automatic reminders (default `true`).
- `tyne.validationReminders.cooldownMinutes` — min minutes between reminders (default `20`).
- `tyne.validationReminders.sessionMinutes` — active-coding minutes before a checkpoint nudge (default `45`).
- `tyne.projectLeadMode` — auto workspace prep, drift detection, AI commit synthesis, auto ticket close.
- `tyne.defaultBranch` — base branch to pull from before starting a thread (default `main`).
- `tyne.driftSensitivity` — how aggressively off-scope edits are flagged (`low`/`medium`/`high`).
- `tyne.supabaseUrl` / `tyne.supabaseUrlEu` — managed backend endpoints (US / EU).
- `tyne.enterpriseValidateReviewUrl` — self-hosted Validate & Review endpoint.

## Plans

- **Core** — BYOK; core thread + Validate & Review workflow.
- **Pro** — hosted models, PM alignment, all live PM integrations.
- **Max** — largest context, custom guardrails, compliance checks.

## Development

```bash
npm install
npm run compile     # type-check
npm run package     # production bundle (esbuild)
npm test            # compile + run node:test suite
```

## License

MIT

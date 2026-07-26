<p align="center">
  <img src="media/tyne-icon.png" alt="Tyne logo" width="360" />
</p>

<h1 align="center">Tyne</h1>

<p align="center"><strong>Goal-enforcement for AI-assisted coding.</strong></p>

Tyne keeps vibe-coding sessions on scope. Anchor work to a real task, isolate it on its own branch, then run **Validate & Review** before you merge — so what ships matches the ticket, not just the prompt.

> **Beta** — Core workflows (Threads, Validate & Review, Jira/Linear) are ready for daily use. Some integrations show *Coming soon* in-app.

---

## Why Tyne

AI assistants move fast. Scope drifts faster.

Tyne sits beside your editor and answers the questions that matter before you open a PR:

- Does this diff fulfill the **PM task / goal**?
- Is the **code** correct and maintainable?
- Are there **security** issues in what you just wrote?
- Do **compliance** policy checks flag anything (Max, opt-in)?
- Can I **fix it in the IDE** without leaving the flow?

---

## Install

1. Install **Tyne** from the Visual Studio Marketplace.
2. Open a git workspace.
3. Click the **Tyne** icon in the activity bar.
4. Sign in with **Continue with GitHub** (device flow — no password stored in Tyne).

**Requirements:** VS Code `^1.85.0` · git repository · GitHub account · Tyne plan **or** your own Claude/OpenAI key (BYOK)

---

## Core workflow

1. **Pick a task** — from Jira/Linear, or set a Solo goal on the Thread tab.
2. **Start Thread** — Tyne creates an isolated `tyne/<task>-…` branch.
3. **Code** — commit checkpoints (“stitches”) as you go.
4. **Validate & Review** — `Cmd/Ctrl+Shift+T` (or **Run Review** in the sidebar).
5. **Fix findings** — apply a patch, open **Fix in IDE**, or use the editor Quick Fix.
6. **Tie the Knot** — merge once validation passes (Override available when you need it).

---

## Validate & Review

One combined report — not four separate tools. Tyne reviews your *changes*, not your whole repo by default.

| Layer | What you get |
| ----- | ------------ |
| **PM / scope alignment** | Checks the diff against the linked Jira/Linear task or Thread goal. Pro/Max. |
| **Code review** | Correctness, bugs, maintainability, architecture, and “vibe-code” smells. |
| **Security review** | Deterministic + AI security findings with file/line evidence and remediations. |
| **Compliance checks** | Opt-in policy checks on the reviewed diff (Max). Advisory — not a certification or audit. |
| **Quality scorecard** | Complexity, clones, local quality signals, and next actions. |

**Scopes:** Auto · staged · unstaged · last commit · selected commit.

Reports include a score, risk level, completed/pending goals, security findings, missing tests (Pro/Max), and a full report on higher tiers.

### Fix findings without leaving the editor

When Validate & Review surfaces an issue, you can:

- **Fix** — apply a verified patch in one click (when Tyne can produce one).
- **Fix in IDE** — hand the finding to your AI agent with a ready-made prompt in the editor.
- **Quick Fix** — use VS Code’s lightbulb / Quick Fix menu (`Tyne: apply suggested fix…`) on applyable diagnostics.
- **Ignore** / **Undo** — dismiss noise or reverse an applied patch.

---

## Tasks & PM integrations

Pull assigned work into Tyne, start a Thread from a ticket, validate against that ticket, and optionally post feedback or mark the task done.

| Integration | Status |
| ----------- | ------ |
| GitHub | Live — auth, branches, draft PRs |
| Jira | Live — OAuth |
| Linear | Live — OAuth |
| Slack | Coming soon |
| Asana | Coming soon |
| Monday | Coming soon |

**Free:** one PM tool. **Pro / Max:** all live tools.

### Create tasks from a story or epic

On Pro/Max, decompose a large story into implementable subtasks (**Create Tasks from Story**) and optionally push them back to Jira or Linear.

---

## Threads, commits & automation

- **Threads** — goal-anchored sessions with branch isolation and drift detection.
- **Branches** — switch and inspect Tyne thread branches.
- **Commits** — history, velocity, and AI commit message synthesis.
- **Time** — lightweight time tracking per thread.
- **Automation / Project Lead Mode** — workspace prep, drift sensitivity, validation reminders, preview/post PM feedback, and mark task done.

Validation reminders are advisory and rate-limited (large edits, new diagnostics, long sessions). Configurable in settings.

---

## Privacy & AI access

Tyne is designed to keep source local by default. Choose a mode in Settings:

| Mode | Behavior |
| ---- | -------- |
| **Cloud** | Hosted models via Tyne’s managed backend. |
| **Privacy Enhanced** | Client-side redaction/sanitization before anything leaves your machine. |
| **Local Compliance** | Prefer local engines; minimize outbound data. |

**BYOK (Bring Your Own Key):** use your Claude or OpenAI key. Requests go to the provider — the key is not sent to Tyne’s backend. US/EU data residency is configurable for managed paths.

---

## Plans

| Plan | Highlights |
| ---- | ---------- |
| **Free** | Threads + Validate & Review with your own API key (BYOK); one PM tool; compact reports. |
| **Pro** | Hosted models, PM-aligned validation, missing-test review, all live PM tools, story decomposition. |
| **Max** | Largest context, full reports, custom guardrails, opt-in compliance policy checks. |

Upgrade from **Settings → Plan**, or from the free-tier prompt on gated validation results.

---

## Commands worth knowing

| Command | Action |
| ------- | ------ |
| `Tyne: Validate & Review` | Run the combined review (`Cmd/Ctrl+Shift+T`) |
| `Tyne: Validate & Review Last Edit` | Review the last edit scope |
| `Tyne: Open Validate & Review Reports` | Browse past reports |
| `Tyne: Set Claude/OpenAI API Key` | Configure BYOK |
| `Tyne: Connect GitHub` / `Reconnect GitHub` | Account connection |

---

## Key settings

Under **Tyne** in VS Code Settings:

- `tyne.byokProvider` — `claude` or `openai`
- `tyne.validationReminders.enabled` — automatic Validate & Review nudges
- `tyne.validateReviewLineThreshold` — lines changed before a reminder (default `50`)
- `tyne.projectLeadMode` — prep, drift detection, synth commits, auto ticket close
- `tyne.defaultBranch` — base branch for new threads (default `main`)
- `tyne.driftSensitivity` — `low` / `medium` / `high`
- `tyne.supabaseUrl` / `tyne.supabaseUrlEu` — managed backends (US / EU)

---

## Important notes

- **Compliance checks are advisory.** They are policy scans on the reviewed diff — not a compliance certification, audit, legal opinion, or guarantee of security.
- Tyne reviews **your changes** in context. It is not a full-repository static analysis suite.
- Beta software: expect rapid iteration; please report issues from the in-app beta bug reporter.

---

## Development

```bash
npm install
npm run compile     # type-check
npm run package     # production bundle → dist/extension.js
npm test            # compile + node:test suite
npx @vscode/vsce package --allow-missing-repository   # build .vsix
```

---

## License

MIT © [tyne.io](https://tyne.io)

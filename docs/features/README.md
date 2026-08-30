# Tyne Feature Reference

Every feature Tyne ships, grouped by tier, with what it does, exactly what
triggers it, and the code that implements it.

Tiers describe **product positioning**, not code quality:

| Tier | Meaning |
|---|---|
| **Flagship** | The reason to choose Tyne over a PR bot. Structurally hard for a cloud-only competitor to copy. |
| **Premium** | Paid-tier value. Real depth, but a competitor could build it. |
| **Normal** | Table stakes. Expected of any review tool; absence would be a gap. |

## Index

### Flagship
- [Team Learnings](./flagship-team-learnings.md) — PR-reviewable, git-blamed suppressions with always-visible provenance
- [Semantic Duplication Detection](./flagship-semantic-duplication.md) — finds code an AI agent reimplemented instead of reusing
- [Proof-Point Loop](./flagship-proof-point-loop.md) — commits to what "done" means *before* the code exists

### Premium
- [Repo-Aware Review Context](./premium-repo-aware-context.md) — import graph, blast radius, prior-commit history
- [IaC & Static Security Scanning](./premium-security-scanning.md) — Trivy + Semgrep + homegrown detectors
- [Acceptance-Criteria Validation](./premium-ac-validation.md) — three-way verdict per criterion

### Normal
- [Finding Grounding & Merge Pipeline](./normal-finding-pipeline.md) — hallucination filtering, dedup, throttling
- [Confidence-Gated Fix](./normal-confidence-gated-fix.md) — "Fix" only ever means an applyable patch

## Conventions used across these docs

- **Trigger** — the exact user action or pipeline stage that runs the code.
- **Entry point** — the first function that executes, with its file.
- **Degradation** — what happens on failure. Every feature here degrades to
  "nothing shown" rather than blocking a review.

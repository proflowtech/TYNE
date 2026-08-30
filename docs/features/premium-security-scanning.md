# IaC & Static Security Scanning

**Tier:** Premium
**Status:** Shipped
**Code:** `src/quality/trivyAdapter.ts`, `src/quality/semgrepAdapter.ts`, `src/quality/secretsDetector.ts`, `src/quality/injectionDetector.ts`, `src/quality/dependencyVulnerabilityChecker.ts`, `src/quality/staticSecurityHeuristics.ts`

---

## What it does

Layered security analysis on the changed files. Five detectors, each owning a
distinct surface — deliberately **no overlap**:

| Detector | Surface | Mechanism |
|---|---|---|
| `trivyAdapter` | Dockerfile, Terraform, k8s, CloudFormation | `trivy config` subprocess |
| `semgrepAdapter` | Source-code patterns | `semgrep` subprocess, repo's own rules |
| `secretsDetector` | Hardcoded credentials | Local pattern + entropy |
| `injectionDetector` | SQL / command injection | Local AST + dataflow |
| `dependencyVulnerabilityChecker` | Package CVEs | `npm audit` |

## Why premium, not flagship

Enterprise security review checks **named tools** off a compliance list, so
coverage matters commercially. But it is table stakes for that buyer rather
than a reason to choose Tyne — anyone can integrate a scanner.

## Design decision: depth over breadth

CodeRabbit advertises 40+ integrated tools. Tyne deliberately did **not**
chase that number. The reasoning:

- The goal is the procurement checklist, not the count
- Every integration is a maintenance surface, a failure mode, and a thing to
  explain in a demo
- Overlapping scanners produce duplicate findings wearing different vendor
  names

So `trivyAdapter` is scoped to **config/IaC only** — explicitly *not*
dependency CVEs, because `dependencyVulnerabilityChecker` already owns npm
packages. Re-scanning the same lockfile with a second tool adds noise, not
coverage. Likewise no TruffleHog-equivalent: `secretsDetector` covers it.

## Trivy adapter specifics

**File detection** is narrow on purpose. `iacTargets()` matches Dockerfiles,
`docker-compose`, `.tf`/`.tfvars`, manifests under `k8s/` or `kubernetes/`,
and `.cfn.json`/`.cfn.yaml`. It deliberately does **not** match any `.yaml` —
a CI workflow file is not an IaC misconfiguration surface, and matching it
would pay the subprocess cost on every review for no findings.

**Injectable subprocess.** Unlike `semgrepAdapter` (which shells out directly
and therefore has no test coverage), `collectTrivyFindings` accepts an
`execFileFn`, so detection, invocation and parsing are all unit-testable
without the binary installed.

**Severity mapping** — `CRITICAL`→`critical`, `HIGH`→`high`, `MEDIUM`→`medium`,
`LOW`→`low`, unknown→`medium`. Only `critical` is `blocking`. Capped at 20
findings so one noisy file cannot dominate.

## Trigger points

| # | Trigger | Condition |
|---|---|---|
| 1 | **Quality engine runs** | `input.workspaceRoot` is set |
| 2 | **Semgrep** | `.semgrep.yml` (or variant) exists **and** binary present |
| 3 | **Trivy** | At least one changed file matches `iacTargets()` **and** binary present |
| 4 | **Secrets / injection** | Always — local, no external dependency |
| 5 | **Dependencies** | `package.json` and lockfile present |

Both subprocess adapters are opt-in by presence: no config file or no binary
means the scanner silently does nothing.

## Degradation

Missing binary, non-zero exit, timeout, or malformed output all mean "nothing
to report" — never a failed review. Verified against the *real* unmocked path
with `trivy` genuinely absent: returns `[]` without throwing.

## Tests

`src/tests/trivyAdapter.test.ts` (21), `src/tests/secretsDetector.test.ts`,
`src/tests/injectionDetector.test.ts`, `src/tests/dependencyVulnerabilityChecker.test.ts`.

**Known gap:** `semgrepAdapter.ts` has no test coverage — it predates the
injectable pattern. Worth retrofitting.

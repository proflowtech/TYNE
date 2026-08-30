import test from 'node:test';
import assert from 'node:assert/strict';

import { iacTargets, parseTrivyConfigJson, collectTrivyFindings, type ExecFileFn } from '../quality/trivyAdapter';

/**
 * Phase D: Trivy config-scan adapter — the security-tool-breadth gap wasn't
 * "add 40 integrations", it was "have zero test coverage on the one external
 * scanner this repo already ships" (semgrepAdapter.ts has none). This adapter
 * is built injectable specifically so the whole path — detection, invocation,
 * parsing — is provable without a real trivy binary on the test machine.
 */

// ── iacTargets: detection ───────────────────────────────────────────────────

test('iacTargets matches Dockerfile variants', () => {
  assert.deepEqual(iacTargets(['Dockerfile']), ['Dockerfile']);
  assert.deepEqual(iacTargets(['Dockerfile.prod']), ['Dockerfile.prod']);
  assert.deepEqual(iacTargets(['services/api/Dockerfile']), ['services/api/Dockerfile']);
});

test('iacTargets matches docker-compose files', () => {
  assert.deepEqual(iacTargets(['docker-compose.yml']), ['docker-compose.yml']);
  assert.deepEqual(iacTargets(['docker-compose.yaml']), ['docker-compose.yaml']);
});

test('iacTargets matches Terraform files', () => {
  assert.deepEqual(iacTargets(['infra/main.tf']), ['infra/main.tf']);
  assert.deepEqual(iacTargets(['infra/vars.tfvars']), ['infra/vars.tfvars']);
});

test('iacTargets matches manifests under a k8s/ or kubernetes/ directory only', () => {
  assert.deepEqual(iacTargets(['k8s/deployment.yaml']), ['k8s/deployment.yaml']);
  assert.deepEqual(iacTargets(['kubernetes/service.yml']), ['kubernetes/service.yml']);
  // A random top-level yaml is not treated as a k8s manifest — too broad a match.
  assert.deepEqual(iacTargets(['config/settings.yaml']), []);
});

test('iacTargets matches CloudFormation templates', () => {
  assert.deepEqual(iacTargets(['stack.cfn.json']), ['stack.cfn.json']);
  assert.deepEqual(iacTargets(['stack.cfn.yaml']), ['stack.cfn.yaml']);
});

test('iacTargets ignores ordinary source files, including CI YAML', () => {
  assert.deepEqual(iacTargets(['src/index.ts', '.github/workflows/ci.yml', 'README.md']), []);
});

test('iacTargets normalizes Windows-style path separators before matching', () => {
  assert.deepEqual(iacTargets(['services\\api\\Dockerfile']), ['services/api/Dockerfile']);
});

test('iacTargets returns only the matching subset, preserving order', () => {
  const changed = ['src/app.ts', 'Dockerfile', 'README.md', 'infra/main.tf'];
  assert.deepEqual(iacTargets(changed), ['Dockerfile', 'infra/main.tf']);
});

// ── parseTrivyConfigJson: real output shape ─────────────────────────────────

const REAL_SHAPED_OUTPUT = JSON.stringify({
  Results: [
    {
      Target: 'Dockerfile',
      Class: 'config',
      Type: 'dockerfile',
      MisconfSummary: { Successes: 5, Failures: 2 },
      Misconfigurations: [
        {
          Type: 'Dockerfile Security Check',
          ID: 'DS002',
          AVDID: 'AVD-DS-0002',
          Title: "Image user should not be 'root'",
          Message: 'Specify at least 1 USER command in Dockerfile with non-root user as argument',
          Severity: 'HIGH',
          Resolution: 'Add \'USER <non root user name>\' line to the Dockerfile',
          Status: 'FAIL',
          CauseMetadata: { Provider: 'Dockerfile', Service: 'general', StartLine: 1, EndLine: 1 },
        },
        {
          Type: 'Dockerfile Security Check',
          ID: 'DS026',
          Title: 'No HEALTHCHECK defined',
          Message: 'Add HEALTHCHECK instruction in your Dockerfile',
          Severity: 'LOW',
          CauseMetadata: { StartLine: 3, EndLine: 3 },
        },
      ],
    },
  ],
});

test('parses real-shaped trivy config output into quality findings', () => {
  const findings = parseTrivyConfigJson(REAL_SHAPED_OUTPUT);
  assert.equal(findings.length, 2);

  const rootUser = findings[0];
  assert.equal(rootUser.ruleId, 'DS002');
  assert.equal(rootUser.file, 'Dockerfile');
  assert.equal(rootUser.severity, 'high');
  assert.equal(rootUser.line, 1);
  assert.equal(rootUser.detectedBy, 'trivy');
  assert.equal(rootUser.blocking, false);
  assert.match(rootUser.title, /root/i);
  assert.ok(rootUser.suggestedFix?.includes('USER'));
});

test('maps every trivy severity level, defaulting unknown to medium', () => {
  const bySeverity = (sev: string) => parseTrivyConfigJson(JSON.stringify({
    Results: [{ Target: 'x.tf', Misconfigurations: [{ ID: 'X1', Title: 't', Severity: sev }] }],
  }))[0].severity;

  assert.equal(bySeverity('CRITICAL'), 'critical');
  assert.equal(bySeverity('HIGH'), 'high');
  assert.equal(bySeverity('MEDIUM'), 'medium');
  assert.equal(bySeverity('LOW'), 'low');
  assert.equal(bySeverity('UNKNOWN'), 'medium');
  assert.equal(bySeverity(''), 'medium');
});

test('a critical finding is marked blocking; nothing else is', () => {
  const findings = parseTrivyConfigJson(JSON.stringify({
    Results: [{
      Target: 'main.tf',
      Misconfigurations: [
        { ID: 'C1', Title: 'critical one', Severity: 'CRITICAL' },
        { ID: 'C2', Title: 'high one', Severity: 'HIGH' },
      ],
    }],
  }));
  assert.equal(findings.find(f => f.ruleId === 'C1')?.blocking, true);
  assert.equal(findings.find(f => f.ruleId === 'C2')?.blocking, false);
});

test('handles multiple Results blocks across different target files', () => {
  const findings = parseTrivyConfigJson(JSON.stringify({
    Results: [
      { Target: 'Dockerfile', Misconfigurations: [{ ID: 'D1', Title: 'a', Severity: 'LOW' }] },
      { Target: 'infra/main.tf', Misconfigurations: [{ ID: 'T1', Title: 'b', Severity: 'HIGH' }] },
    ],
  }));
  assert.deepEqual(findings.map(f => f.file).sort(), ['Dockerfile', 'infra/main.tf']);
});

test('caps findings at 20 so one noisy file cannot dominate a review', () => {
  const misconfigs = Array.from({ length: 30 }, (_, i) => ({ ID: `R${i}`, Title: `finding ${i}`, Severity: 'LOW' }));
  const findings = parseTrivyConfigJson(JSON.stringify({ Results: [{ Target: 'big.tf', Misconfigurations: misconfigs }] }));
  assert.equal(findings.length, 20);
});

// ── parseTrivyConfigJson: malformed / absent input ──────────────────────────

test('tolerates empty, malformed, and structurally absent JSON', () => {
  assert.deepEqual(parseTrivyConfigJson(''), []);
  assert.deepEqual(parseTrivyConfigJson('not json at all'), []);
  assert.deepEqual(parseTrivyConfigJson('{}'), []);
  assert.deepEqual(parseTrivyConfigJson('{"Results": []}'), []);
  assert.deepEqual(parseTrivyConfigJson('{"Results": [{"Target": "x"}]}'), [], 'a result with no Misconfigurations key must not throw');
});

test('a clean scan with zero failures produces zero findings', () => {
  const findings = parseTrivyConfigJson(JSON.stringify({
    Results: [{ Target: 'Dockerfile', MisconfSummary: { Successes: 8, Failures: 0 }, Misconfigurations: [] }],
  }));
  assert.deepEqual(findings, []);
});

// ── collectTrivyFindings: orchestration with an injected runner ────────────

function fakeExec(stdout: string): ExecFileFn {
  return async () => ({ stdout, stderr: '' });
}

test('never invokes the subprocess when no changed file is IaC-relevant', async () => {
  let called = false;
  const exec: ExecFileFn = async () => { called = true; return { stdout: '{}', stderr: '' }; };
  const findings = await collectTrivyFindings({
    workspaceRoot: '/repo',
    changedFiles: ['src/index.ts', 'README.md'],
    execFileFn: exec,
  });
  assert.deepEqual(findings, []);
  assert.equal(called, false, 'trivy must not run at all when nothing IaC-relevant changed');
});

test('invokes trivy with exactly the IaC-relevant changed files as targets', async () => {
  let capturedArgs: string[] = [];
  let capturedCwd = '';
  const exec: ExecFileFn = async (_cmd, args, opts) => {
    capturedArgs = args;
    capturedCwd = opts.cwd;
    return { stdout: '{}', stderr: '' };
  };
  await collectTrivyFindings({
    workspaceRoot: '/repo',
    changedFiles: ['src/index.ts', 'Dockerfile', 'infra/main.tf'],
    execFileFn: exec,
  });
  assert.deepEqual(capturedArgs.slice(-2), ['Dockerfile', 'infra/main.tf'], 'only IaC files are passed as targets');
  assert.ok(!capturedArgs.includes('src/index.ts'), 'a non-IaC changed file must not be passed to trivy');
  assert.equal(capturedCwd, '/repo');
});

test('parses through to real findings end to end when trivy succeeds', async () => {
  const findings = await collectTrivyFindings({
    workspaceRoot: '/repo',
    changedFiles: ['Dockerfile'],
    execFileFn: fakeExec(REAL_SHAPED_OUTPUT),
  });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].detectedBy, 'trivy');
});

test('degrades to empty findings when the trivy binary is missing (ENOENT-style rejection)', async () => {
  const exec: ExecFileFn = async () => { throw new Error('spawn trivy ENOENT'); };
  const findings = await collectTrivyFindings({
    workspaceRoot: '/repo',
    changedFiles: ['Dockerfile'],
    execFileFn: exec,
  });
  assert.deepEqual(findings, []);
});

test('degrades to empty findings on a non-zero exit / timeout rejection', async () => {
  const exec: ExecFileFn = async () => { throw new Error('Command failed: trivy config ... exit code 1'); };
  const findings = await collectTrivyFindings({
    workspaceRoot: '/repo',
    changedFiles: ['Dockerfile'],
    execFileFn: exec,
  });
  assert.deepEqual(findings, []);
});

test('degrades to empty findings when trivy prints malformed output instead of failing', async () => {
  const findings = await collectTrivyFindings({
    workspaceRoot: '/repo',
    changedFiles: ['Dockerfile'],
    execFileFn: fakeExec('not valid json{{{'),
  });
  assert.deepEqual(findings, []);
});

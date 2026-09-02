import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildA2AStaffPrompt,
  buildPmGhostCopPrompt,
  compileGoldenContract,
  driftFindingsFromResolved,
  parseA2AVerdict,
  parseScopeDriftMatrix,
  pendingGoalsFromDrift,
  resolveScopeDrift,
} from '../scopeDriftHarness';
import {
  mergeAgentFindings,
  verifyPmGhostCopOutput,
  verifySentinelOutput,
  verifyStaffEngineerOutput,
} from '../pevAgents';
import * as fs from 'fs';
import * as path from 'path';

describe('scope drift matrix', () => {
  test('parses matrix and detects unmapped additions', () => {
    const matrix = parseScopeDriftMatrix({
      ticket_requirements: ['Add OAuth Login', 'Save user to DB'],
      developer_additions: ['NextAuth Provider', 'Supabase Insert', 'Resend Email Trigger'],
      unmapped_additions: ['Resend Email Trigger'],
      drift_detected: true,
    });
    assert.ok(matrix);
    assert.equal(matrix!.drift_detected, true);
    assert.deepEqual(matrix!.unmapped_additions, ['Resend Email Trigger']);
  });

  test('A2A required overrules to clean', () => {
    const matrix = parseScopeDriftMatrix({
      ticket_requirements: ['Add OAuth Login'],
      developer_additions: ['NextAuth', 'Resend Email'],
      unmapped_additions: ['Resend Email'],
      drift_detected: true,
    })!;
    const resolved = resolveScopeDrift(matrix, [
      parseA2AVerdict({ required_dependency: true, reason: 'NextAuth magic links need email transport' }, 'Resend Email'),
    ]);
    assert.equal(resolved.matrix.drift_detected, false);
    assert.deepEqual(resolved.overruled, ['Resend Email']);
    assert.deepEqual(resolved.lockedDrift, []);
    assert.equal(driftFindingsFromResolved(resolved).length, 0);
  });

  test('A2A standalone locks drift', () => {
    const matrix = parseScopeDriftMatrix({
      ticket_requirements: ['Add OAuth Login'],
      developer_additions: ['Newsletter signup'],
      unmapped_additions: ['Newsletter signup'],
      drift_detected: true,
    })!;
    const resolved = resolveScopeDrift(matrix, [
      parseA2AVerdict({
        required_dependency: false,
        material_risk: true,
        confidence: 'high',
        evidence: 'Adds a new newsletter signup endpoint and persisted subscriber records.',
        reason: 'Standalone marketing feature',
      }, 'Newsletter signup'),
    ]);
    assert.equal(resolved.matrix.drift_detected, true);
    assert.deepEqual(resolved.lockedDrift, ['Newsletter signup']);
    const findings = driftFindingsFromResolved(resolved);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, 'pm_alignment');
    assert.equal(pendingGoalsFromDrift(resolved)[0].priority, 'high');
  });

  test('failed or incomplete A2A evidence stays inconclusive instead of becoming high-confidence drift', () => {
    const matrix = parseScopeDriftMatrix({
      ticket_requirements: ['Document test command'],
      developer_additions: ['Newsletter signup'],
      unmapped_additions: ['Newsletter signup'],
      drift_detected: true,
    })!;
    const resolved = resolveScopeDrift(matrix, []);
    assert.deepEqual(resolved.lockedDrift, []);
    assert.deepEqual(resolved.inconclusive, ['Newsletter signup']);
    assert.equal(driftFindingsFromResolved(resolved).length, 0);
  });

  test('benign docs and requirement gaps cannot masquerade as scope drift', () => {
    const matrix = parseScopeDriftMatrix({
      ticket_requirements: ['README explains dummy project'],
      developer_additions: [
        'Added information about npm run lint to README.md',
        'Added Healistry purpose but does not explain the required dummy validation purpose',
      ],
      unmapped_additions: [
        'Added information about npm run lint to README.md',
        'Added Healistry purpose but does not explain the required dummy validation purpose',
      ],
      drift_detected: true,
    })!;
    const verdicts = matrix.unmapped_additions.map(addition => parseA2AVerdict({
      required_dependency: false,
      material_risk: true,
      confidence: 'high',
      evidence: 'Model claimed this was outside the ticket.',
    }, addition));
    const resolved = resolveScopeDrift(matrix, verdicts);
    assert.deepEqual(resolved.lockedDrift, []);
    assert.equal(resolved.matrix.drift_detected, false);
  });

  test('golden contract compiles PM ticket', () => {
    const xml = compileGoldenContract({
      source: 'linear',
      issueIdentifier: 'TYN-1',
      title: 'OAuth',
      goal: 'Login',
      acceptanceCriteria: ['User can sign in'],
    });
    assert.match(xml, /TYN-1/);
    assert.match(xml, /User can sign in/);
  });

  test('PM and A2A prompts exist', () => {
    const pm = buildPmGhostCopPrompt('ticket', 'diff --git a/x');
    assert.match(pm.user, /<linear_ticket>/);
    assert.match(pm.system, /Product Manager/);
    const a2a = buildA2AStaffPrompt('Resend', ['OAuth'], 'diff');
    assert.match(a2a.system, /Principal Engineer/);
    assert.match(a2a.user, /required_dependency/);
    assert.match(a2a.user, /material_risk/);
    assert.match(a2a.user, /exact changed behavior/i);
  });
});

describe('PEV agent verify stage', () => {
  test('sentinel drops false positives and validates schema', () => {
    const out = verifySentinelOutput({
      securityStatus: 'needs_work',
      summary: 'one issue',
      findings: [
        { file: 'a.ts', title: 'Secret', severity: 'critical', category: 'security', explanation: 'x', confidence: 'high' },
        { file: 'b.ts', title: 'FP', severity: 'low', category: 'security', explanation: 'x', confidence: 'low', falsePositive: true },
        { title: 'missing file' },
      ],
    });
    assert.ok(out);
    assert.equal(out!.findings.length, 1);
    assert.equal(out!.findings[0].title, 'Secret');
  });

  test('staff engineer schema + merge', () => {
    const staff = verifyStaffEngineerOutput({
      score: 72,
      summary: 'n+1',
      findings: [
        { file: 'db.ts', line: 10, title: 'N+1 query', severity: 'high', category: 'performance', explanation: 'loop', confidence: 'high' },
      ],
    });
    assert.ok(staff);
    assert.equal(staff!.score, 72);
    const merged = mergeAgentFindings(staff!.findings, staff!.findings);
    assert.equal(merged.length, 1);
  });

  test('pm ghost cop schema', () => {
    const pm = verifyPmGhostCopOutput({
      ticket_requirements: ['A'],
      developer_additions: ['A', 'B'],
      unmapped_additions: ['B'],
      drift_detected: true,
    });
    assert.ok(pm);
    assert.equal(pm!.drift_detected, true);
  });
});

describe('edge wiring', () => {
  test('tyne-validate-review imports PEV harness', () => {
    const edge = fs.readFileSync(
      path.join(__dirname, '../../supabase/functions/tyne-validate-review/index.ts'),
      'utf8',
    );
    assert.match(edge, /runScopeDriftA2A/);
    assert.match(edge, /runPevSpecialistAgents/);
    assert.match(edge, /applyScopeDriftToResult/);
    assert.match(edge, /<linear_ticket>/);
    assert.match(edge, /scopeDriftHarness/);
    assert.match(edge, /pevAgents/);
  });

  test('UI renders drift matrix', () => {
    const ui = fs.readFileSync(path.join(__dirname, '../../media/tyne.js'), 'utf8');
    assert.match(ui, /function renderDriftMatrix/);
    assert.match(ui, /vr-drift-matrix/);
    assert.match(ui, /scopeDriftExplanation/);
  });

  test('validate review service wires scope drift explainer', () => {
    const service = fs.readFileSync(path.join(__dirname, '../../src/validateReviewService.ts'), 'utf8');
    assert.match(service, /explainScopeDrift/);
    assert.match(service, /scopeDriftExplanation/);
  });
});

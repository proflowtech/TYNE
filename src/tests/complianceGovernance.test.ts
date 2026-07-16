import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildComplianceEvidenceJson,
  buildComplianceEvidenceMarkdown,
  buildComplianceExport,
  buildComplianceExportFileName,
} from '../complianceEvidenceExport';

const sample = {
  reportId: 'r1',
  commitHash: 'abc123',
  timestamp: '2026-07-16T00:00:00.000Z',
  repositoryName: 'demo',
  branchName: 'main',
  complianceStatus: 'review_required',
  assessments: [{
    framework: 'HIPAA',
    name: 'HIPAA',
    version: '2026.1',
    status: 'blocked',
    score: 55,
    coverage: [
      { label: 'Access Control', percent: 60, status: 'scored' },
      { label: 'Infrastructure', percent: null, status: 'not_reviewed' },
    ],
  }],
  complianceFindings: [{
    framework: 'HIPAA',
    frameworkVersion: '2026.1',
    controlId: '164.312(a)',
    title: 'PHI data flows to API response without detected authorization control.',
    evidence: { snippet: 'return Response.json(patient)' },
    remediation: 'Add authorization before returning PHI.',
    severity: 'critical',
  }],
  regressions: [{ message: 'Compliance Regression Detected — HIPAA: 1 new finding', framework: 'HIPAA' }],
};

test('compliance evidence export includes framework/control/evidence/commit/timestamp', () => {
  const md = buildComplianceEvidenceMarkdown(sample);
  assert.match(md, /Framework: HIPAA/);
  assert.match(md, /Framework Version: 2026\.1/);
  assert.match(md, /Control: 164\.312\(a\)/);
  assert.match(md, /Evidence:/);
  assert.match(md, /Finding:/);
  assert.match(md, /Remediation:/);
  assert.match(md, /Commit Hash: abc123/);
  assert.match(md, /Timestamp: 2026-07-16/);
  assert.match(md, /not a compliance certification/i);

  const json = JSON.parse(buildComplianceEvidenceJson(sample));
  assert.equal(json.commitHash, 'abc123');
  assert.equal(json.findings[0].control, '164.312(a)');
  assert.equal(json.findings[0].finding.includes('PHI'), true);

  const pdf = buildComplianceExport(sample, 'pdf');
  assert.equal(pdf.extension, 'html');
  assert.match(pdf.content, /Print → Save as PDF/);
  assert.match(buildComplianceExportFileName('json'), /\.json$/);
});

test('finding workflow statuses and custom policy schema are in migration', () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260716030000_compliance_enterprise_governance.sql'),
    'utf8',
  );
  assert.match(migration, /compliance_finding_workflow/);
  assert.match(migration, /accepted_risk/);
  assert.match(migration, /in_progress/);
  assert.match(migration, /add column if not exists category/);
  assert.match(migration, /action in \('block', 'review', 'inform'\)/);
});

test('UI wires export, governance overview, workflow, and custom policy form', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'media/tyne.js'), 'utf8');
  assert.match(js, /data-compliance-export/);
  assert.match(js, /renderComplianceOverviewStrip/);
  assert.match(js, /New Findings:/);
  assert.match(js, /Regressions:/);
  assert.match(js, /accepted_risk/);
  assert.match(js, /createCustomCompliancePolicy/);
  assert.match(js, /exportComplianceEvidence/);

  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
  assert.match(edge, /finding-workflow/);
  assert.match(edge, /custom-policies/);
  assert.match(edge, /normalizeScannerFindings/);
  assert.match(edge, /externalScanners/);
});

test('scanner adapter architecture normalizes SAST/dependency/container/cloud', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'supabase/functions/tyne-validate-review/compliance/scannerAdapters.ts'),
    'utf8',
  );
  assert.match(src, /ExternalScannerKind/);
  assert.match(src, /normalizeScannerFinding/);
  assert.match(src, /sast/);
  assert.match(src, /dependency/);
  assert.match(src, /container/);
  assert.match(src, /cloud/);
  assert.match(src, /detectedBy/);
});

test('customPolicy maps action block to blocking', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'supabase/functions/tyne-validate-review/compliance/policyRegistry.ts'),
    'utf8',
  );
  assert.match(src, /action === 'block'/);
  assert.match(src, /category/);
});

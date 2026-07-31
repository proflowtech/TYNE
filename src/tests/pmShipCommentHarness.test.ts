import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShipCommentFacts,
  buildTemplateHumanizedParts,
  formatHumanizedNarrative,
  buildShipCommentHtmlReport,
  composeShipCommentBody,
  splitShipCommentHtmlAppendix,
} from '../services/pmShipCommentHarness';

test('buildTemplateHumanizedParts is dual-audience and human', () => {
  const facts = buildShipCommentFacts({
    taskId: 'PRO-1',
    taskTitle: 'Fix login refresh',
    branchName: 'tyne/PRO-1-login',
    commitHash: 'abc12345',
    commitUrl: 'https://github.com/org/repo/commit/abc12345',
    validationStatus: 'pass',
    riskLevel: 'low',
    validationResult: {
      id: 'v1',
      provider: 'managed',
      tier: 'pro',
      status: 'pass',
      summary: 'Token refresh works for expired sessions.',
      matchPercent: 90,
      riskLevel: 'low',
      criteriaMet: ['Refreshes expired tokens'],
      suggestions: ['Add a 401 interceptor'],
      createdAt: new Date().toISOString(),
    } as any,
  });
  const parts = buildTemplateHumanizedParts(facts);
  assert.equal(parts.source, 'template');
  assert.match(parts.pmSummary, /Fix login refresh/);
  assert.ok(parts.techLeadNotes.some(n => /Branch|Risk|Done/i.test(n)));
  const narrative = formatHumanizedNarrative(parts, facts);
  assert.match(narrative, /For PMs \/ stakeholders:/);
  assert.match(narrative, /For tech leads:/);
  assert.match(narrative, /Commit:/);
  assert.ok(!/AI analysis|the model suggests/i.test(narrative));
});

test('HTML report appendix composes and splits cleanly', () => {
  const facts = buildShipCommentFacts({
    taskId: 'PRO-2',
    taskTitle: 'Billing',
    validationStatus: 'partial',
    riskLevel: 'medium',
  });
  const html = buildShipCommentHtmlReport(facts);
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /Tyne ship report/);
  assert.match(html, /Billing/);

  const body = composeShipCommentBody('Status update — PRO-2\n\nShipped.', html);
  assert.match(body, /--- HTML report ---/);
  assert.match(body, /```html/);
  const split = splitShipCommentHtmlAppendix(body);
  assert.match(split.narrative, /Status update/);
  assert.match(split.html, /<!DOCTYPE html>/i);
  assert.ok(!split.html.includes('```'));
});

test('jiraProvider comment ADF includes codeBlock for HTML appendix', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
  assert.match(src, /--- HTML report ---/);
  assert.match(src, /type: 'codeBlock'/);
  assert.match(src, /language: 'html'/);
});

test('buildFeedback routes through balanced ship comment harness', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/workFeedbackService.ts'), 'utf8');
  assert.match(src, /buildBalancedShipComment/);
  assert.match(src, /buildShipCommentFacts/);
});

test('pm-ship-comment edge prefers gemini flash', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const policy = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/_shared/aicreditsModelPolicy.ts'), 'utf8');
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/pm-ship-comment/index.ts'), 'utf8');
  assert.match(policy, /pm_ship_comment/);
  assert.match(policy, /google\/gemini-2\.5-flash/);
  assert.match(edge, /pm_ship_comment/);
  assert.match(edge, /pmSummary/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShipCommentFacts,
  buildTemplateHumanizedParts,
  formatHumanizedNarrative,
  buildShipCommentHtmlReport,
  composeShipCommentBody,
  splitShipCommentHtmlAppendix,
  reviewPackFilename,
} from '../services/pmShipCommentHarness';

test('buildTemplateHumanizedParts is a professional close-out', () => {
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
  assert.ok(!/we finished/i.test(parts.pmSummary));
  assert.ok(parts.techLeadNotes.some(n => /Branch|Risk|Acceptance|Review/i.test(n)));
  const narrative = formatHumanizedNarrative(parts, facts);
  assert.match(narrative, /Close-out — PRO-1/);
  assert.match(narrative, /^Delivery \(PM \/ BA\)$/m);
  assert.match(narrative, /^Engineering$/m);
  assert.match(narrative, /Outcome: Passed/);
  assert.match(narrative, /Commit:/);
  assert.ok(!/AI analysis|the model suggests/i.test(narrative));
  assert.doesNotMatch(narrative, /<!DOCTYPE html>/i);
});

test('composeShipCommentBody does not paste HTML into the comment', () => {
  const facts = buildShipCommentFacts({
    taskId: 'PRO-2',
    taskTitle: 'Billing',
    validationStatus: 'partial',
    riskLevel: 'medium',
  });
  const html = buildShipCommentHtmlReport(facts);
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /Print → Save as PDF/);

  const body = composeShipCommentBody('Close-out — PRO-2\n\nShipped.', html);
  assert.doesNotMatch(body, /--- HTML report ---/);
  assert.doesNotMatch(body, /```html/);
  assert.doesNotMatch(body, /<!DOCTYPE html>/i);
  assert.match(body, /Close-out — PRO-2/);
  const split = splitShipCommentHtmlAppendix(`x\n--- HTML report ---\n<html></html>\n--- end HTML report ---`);
  assert.equal(split.narrative, 'x');
  assert.match(split.html, /<html>/);
  assert.equal(reviewPackFilename('jira:PRO-2'), 'PRO-2-tyne-review.html');
});

test('jiraProvider comment ADF uses headings and bullets, not an HTML code block', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
  assert.match(src, /type: 'heading'/);
  assert.match(src, /type: 'bulletList'/);
  assert.match(src, /type: 'link'/);
  assert.doesNotMatch(src, /language: 'html'/);
  assert.match(src, /attachFile/);
  assert.match(src, /X-Atlassian-Token/);
});

test('postFeedback attaches review HTML on Jira instead of dumping it in the comment', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const auto = fs.readFileSync(path.join(process.cwd(), 'src/taskAutomationService.ts'), 'utf8');
  const api = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/jira-api-request/index.ts'), 'utf8');
  assert.match(auto, /adapter\.attachFile/);
  assert.match(auto, /Print → Save as PDF/);
  assert.match(auto, /Evidence is in the comment fields above/);
  assert.doesNotMatch(auto, /composeShipCommentBody/);
  assert.match(api, /attachments/);
  assert.match(api, /X-Atlassian-Token/);
});

test('buildFeedback routes through balanced ship comment harness', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/workFeedbackService.ts'), 'utf8');
  assert.match(src, /buildBalancedShipComment/);
  assert.match(src, /buildShipCommentFacts/);
  assert.match(src, /buildValidateReviewPdfHtml/);
  assert.match(src, /evidenceHtml/);
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
  assert.match(edge, /senior engineer/);
});

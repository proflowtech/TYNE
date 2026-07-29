/**
 * Legacy tyne-code-review pipeline was merged into Validate & Review.
 * These tests lock the merge: deleted modules stay gone; quick mode routes through validateReviewService.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('legacy codeReviewService modules are deleted', () => {
  const root = process.cwd();
  assert.equal(fs.existsSync(path.join(root, 'src/codeReviewService.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/codeReviewTypes.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/codeReviewContextCollector.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'supabase/functions/tyne-code-review/index.ts')), false);
});

test('sidebar routes technical review through validateReviewService', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8')
    + '\n' + fs.readFileSync(path.join(process.cwd(), 'src/sidebar/validateReviewController.ts'), 'utf8');
  assert.match(src, /_handleRunCodeReview/);
  assert.match(src, /getValidateReviewService/);
  assert.doesNotMatch(src, /getCodeReviewService/);
  assert.match(src, /reviewMode.*quick|ReviewMode/);
});

test('validateReviewService accepts mode + progress callback', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/validateReviewService.ts'), 'utf8');
  assert.match(src, /mode: ReviewMode = 'full'/);
  assert.match(src, /onProgress\?/);
  assert.match(src, /autoSelectMode/);
  assert.match(src, /classifyPrSize/);
  assert.match(src, /actualModeUsed/);
});

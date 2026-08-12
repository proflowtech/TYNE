import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { applyProofStrikeOff, buildProofChecklist } from '../taskEnrichmentService';

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf8');
}

test('applyProofStrikeOff strikes all on pass', () => {
  const items = buildProofChecklist([], ['User can sign in', 'Errors are shown'], 't');
  assert.equal(applyProofStrikeOff(items, { status: 'pass', criteriaMet: [] }), true);
  assert.equal(items.every(s => s.done), true);
});

test('applyProofStrikeOff strikes matched criteria on partial', () => {
  const items = buildProofChecklist([], ['User can sign in', 'Errors are shown'], 't');
  assert.equal(applyProofStrikeOff(items, {
    status: 'partial',
    criteriaMet: ['User can sign in'],
  }), true);
  assert.equal(items[0].done, true);
  assert.equal(items[1].done, false);
});

test('applyProofStrikeOff fuzzy-matches long criterion text', () => {
  const items = buildProofChecklist([], ['User can request a password reset link'], 't');
  assert.equal(applyProofStrikeOff(items, {
    status: 'partial',
    criteriaMet: ['User can request a password reset'],
  }), true);
  assert.equal(items[0].done, true);
});

test('applyProofStrikeOff token-matches completedGoals titles', () => {
  const items = buildProofChecklist([], ['OAuth login works'], 't');
  assert.equal(applyProofStrikeOff(items, {
    status: 'partial',
    criteriaMet: [],
    completedGoals: [{ title: 'Implement OAuth login flow' }],
  }), true);
  assert.equal(items[0].done, true);
});

test('applyProofStrikeOff is a no-op when nothing matches', () => {
  const items = buildProofChecklist([], ['Unrelated proof'], 't');
  assert.equal(applyProofStrikeOff(items, {
    status: 'fail',
    criteriaMet: ['Something else entirely'],
  }), false);
  assert.equal(items[0].done, false);
});

test('loadTaskIntoThread clears then rehydrates validation for the opened task', () => {
  const src = readSrc('sidebar/threadWorkflowController.ts');
  const start = src.indexOf('async loadTaskIntoThread(');
  const body = src.slice(start, start + 2800);
  const clearIdx = body.indexOf('this.clearValidationForNewTask()');
  const rehydrateIdx = body.indexOf('this.host.rehydrateValidationForTask(taskId)');
  assert.ok(clearIdx >= 0, 'must clear stale validation');
  assert.ok(rehydrateIdx >= 0, 'must rehydrate from history');
  assert.ok(clearIdx < rehydrateIdx, 'clear must run before rehydrate');
});

test('rehydrateValidationForTask posts validationComplete and marks proofs', () => {
  const src = readSrc('sidebar/validateReviewController.ts');
  const start = src.indexOf('async rehydrateValidationForTask(');
  assert.notEqual(start, -1, 'rehydrateValidationForTask must exist');
  const body = src.slice(start, start + 1200);
  assert.ok(body.includes('getLatestValidationForTask'), 'reads history');
  assert.ok(body.includes("type: 'validationComplete'"), 'restores Thread latest review');
  assert.ok(body.includes('this.markProofPointsMet(prior)'), 'strikes proof points');
  assert.ok(body.includes('prior.taskId !== id'), 'rejects mismatched task history');
});

test('enrichment rebuild re-applies proof strike-off', () => {
  const src = readSrc('sidebar/pmIntelligenceController.ts');
  assert.ok(src.includes('reapplyProofStrikeOff'), 'must reapply after checklist rebuild');
  assert.ok(src.includes('markProofPointsMet(current)'), 'in-memory result path');
  assert.ok(src.includes('rehydrateValidationForTask(taskId)'), 'history fallback path');
});

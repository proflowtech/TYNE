/**
 * Covers three defects in the epic → task → thread path:
 *   1. PM intelligence (goal, acceptance criteria, proof points) was dropped
 *      when the task had no cached detail record.
 *   2. Tasks created from an epic did not appear in the Tasks tab until the
 *      next sync, because the cache was written but the view was never re-posted.
 *   3. Tasks created from an epic had no way to carry a due date.
 *
 * The wiring assertions read the shipped sources, matching the approach in
 * taskEnrichment.test.ts — the provider needs a live vscode host to construct.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTaskDueDate } from '../storyDecompositionHarness';

const root = join(__dirname, '../..');
const hostSrc = readFileSync(join(root, 'src/TyneSidebarProvider.ts'), 'utf8')
  + '\n' + readFileSync(join(root, 'src/sidebar/sidebarHtml.ts'), 'utf8');
const jiraSrc = readFileSync(join(root, 'src/jiraProvider.ts'), 'utf8');
const tyneJs = readFileSync(join(root, 'media/tyne.js'), 'utf8');

describe('normalizeTaskDueDate', () => {
  it('accepts a bare calendar date', () => {
    assert.equal(normalizeTaskDueDate('2026-08-14'), '2026-08-14');
    assert.equal(normalizeTaskDueDate('  2026-08-14  '), '2026-08-14');
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    for (const bad of ['14-08-2026', '2026/08/14', '2026-08-14T00:00:00Z', 'tomorrow', '', '2026-8-4']) {
      assert.equal(normalizeTaskDueDate(bad), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it('rejects real-looking but invalid calendar dates', () => {
    // Date rolls these forward silently, which would send Jira a different day
    // than the developer picked.
    assert.equal(normalizeTaskDueDate('2026-02-31'), undefined);
    assert.equal(normalizeTaskDueDate('2026-13-01'), undefined);
  });

  it('rejects non-strings rather than coercing', () => {
    for (const bad of [undefined, null, 42, {}, ['2026-08-14']]) {
      assert.equal(normalizeTaskDueDate(bad), undefined);
    }
  });
});

describe('PM intelligence is persisted even without a cached detail record', () => {
  it('_storePmIntelligence falls back to a task shell instead of returning early', () => {
    const fn = hostSrc.slice(
      hostSrc.indexOf('private async _storePmIntelligence('),
      hostSrc.indexOf('private _taskShellForId('),
    );
    assert.ok(fn.length > 0, 'expected _storePmIntelligence to precede _taskShellForId');
    // The old bug: the only saveTaskDetails call sat behind `if (details)`.
    assert.ok(
      fn.includes('this._taskShellForId(taskId)'),
      'expected a shell fallback when no details record exists',
    );
    assert.equal(
      (fn.match(/saveTaskDetails\(/g) || []).length, 2,
      'expected both the existing-details path and the shell path to save',
    );
    assert.ok(fn.includes('pmIntelligence: intelligence'), 'expected the intelligence to be written');
  });

  it('the shell carries the fields TyneTaskDetails requires', () => {
    const shell = hostSrc.slice(
      hostSrc.indexOf('private _taskShellForId('),
      hostSrc.indexOf('private _postAuthState('),
    );
    for (const field of ['id:', 'externalId:', 'title:', 'normalizedStatus:', 'normalizedPriority:', 'sourceTool:']) {
      assert.ok(shell.includes(field), `shell is missing ${field}`);
    }
    // Only builds a shell for the task actually in the thread, so a stale id
    // cannot inject a junk row into the details cache.
    assert.ok(shell.includes('this._state.taskId !== taskId'), 'expected the shell to be scoped to the active thread');
  });
});

describe('tasks created from an epic surface in the Tasks tab', () => {
  const handler = hostSrc.slice(
    hostSrc.indexOf('private async _handleStoryDecomposeCreate('),
    hostSrc.indexOf('// ── Pro/Max: Advanced query'),
  );

  it('refreshes the task view after merging the created stubs', () => {
    assert.ok(handler.includes('await mergeCreatedStubs();'), 'expected stubs to be merged');
    const mergeAt = handler.indexOf('await mergeCreatedStubs();');
    const refreshAt = handler.indexOf('_refreshTasksContext(true)');
    assert.ok(refreshAt > -1, 'expected the tasks context to be refreshed after creation');
    assert.ok(refreshAt > mergeAt, 'expected the refresh to run after the stubs are saved');
  });

  it('still posts the created result to the decomposition panel', () => {
    assert.ok(handler.includes("type: 'storyDecomposeCreated'"));
  });
});

describe('due date on tasks created from an epic', () => {
  it('is normalized in the host before use', () => {
    assert.ok(hostSrc.includes('const dueDate = normalizeTaskDueDate(rawDueDate);'));
  });

  it('reaches both the PM issue and the local cache stub', () => {
    const handler = hostSrc.slice(
      hostSrc.indexOf('private async _handleStoryDecomposeCreate('),
      hostSrc.indexOf('// ── Pro/Max: Advanced query'),
    );
    assert.ok(
      handler.includes('description: buildPmSubtaskDescription(task), dueDate'),
      'expected the due date to be passed to createSubtaskIssues',
    );
    const stubs = handler.slice(handler.indexOf('const mergeCreatedStubs'));
    assert.ok(stubs.includes('dueDate,'), 'expected the cached stub to carry the due date');
  });

  it('maps to Jira\'s duedate field only when present', () => {
    assert.ok(jiraSrc.includes('dueDate?: string'), 'expected the adapter to accept a due date');
    assert.ok(
      jiraSrc.includes('...(subtask.dueDate ? { duedate: subtask.dueDate } : {})'),
      'expected duedate to be omitted rather than sent empty',
    );
  });

  it('is collected by the webview before the preview is torn down', () => {
    const create = tyneJs.slice(tyneJs.indexOf('    create(inPmTool) {'));
    const body = create.slice(0, create.indexOf('\n    },'));
    const readAt = body.indexOf("$('sdDueDate')");
    const renderAt = body.indexOf('this._renderQuiet(');
    assert.ok(readAt > -1, 'expected the due date input to be read');
    assert.ok(renderAt > -1, 'expected the loader to replace the preview');
    assert.ok(readAt < renderAt, 'due date must be read before the preview markup is replaced');
    assert.ok(body.includes('dueDate: this.dueDate || undefined'), 'expected the due date to be posted');
  });

  it('is cleared when the decomposition panel resets', () => {
    const reset = tyneJs.slice(tyneJs.indexOf('    reset() {'));
    assert.ok(reset.slice(0, reset.indexOf('\n    },')).includes('this.dueDate = \'\''));
  });
});

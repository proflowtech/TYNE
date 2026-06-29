import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Tests for Start Thread state management and validation CTA logic.
// These exercise the webview JS and the gitManager types without spinning up
// a full VS Code extension host.

const tyneJsSource = readFileSync(join(__dirname, '../../media/tyne.js'), 'utf8');
const hostSrc = readFileSync(join(__dirname, '../../src/TyneSidebarProvider.ts'), 'utf8');

// ── Webview message protocol invariants ────────────────────────────────────────

describe('Start Thread — webview message protocol', () => {
  it('gitStatusLoaded handler is present in tyne.js', () => {
    assert.ok(
      tyneJsSource.includes("msg.type === 'gitStatusLoaded'"),
      'tyne.js must handle the gitStatusLoaded message type',
    );
  });

  it('renderGitStatusHint function is defined', () => {
    assert.ok(
      tyneJsSource.includes('function renderGitStatusHint'),
      'tyne.js must define renderGitStatusHint()',
    );
  });

  it('gitStatusHint element is referenced', () => {
    assert.ok(
      tyneJsSource.includes("$('gitStatusHint')"),
      'tyne.js must reference the gitStatusHint DOM element',
    );
  });

  it('applyStatus calls renderGitStatusHint', () => {
    assert.ok(
      tyneJsSource.includes('renderGitStatusHint()'),
      'applyStatus() must call renderGitStatusHint()',
    );
  });

  it('start thread button does not carry the external-open data-task-url attribute', () => {
    const startIdx = tyneJsSource.indexOf("const startBtn = $('taskDetailStartThreadBtn');");
    assert.notEqual(startIdx, -1, 'renderDetail must set up taskDetailStartThreadBtn');
    const endIdx = tyneJsSource.indexOf("const tdCopyIdBtn = $('tdCopyIdBtn');", startIdx);
    const block = tyneJsSource.slice(startIdx, endIdx);
    assert.equal(
      /startBtn\.dataset\.taskUrl\s*=/.test(block),
      false,
      'Start Thread button must not assign data-task-url, which opens Jira externally',
    );
  });

  it('weaving page renders the current task row and change-task picker', () => {
    assert.ok(
      tyneJsSource.includes("$('bsTask')"),
      'weaving brief summary must render a task row (bsTask)',
    );
    assert.ok(
      tyneJsSource.includes("$('weavingTaskPicker')"),
      'weaving page must include a task picker for changing the active task',
    );
  });

  it('weaving task picker posts switchTaskInThread', () => {
    assert.ok(
      tyneJsSource.includes("type: 'switchTaskInThread'"),
      'weaving task picker must post switchTaskInThread',
    );
  });

  it('host handles switchTaskInThread and prompts for branch behavior', () => {
    assert.ok(
      hostSrc.includes("case 'switchTaskInThread'"),
      'host must route switchTaskInThread',
    );
    assert.ok(
      hostSrc.includes('private async _handleSwitchTaskInThread('),
      'host must implement _handleSwitchTaskInThread',
    );
    assert.ok(
      hostSrc.includes('Switch to branch') && hostSrc.includes('Keep current branch'),
      'switch handler must prompt for branch behavior',
    );
  });

  it('global zipline runner is wired to host runner messages', () => {
    assert.ok(
      tyneJsSource.includes("msg.type === 'runner'"),
      'tyne.js must handle runner messages from the host',
    );
    assert.ok(
      tyneJsSource.includes('function setRunner'),
      'tyne.js must define a global runner control function',
    );
  });
});

// ── Validation CTA state machine ──────────────────────────────────────────────

// Inline port of the CTA logic from tyne.js so we can unit-test it without a DOM.
function getCtaHint(opts: {
  isWeaving: boolean;
  stagedFiles: number;
  unstagedFiles: number;
  isClean: boolean;
  ctaReason: string;
}): string {
  const { isWeaving, stagedFiles, unstagedFiles, isClean, ctaReason } = opts;
  if (!isWeaving) { return ''; }
  if (ctaReason === 'no_changes' || isClean) { return 'No code changes detected yet.'; }
  if (stagedFiles > 0 && unstagedFiles === 0) {
    return `${stagedFiles} staged change(s) ready — validate or generate a commit.`;
  }
  if (stagedFiles > 0) {
    return `${stagedFiles} staged + ${unstagedFiles} unstaged change(s). Validate or save a stitch.`;
  }
  if (unstagedFiles > 0) {
    return `${unstagedFiles} unstaged change(s). Stage your changes to validate or generate a commit.`;
  }
  return '';
}

describe('Validation CTA hint text', () => {
  it('shows "No code changes detected yet" when working tree is clean', () => {
    const hint = getCtaHint({ isWeaving: true, stagedFiles: 0, unstagedFiles: 0, isClean: true, ctaReason: 'no_changes' });
    assert.ok(hint.includes('No code changes'), hint);
  });

  it('shows "Stage your changes" when only unstaged changes exist', () => {
    const hint = getCtaHint({ isWeaving: true, stagedFiles: 0, unstagedFiles: 3, isClean: false, ctaReason: 'has_unstaged' });
    assert.ok(hint.includes('Stage your changes'), hint);
    assert.ok(hint.includes('3 unstaged'), hint);
  });

  it('shows "validate or generate a commit" when staged changes exist and no unstaged', () => {
    const hint = getCtaHint({ isWeaving: true, stagedFiles: 2, unstagedFiles: 0, isClean: false, ctaReason: 'has_staged' });
    assert.ok(hint.includes('validate or generate a commit'), hint);
    assert.ok(hint.includes('2 staged'), hint);
  });

  it('shows combined message when both staged and unstaged changes exist', () => {
    const hint = getCtaHint({ isWeaving: true, stagedFiles: 1, unstagedFiles: 2, isClean: false, ctaReason: 'has_staged' });
    assert.ok(hint.includes('staged'), hint);
    assert.ok(hint.includes('unstaged'), hint);
  });

  it('returns empty string when not in weaving state', () => {
    const hint = getCtaHint({ isWeaving: false, stagedFiles: 5, unstagedFiles: 0, isClean: false, ctaReason: 'thread_not_started' });
    assert.equal(hint, '');
  });

  it('does not silently hide validation hint when staged changes exist', () => {
    const hint = getCtaHint({ isWeaving: true, stagedFiles: 1, unstagedFiles: 0, isClean: false, ctaReason: 'has_staged' });
    assert.notEqual(hint, '', 'hint must not be empty when staged changes exist');
  });
});

// ── Start Thread — host-side invariants ────────────────────────────────────────

describe('Start Thread — TyneSidebarProvider.ts invariants', () => {
  const hostSrc = readFileSync(join(__dirname, '../../src/TyneSidebarProvider.ts'), 'utf8');

  it('_handleStartThreadFromTask sets state fields before calling _startThread', () => {
    const fnStart = hostSrc.indexOf('private async _handleStartThreadFromTask(');
    assert.notEqual(fnStart, -1, '_handleStartThreadFromTask must exist');
    const fnBody = hostSrc.slice(fnStart, fnStart + 2000);
    const loadIdx = fnBody.indexOf('await this._loadTaskIntoThread(');
    const startIdx = fnBody.indexOf('await this._startThread()');
    assert.notEqual(loadIdx, -1, 'must load the task into the thread first');
    assert.notEqual(startIdx, -1, 'must call _startThread()');
    assert.ok(loadIdx < startIdx, 'task must be loaded into the thread before _startThread()');
  });

  it('_loadTaskIntoThread populates state fields (taskId, goal) and resets validation', () => {
    const fnStart = hostSrc.indexOf('private async _loadTaskIntoThread(');
    assert.notEqual(fnStart, -1, '_loadTaskIntoThread must exist');
    const fnBody = hostSrc.slice(fnStart, fnStart + 2000);
    assert.ok(fnBody.includes('this._state.taskId = taskId'), 'must set taskId on state');
    assert.ok(fnBody.includes('this._state.goal = title'), 'must set goal on state');
    assert.ok(fnBody.includes('this._clearValidationForNewTask()'), 'must clear stale validation for the new task');
  });

  it('clicking a task opens its detail + PM enrichment card (not Jira)', () => {
    // Card click opens the detail drawer, whose Jira branch fetches PM intelligence.
    const handlerStart = tyneJsSource.indexOf('TyneTaskInteractions.findTaskCard(e.target)');
    assert.notEqual(handlerStart, -1, 'card click handler must exist');
    const handlerBody = tyneJsSource.slice(handlerStart, handlerStart + 700);
    assert.ok(handlerBody.includes("type: 'openTaskDetail'"), 'card click must open the task detail/enrichment card');
    assert.ok(!handlerBody.includes("type: 'openExternal'"), 'card click must never open Jira externally');
  });

  it('opening a Jira task detail fetches PM enrichment intelligence', () => {
    const fnStart = hostSrc.indexOf('private async _handleOpenTaskDetail(');
    assert.notEqual(fnStart, -1, '_handleOpenTaskDetail must exist');
    const fnBody = hostSrc.slice(fnStart, fnStart + 1200);
    assert.ok(fnBody.includes('_fetchAndPostPmTaskIntelligence'), 'detail open must trigger PM enrichment for Jira tasks');
  });

  it('thread-page task dropdown loads the selected task into the thread', () => {
    assert.ok(
      tyneJsSource.includes("type: 'selectTaskIntoThread'"),
      'thread dropdown must post selectTaskIntoThread',
    );
    assert.ok(
      hostSrc.includes("case 'selectTaskIntoThread'"),
      'host must handle selectTaskIntoThread',
    );
  });

  it('_startThread logs the task key when started', () => {
    const fnStart = hostSrc.indexOf('private async _startThread()');
    assert.notEqual(fnStart, -1, '_startThread must exist');
    const fnEnd = hostSrc.indexOf('private async _switchToBranch(', fnStart);
    const fnBody = hostSrc.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes('Start Thread clicked'), 'must log Start Thread clicked');
    assert.ok(fnBody.includes('Branch created/switched'), 'must log branch name after creation');
    assert.ok(fnBody.includes('Active Jira task saved'), 'must log active task save');
  });

  it('_startThread calls _refreshGitStatus after branch creation', () => {
    const fnStart = hostSrc.indexOf('private async _startThread()');
    const fnEnd = hostSrc.indexOf('private async _switchToBranch(', fnStart);
    const fnBody = hostSrc.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes('await this._refreshGitStatus()'), 'must call _refreshGitStatus after branch creation');
  });

  it('_refreshGitStatus posts gitStatusLoaded message', () => {
    const fnStart = hostSrc.indexOf('private async _refreshGitStatus()');
    assert.notEqual(fnStart, -1, '_refreshGitStatus must exist');
    const fnBody = hostSrc.slice(fnStart, fnStart + 1500);
    assert.ok(fnBody.includes("type: 'gitStatusLoaded'"), 'must post gitStatusLoaded message');
    assert.ok(fnBody.includes('stagedFiles'), 'must include stagedFiles in message');
    assert.ok(fnBody.includes('unstagedFiles'), 'must include unstagedFiles in message');
    assert.ok(fnBody.includes('ctaReason'), 'must include ctaReason in message');
  });

  it('file save watcher calls _refreshGitStatus', () => {
    assert.ok(
      hostSrc.includes('onDidSaveTextDocument'),
      'must register a file-save watcher',
    );
    assert.ok(
      hostSrc.includes('void this._refreshGitStatus()'),
      'file-save watcher must call _refreshGitStatus',
    );
  });

  it('getGitStatus message type is handled', () => {
    assert.ok(
      hostSrc.includes("case 'getGitStatus'"),
      'webview getGitStatus message must be handled',
    );
  });

  it('gitStatusHint element is in the HTML template', () => {
    assert.ok(
      hostSrc.includes('gitStatusHint'),
      'HTML template must include gitStatusHint element',
    );
  });
});

// ── Branch switch ─────────────────────────────────────────────────────────────

describe('Branch switch — refreshes git status', () => {
  const hostSrc = readFileSync(join(__dirname, '../../src/TyneSidebarProvider.ts'), 'utf8');

  it('_switchToBranch calls _refreshGitStatus', () => {
    const fnStart = hostSrc.indexOf('private async _switchToBranch(');
    assert.notEqual(fnStart, -1);
    const fnEnd = hostSrc.indexOf('private async _deleteBranch(', fnStart);
    const fnBody = hostSrc.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes('await this._refreshGitStatus()'), '_switchToBranch must call _refreshGitStatus');
  });

  it('_switchToBranch sets status=weaving when switching to a tyne/ branch', () => {
    const fnStart = hostSrc.indexOf('private async _switchToBranch(');
    const fnEnd = hostSrc.indexOf('private async _deleteBranch(', fnStart);
    const fnBody = hostSrc.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes("startsWith('tyne/')"), 'must check tyne/ prefix');
    assert.ok(fnBody.includes("status = 'weaving'"), 'must set status to weaving');
  });

  it('_switchToBranch posts statusChanged when weaving', () => {
    const fnStart = hostSrc.indexOf('private async _switchToBranch(');
    const fnEnd = hostSrc.indexOf('private async _deleteBranch(', fnStart);
    const fnBody = hostSrc.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes("type: 'statusChanged'"), 'must post statusChanged message');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Lightweight jsdom harness scoped to ONE regression: clicking a Jira task card
// must select it internally (open the detail drawer) and must NOT open Jira in
// the browser; only the explicit "Open in Jira" button does that.
//
// We exercise the REAL click-routing predicates shipped to the webview
// (media/taskInteractions.js), wired exactly the way media/tyne.js wires them,
// so this fails if that logic regresses.

// jsdom and the webview module are plain JS with no bundled types; this Node-side
// harness intentionally treats DOM values as `any` (tsconfig has no "dom" lib).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TyneTaskInteractions: {
  findExternalTaskOpenTarget(el: unknown): { dataset?: Record<string, string> } | null;
  findTaskCard(el: unknown): { dataset?: Record<string, string> } | null;
} = require(join(__dirname, '../../media/taskInteractions.js'));

type PostedMessage = { type: string; taskId?: string; tool?: string; url?: string };

// Build a DOM with a Jira task card + an explicit "Open in Jira" button, then
// attach the same two document-level click listeners media/tyne.js uses. Returns
// the captured postMessage calls and DOM handles for assertions.
function mountTasksDom(cardMarkup: string) {
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <div id="taskList">${cardMarkup}</div>
    <button id="openInJiraBtn" data-task-url="https://acme.atlassian.net/browse/TYNE-2">Open in Jira</button>
  </body>`);
  const document = dom.window.document;
  const posted: PostedMessage[] = [];
  const vscode = { postMessage: (m: PostedMessage) => { posted.push(m); } };

  // ── Mirror of media/tyne.js document click handlers (uses the shared module) ──
  document.addEventListener('click', (e: { target: unknown }) => {
    const taskButton = TyneTaskInteractions.findExternalTaskOpenTarget(e.target);
    if (taskButton && taskButton.dataset?.taskUrl) {
      vscode.postMessage({ type: 'openExternal', url: taskButton.dataset.taskUrl });
    }
  });
  document.addEventListener('click', (e: { target: unknown }) => {
    const card = TyneTaskInteractions.findTaskCard(e.target);
    if (card && card.dataset?.taskId) {
      vscode.postMessage({ type: 'openTaskDetail', taskId: card.dataset.taskId, tool: card.dataset.taskTool });
    }
  });

  const click = (el: { dispatchEvent: (ev: unknown) => void } | null) => {
    el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };
  return { dom, document, posted, click };
}

// The exact card shape media/tyne.js renders today: a <div>, no external URL.
const GOOD_CARD = `<div class="task-card" data-task-id="jira:TYNE-2" data-task-tool="jira" data-task-ext-id="TYNE-2" data-task-title="Issue 2">
    <div class="task-card-main"><span class="task-card-title">Issue 2</span></div>
  </div>`;

describe('Jira task card click behavior', () => {
  it('selects the task internally when the card body is clicked', () => {
    const { document, posted, click } = mountTasksDom(GOOD_CARD);
    click(document.querySelector('.task-card-title'));
    const select = posted.find(m => m.type === 'openTaskDetail');
    assert.ok(select, 'expected an openTaskDetail (internal select) message');
    assert.equal(select?.taskId, 'jira:TYNE-2');
    assert.equal(select?.tool, 'jira');
  });

  it('does NOT open Jira externally when the card is clicked', () => {
    const { document, posted, click } = mountTasksDom(GOOD_CARD);
    click(document.querySelector('.task-card'));
    assert.equal(posted.some(m => m.type === 'openExternal'), false, 'card click must not open the browser');
  });

  it('opens Jira externally only when the explicit "Open in Jira" button is clicked', () => {
    const { document, posted, click } = mountTasksDom(GOOD_CARD);
    click(document.getElementById('openInJiraBtn'));
    const ext = posted.find(m => m.type === 'openExternal');
    assert.ok(ext, 'expected an openExternal message from the explicit button');
    assert.equal(ext?.url, 'https://acme.atlassian.net/browse/TYNE-2');
    assert.equal(posted.some(m => m.type === 'openTaskDetail'), false);
  });

  it('does not treat a <div> card as an external-open target even if it carries a URL', () => {
    // Regression guard at the predicate level: the external-open selector is
    // scoped to button/anchor, so a stray data-task-url on a div card cannot
    // turn the whole card into a browser link.
    const { document } = mountTasksDom(
      `<div class="task-card" data-task-id="jira:TYNE-9" data-task-tool="jira" data-task-url="https://acme.atlassian.net/browse/TYNE-9"></div>`,
    );
    const card = document.querySelector('.task-card');
    assert.equal(TyneTaskInteractions.findExternalTaskOpenTarget(card), null);
    assert.equal(TyneTaskInteractions.findTaskCard(card), card);
  });
});

describe('Jira task card markup invariant', () => {
  // Read the shipped renderTaskCard markup and assert the card element itself is
  // never an external Jira link. This fails if future code wraps the whole card
  // in an anchor or re-attaches data-task-url to the card element.
  const source = readFileSync(join(__dirname, '../../media/tyne.js'), 'utf8');

  function extractRenderTaskCardReturn(): string {
    const start = source.indexOf('renderTaskCard(t) {');
    assert.notEqual(start, -1, 'renderTaskCard(t) not found in media/tyne.js');
    const retIdx = source.indexOf('return `', start);
    assert.notEqual(retIdx, -1, 'renderTaskCard return template not found');
    // Capture up to the closing of the template literal for the card element.
    const end = source.indexOf('</div>`;', retIdx);
    assert.notEqual(end, -1, 'end of renderTaskCard template not found');
    return source.slice(retIdx, end);
  }

  it('renders the card as a <div>, not an anchor', () => {
    const tmpl = extractRenderTaskCardReturn();
    assert.match(tmpl, /return `<div class="task-card/);
    assert.equal(/<a\s[^>]*class="task-card/.test(tmpl), false, 'card must not be an <a> element');
  });

  it('does not attach an external task URL to the card element', () => {
    const tmpl = extractRenderTaskCardReturn();
    assert.equal(tmpl.includes('data-task-url'), false, 'card element must not carry data-task-url');
  });

  it('shows the task title first, with source as quiet meta', () => {
    const tmpl = extractRenderTaskCardReturn();
    assert.match(tmpl, /task-card-title/, 'card must show the task title');
    assert.match(tmpl, /task-card-meta/, 'source/key stay in quiet meta line');
    assert.equal(tmpl.includes('task-card-key'), false, 'issue key must not dominate the card');
  });
});

describe('Tasks page workspace UI invariant', () => {
  const sidebarSource = readFileSync(join(__dirname, '../../src/sidebar/sidebarHtml.ts'), 'utf8');
  const webviewSource = readFileSync(join(__dirname, '../../media/tyne.js'), 'utf8');

  it('renders the no-PM-tool connection prompt', () => {
    assert.match(sidebarSource, /Connect Jira or Linear to pull your tasks\./);
    assert.match(sidebarSource, /id="taskConnectCard"/);
  });

  it('renders and wires the workspace dropdown', () => {
    assert.match(sidebarSource, /id="taskWorkspaceSelect"/);
    assert.match(sidebarSource, /All connected workspaces/);
    assert.match(webviewSource, /renderWorkspaceSelector\(\)/);
    assert.match(webviewSource, /taskWorkspaceSelect/);
    assert.match(webviewSource, /workspaceOptionLabel\(tool\)/);
  });
});

// Task card click-routing predicates.
//
// Extracted as a tiny, pure, dependency-free module so the regression we fixed
// — clicking a Jira task card opening the browser instead of the in-panel detail
// drawer — is covered by an automated test (see src/tests/taskCardInteraction.test.ts).
//
// This file is shared verbatim between:
//   • the webview (loaded as a <script> before tyne.js, exposes window.TyneTaskInteractions)
//   • the test harness (required in Node via jsdom)
//
// Keep it free of DOM-library specifics and webview globals so both consumers
// can load it unchanged.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TyneTaskInteractions = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The ONLY elements allowed to open a task externally (in the browser) are
  // explicit <button>/<a> elements carrying a task URL — e.g. the "Open in Jira"
  // action. A task *card* is a <div>, so it can never match here: clicking a card
  // must never open Jira in the browser. This selector is intentionally scoped to
  // button/anchor rather than any `[data-task-url]` ancestor.
  function findExternalTaskOpenTarget(el) {
    if (!el || typeof el.closest !== 'function') { return null; }
    return el.closest('button[data-task-url], a[data-task-url]');
  }

  // A click anywhere on a task card selects the task (opens the internal detail
  // drawer). The card carries data-task-id / data-task-tool but no external URL.
  function findTaskCard(el) {
    if (!el || typeof el.closest !== 'function') { return null; }
    return el.closest('.task-card');
  }

  return {
    findExternalTaskOpenTarget: findExternalTaskOpenTarget,
    findTaskCard: findTaskCard,
  };
}));

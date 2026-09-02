import { DecomposedTask } from '../storyDecompositionHarness';

export function renderSidebarHtml(csp: string, nonce: string, logoUri: string, cssUri: string, jsUri: string, taskInteractionsUri: string, tier: { mark: string; core: string; pro: string; max: string }, logos: { slack: string; salesforce: string; jira: string; linear: string; monday: string; asana: string }, extensionVersion: string): string {
  const ICON = {
    thread: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M9 18a9 9 0 0 0 9-9"/></svg>',
    time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    commit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>',
    automation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
            logo: '<svg viewBox="0 0 24 24" fill="none"><g fill="currentColor" transform="translate(8 1)"><rect x="0" y="0" width="4" height="1"/> <rect x="0" y="1" width="4" height="1"/> <rect x="0" y="2" width="4" height="1"/> <rect x="0" y="3" width="4" height="1"/> <rect x="0" y="4" width="4" height="1"/> <rect x="0" y="5" width="4" height="1"/> <rect x="0" y="6" width="4" height="1"/> <rect x="5" y="6" width="3" height="1"/> <rect x="0" y="7" width="4" height="1"/> <rect x="5" y="7" width="3" height="1"/> <rect x="0" y="8" width="8" height="1"/> <rect x="0" y="9" width="4" height="1"/> <rect x="0" y="10" width="3" height="1"/> <rect x="0" y="11" width="4" height="1"/> <rect x="0" y="12" width="4" height="1"/> <rect x="0" y="13" width="4" height="1"/> <rect x="0" y="14" width="4" height="1"/> <rect x="0" y="15" width="4" height="1"/> <rect x="0" y="16" width="4" height="1"/> <rect x="0" y="17" width="4" height="1"/> <rect x="0" y="18" width="4" height="1"/> <rect x="1" y="19" width="7" height="1"/> <rect x="3" y="20" width="5" height="1"/> <rect x="3" y="21" width="5" height="1"/></g></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.27a11 11 0 0 0-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.63-1.28-1.63-1.05-.71.08-.69.08-.69 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.74.4-1.26.73-1.55-2.42-.28-4.96-1.21-4.96-5.38 0-1.19.42-2.16 1.12-2.92-.11-.28-.49-1.39.11-2.89 0 0 .91-.29 2.99 1.12a10.4 10.4 0 0 1 5.45 0c2.08-1.41 2.99-1.12 2.99-1.12.6 1.5.22 2.61.11 2.89.7.76 1.12 1.73 1.12 2.92 0 4.18-2.55 5.1-4.98 5.37.41.36.78 1.06.78 2.14v3.17c0 .27.18.65.74.54A11 11 0 0 0 12 1.27z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
    stitch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>',
    knot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    bug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 10v2a7 7 0 0 1-7 7"/><path d="M5 10v2a7 7 0 0 0 7 7"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="9" y1="4" x2="15" y2="4"/><line x1="4" y1="13" x2="8" y2="13"/><line x1="16" y1="13" x2="20" y2="13"/></svg>',
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tyne</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="app">

  <section id="welcomeView" class="welcome">
    <img class="welcome-logo" src="${logoUri}" alt="Tyne" />
    <div class="welcome-title">Goal-enforcement for<br/>AI-assisted coding</div>
    <div class="welcome-sub">Stay on scope. Snapshot fearlessly. Ship validated code &mdash; every session.</div>
    <div class="welcome-actions">
      <button class="btn primary" id="continueWithGithubBtn">${ICON.github}<span>Continue with GitHub</span></button>
    </div>
    <div class="welcome-pending hidden" id="welcomePending">
      <div class="lbl">Enter code at GitHub</div>
      <div class="code" id="pendingCode">----</div>
      <button class="btn" id="pendingLink" type="button">github.com/login/device</button>
    </div>
    <div class="welcome-pending hidden" id="deviceAuthPending">
      <div class="lbl" id="deviceAuthLabel">Confirm in browser</div>
      <div class="code" id="deviceAuthCode">----</div>
      <div class="welcome-device-hint" id="deviceAuthHint">Waiting for confirmation in browser…</div>
      <div class="welcome-device-actions">
        <button class="btn" id="deviceAuthOpenLink" type="button">Open browser</button>
        <button class="btn primary hidden" id="deviceAuthRetryBtn" type="button">Try again</button>
        <button class="btn ghost" id="deviceAuthCancelBtn" type="button">Cancel</button>
      </div>
    </div>
    <div class="welcome-foot">By continuing you agree to the <a href="#" id="welcomeTermsLink" data-url="https://tyne.proflowtech.io/terms">Terms</a> &amp; <a href="#" id="welcomePrivacyLink" data-url="https://tyne.proflowtech.io/privacy">Privacy Policy</a>.</div>
  </section>

  <div id="onboardingOverlay" class="onboarding-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="onboardingTitle">
    <div class="onboarding-card">
      <div class="onboarding-head">
        <div class="onboarding-title" id="onboardingTitle">Get your first review</div>
        <div class="onboarding-sub" id="onboardingSub">Four steps. Takes a few minutes.</div>
      </div>
      <ol class="onboarding-steps" id="onboardingSteps">
        <li data-step="sign" class="done">Sign in</li>
        <li data-step="path">Choose Solo or connect Jira/Linear</li>
        <li data-step="thread">Start a Thread</li>
        <li data-step="review">Run Validate &amp; Review</li>
      </ol>
      <div class="onboarding-body" id="onboardingBody"></div>
      <div class="onboarding-actions">
        <button type="button" class="btn ghost compact" id="onboardingSkipTourBtn">Skip tour</button>
        <button type="button" class="btn primary compact" id="onboardingPrimaryBtn">Continue</button>
      </div>
    </div>
  </div>

  <main id="shellView" class="shell active">
    <nav class="rail">
      <div class="rail-logo"><img src="${tier.mark}" alt="Tyne" /></div>
      <button class="rail-btn active" data-nav="tasks" title="Tasks" aria-label="Tasks">${ICON.tasks}</button>
      <button class="rail-btn" data-nav="validateReview" title="Validate &amp; Review" aria-label="Validate &amp; Review">${ICON.review}</button>
      <button class="rail-btn" data-nav="branches" title="Branches" aria-label="Branches">${ICON.branch}</button>
      <button class="rail-btn" data-nav="commits" title="Commits" aria-label="Commits">${ICON.commit}</button>
      <button class="rail-btn" data-nav="analytics" title="Analytics" aria-label="Analytics">${ICON.clock}</button>
      <button class="rail-btn" data-nav="automation" title="Automation" aria-label="Automation">${ICON.automation}</button>
      <div class="rail-spacer"></div>
      <button class="rail-btn" data-nav="settings" title="Settings" aria-label="Settings">${ICON.settings}</button>
    </nav>

    <div class="content">
      <div class="runner global" id="globalRunner"><div class="fill" id="globalRunnerFill"></div></div>
      <!-- Page-agnostic decompose wizard — visible from Thread or Tasks. -->
      <div class="story-decompose-panel story-decompose-overlay hidden" id="storyDecomposePanel"></div>
      <!-- GitHub session-expired banner (shown when the saved token is rejected) -->
      <div class="gh-expired-banner hidden" id="githubExpiredBanner" role="alert">
        <div class="gh-expired-copy" id="githubExpiredText">Your Tyne session expired. Sign in again to continue.</div>
        <button class="btn primary compact" id="githubReconnectBtn" type="button">Reconnect GitHub</button>
      </div>
      <div class="pages">


        <!-- ===== VALIDATE & REVIEW ===== -->
        <section class="page" id="validateReviewPage">

          <div class="page-head">
            <span class="page-title">Validate &amp; Review</span>
          </div>

          <div class="vr-review-controls">
            <div class="vr-review-control-row">
              <select class="vr-scope-select" id="validateReviewScopeSelect" title="Review scope">
                <option value="auto">Auto (staged &gt; unstaged &gt; last commit)</option>
                <option value="staged_changes">Staged changes</option>
                <option value="unstaged_changes">Unstaged changes</option>
                <option value="last_commit">Last commit</option>
                <option value="selected_commit">Selected commit</option>
              </select>
              <button class="btn primary" id="runValidateReviewBtn" type="button">Run Review</button>
            </div>
            <div class="runner" id="validateReviewRunner"><div class="fill" id="validateReviewRunnerFill"></div></div>
            <div id="validateReviewStatus" class="review-live-host hidden" role="status" aria-live="polite"></div>
            <div id="validateReviewError" class="notice bad hidden"></div>
          </div>

          <div class="vr-review-list-view" id="validateReviewListView">
            <div class="vr-task-report-list" id="validateReviewReportList"></div>
            <div class="val-empty" id="validateReviewHistoryEmpty">No Validate &amp; Review results yet. Run a review when you need validation.</div>
          </div>

          <div class="vr-review-doc-view hidden" id="validateReviewDocView">
            <div class="vr-doc-toolbar">
              <button class="btn ghost compact vr-back-btn" id="validateReviewBackBtn" type="button">&#8592; Back to list</button>
              <button class="btn ghost compact vr-export-pdf-btn" id="validateReviewExportPdfBtn" type="button" title="Export report as PDF">Export PDF</button>
            </div>
            <div class="vr-doc-container" id="validateReviewDocContainer"></div>
          </div>

          <div class="vr-review-trends-view" id="validateReviewTrendsContainer"></div>

        </section>

        <!-- ===== TASKS ===== -->
        <section class="page active" id="tasksPage">

          <!-- Header: one title (matches active tab) + sync when on Tasks list -->
          <div class="page-head">
            <span class="page-title" id="tasksPageTitle">Thread</span>
            <div class="task-head-right">
              <span class="sync-dot hidden" id="taskSyncDot" title=""></span>
              <button class="btn ghost compact task-sync-icon-btn hidden" id="pullTasksBtn" type="button" title="Sync tasks">↺</button>
            </div>
          </div>

          <div class="tab-bar tasks-inner-tabs" id="tasksInnerTabs" role="tablist">
            <button class="tab-btn active" type="button" data-tasks-tab="thread" role="tab" aria-selected="true">Thread</button>
            <button class="tab-btn" type="button" data-tasks-tab="list" role="tab" aria-selected="false">Tasks</button>
          </div>

          <div class="tab-panel" id="tasksListPanel">

          <!-- STATE 1: No tool connected — one-tap pill connect -->
          <div class="hidden" id="taskConnectCard">
            <div class="task-connect-prompt">Connect Jira or Linear to pull your tasks.</div>
            <div class="pm-connect-pills">
              <button class="pm-pill" data-connect-tool="linear">Linear</button>
              <button class="pm-pill" data-connect-tool="jira">Jira</button>
            </div>
          </div>

          <!-- Connected tools badges (shown when ≥1 tool connected) -->
          <div class="hidden" id="taskToolsRow">
            <div class="task-tools-badges" id="taskToolsBadges"></div>
          </div>

          <!-- Tier upgrade notice -->
          <div class="notice bad hidden" id="taskTierNotice">
            <div class="notice-copy">Free plan: one PM tool only. <strong>Upgrade to Pro or Max</strong> for all tools.</div>
          </div>

          <!-- STATE 2: Search bar + single ⚙ gear (all controls inside) -->
          <div class="task-controls hidden" id="taskControls">
            <div class="task-toolbar">
              <div class="task-search-wrap">
                <input type="text" id="taskSearchInput" placeholder="Search tasks…" autocomplete="off" />
                <!-- inline chips appear here when active -->
                <div class="task-chips-inline hidden" id="taskChipsRow">
                  <div class="task-chips" id="taskChips"></div>
                  <button class="chip-clear-all" id="clearAllChipsBtn" type="button" title="Clear filters">✕</button>
                </div>
              </div>
              <!-- Single gear: opens the unified control panel -->
              <div class="task-more-wrap task-gear-wrap">
                <button class="btn ghost task-gear-btn" id="taskGearBtn" type="button" title="Filters, sort &amp; more" aria-label="Filters, sort and more">
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.7 1.3h2.6l.2 1.3c.4.1.7.3 1 .5l1.2-.6 1.3 1.3-.6 1.2c.2.3.4.6.5 1l1.3.2v2.6l-1.3.2c-.1.4-.3.7-.5 1l.6 1.2-1.3 1.3-1.2-.6c-.3.2-.6.4-1 .5l-.2 1.3H6.7l-.2-1.3c-.4-.1-.7-.3-1-.5l-1.2.6-1.3-1.3.6-1.2c-.2-.3-.4-.6-.5-1l-1.3-.2V5.4l1.3-.2c.1-.4.3-.7.5-1l-.6-1.2L4.5 1.7l1.2.6c.3-.2.6-.4 1-.5l.2-1.3zM8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5z"/></svg>
                </button>
                <div class="task-gear-panel hidden" id="taskGearPanel">

                  <!-- Source filter -->
                  <div class="tfp-row">
                    <label class="tfp-label">Source</label>
                    <select id="taskSourceFilter" class="tfp-select">
                      <option value="">All sources</option>
                      <option value="linear">Linear</option>
                      <option value="jira">Jira</option>
                    </select>
                  </div>

                  <!-- Status filter -->
                  <div class="tfp-row">
                    <label class="tfp-label">Status</label>
                    <div class="tfp-checks" id="tfpStatuses">
                      <label><input type="checkbox" value="todo"> Todo</label>
                      <label><input type="checkbox" value="in_progress"> In Progress</label>
                      <label><input type="checkbox" value="in_review"> In Review</label>
                      <label><input type="checkbox" value="blocked"> Blocked</label>
                      <label><input type="checkbox" value="done"> Done</label>
                    </div>
                  </div>

                  <!-- Priority filter -->
                  <div class="tfp-row">
                    <label class="tfp-label">Priority</label>
                    <div class="tfp-checks" id="tfpPriorities">
                      <label><input type="checkbox" value="urgent"> Urgent</label>
                      <label><input type="checkbox" value="high"> High</label>
                      <label><input type="checkbox" value="medium"> Medium</label>
                      <label><input type="checkbox" value="low"> Low</label>
                    </div>
                  </div>

                  <!-- Due date -->
                  <div class="tfp-row">
                    <label class="tfp-label">Due date</label>
                    <select id="tfpDueDate" class="tfp-select">
                      <option value="">Any</option>
                      <option value="today">Today</option>
                      <option value="this_week">This week</option>
                      <option value="overdue">Overdue</option>
                    </select>
                  </div>

                  <!-- Updated -->
                  <div class="tfp-row">
                    <label class="tfp-label">Updated</label>
                    <select id="tfpUpdated" class="tfp-select">
                      <option value="">Any</option>
                      <option value="last_7_days">Last 7 days</option>
                      <option value="last_30_days">Last 30 days</option>
                    </select>
                  </div>

                  <!-- Has -->
                  <div class="tfp-row">
                    <label class="tfp-label">Has</label>
                    <div class="tfp-checks">
                      <label><input type="checkbox" id="tfpHasBranch"> Branch</label>
                      <label><input type="checkbox" id="tfpHasCommits"> Commits</label>
                      <label><input type="checkbox" id="tfpHasTime"> Time tracked</label>
                    </div>
                  </div>

                  <!-- Sort -->
                  <div class="tfp-row">
                    <label class="tfp-label">Sort by</label>
                    <select id="taskSortSelect" class="tfp-select">
                      <option value="recommended:desc">Recommended</option>
                      <option value="updatedAt:desc">Updated ↓</option>
                      <option value="updatedAt:asc">Updated ↑</option>
                      <option value="createdAt:desc">Created ↓</option>
                      <option value="dueDate:asc">Due ↑</option>
                      <option value="priority:asc">Priority</option>
                      <option value="title:asc">Title A–Z</option>
                      <option value="status:asc">Status</option>
                      <option value="sourceTool:asc">Source</option>
                    </select>
                  </div>

                  <!-- Filter apply/clear -->
                  <div class="tfp-actions">
                    <button class="btn ghost compact" id="tfpClearBtn" type="button">Clear</button>
                    <button class="btn primary compact" id="tfpApplyBtn" type="button">Apply</button>
                  </div>

                  <!-- Divider -->
                  <div class="gear-panel-sep"></div>

                  <!-- Presets (Pro/Max) -->
                  <div class="tfp-row">
                    <label class="tfp-label">Presets</label>
                    <div class="tfp-upgrade hidden" id="tfpUpgradeNotice">Requires Pro or Max.</div>
                    <div id="presetMenuItems"></div>
                    <button class="gear-text-btn hidden" id="savePresetBtn" type="button">+ Save current as preset</button>
                  </div>

                  <!-- Connect / add tool -->
                  <div class="gear-panel-sep"></div>
                  <div class="tfp-row">
                    <label class="tfp-label">PM Tools</label>
                    <div class="pm-connect-pills pm-connect-pills-sm" id="gearPmPills">
                      <button class="pm-pill-sm" data-connect-tool="linear">Linear</button>
                      <button class="pm-pill-sm" data-connect-tool="jira">Jira</button>
                    </div>
                  </div>

                  <!-- New Task (Pro/Max) -->
                  <div class="gear-panel-sep hidden" id="newTaskSep"></div>
                  <button class="gear-text-btn hidden" id="newTaskBtn" type="button">+ New Task</button>

                </div>
              </div>
            </div>

            <!-- Query parse error bar -->
            <div class="notice bad hidden" id="queryErrorBar">
              <span id="queryErrorText"></span>
            </div>
          </div>

          <!-- Task list -->
          <div id="taskListContainer">
            <div class="task-workspace-row hidden" id="taskWorkspaceRow">
              <select id="taskWorkspaceSelect" class="task-workspace-select" title="Task workspace">
                <option value="">All connected workspaces</option>
              </select>
            </div>
            <div class="task-scope-label hidden" id="taskScopeLabel" title="Tasks currently assigned to you in the connected PM tool">Assigned to me</div>
            <div class="empty" id="taskListEmpty" style="display:none">No tasks match your filters.</div>
            <div id="taskList"></div>
          </div>

          <!-- ── Task detail drawer ── -->
          <div class="task-detail-drawer hidden" id="taskDetailDrawer">

            <!-- Conflict banner (only appears on detected conflict) -->
            <div class="notice warn hidden" id="taskConflictBanner">
              <div class="notice-copy" id="taskConflictMsg">This task changed externally. Reload before saving?</div>
              <div class="btn-row">
                <button class="btn primary compact" id="conflictReloadBtn" type="button">Reload</button>
                <button class="btn ghost compact" id="conflictKeepBtn" type="button">Keep editing</button>
                <button class="btn ghost compact" id="conflictCancelBtn" type="button">Cancel</button>
              </div>
            </div>

            <!-- Header row -->
            <div class="task-detail-head">
              <span class="task-detail-title" id="taskDetailTitle">—</span>
              <button class="btn ghost compact" id="taskDetailCloseBtn" type="button">✕</button>
            </div>

            <!-- Single meta line: status · priority · source -->
            <div class="task-detail-meta" id="taskDetailMeta"></div>

            <!-- PRIMARY ACTION — full width. Label switches to
                 "✨ Create Tasks from Story" for Story/Epic issue types. -->
            <button class="btn primary task-detail-primary-btn" id="taskDetailStartThreadBtn" type="button">Start thread</button>

            <div class="task-detail-secondary-row">
              <button class="btn ghost compact" id="taskDetailValidateBtn" type="button">Validate &amp; Review</button>
              <button class="btn ghost compact" id="taskDetailGenerateCommitBtn" type="button">Generate Commit</button>
            </div>

            <!-- Secondary actions row — always visible, no menu -->
            <div class="task-detail-secondary-row">
              <button class="btn ghost compact" id="tdEditBtn" type="button">Edit</button>
              <button class="btn ghost compact" id="tdRefreshBtn" type="button">↺</button>
              <button class="btn ghost compact" id="tdCopyIdBtn" type="button">Copy ID</button>
              <button class="btn ghost compact" id="tdCopyLinkBtn" type="button">Copy Link</button>
              <button class="btn ghost compact" id="tdOpenPmBtn" type="button">Open ↗</button>
            </div>

            <!-- Inline edit form (Pro/Max, hidden by default) -->
            <div class="task-edit-drawer hidden" id="taskEditDrawer">
              <div class="label">Edit Task</div>
              <div class="field"><label>Title</label><input type="text" id="editTaskTitle" autocomplete="off" /></div>
              <div class="field"><label>Status</label>
                <select id="editTaskStatus">
                  <option value="todo">Todo</option>
                  <option value="in_progress">In Progress</option>
                  <option value="in_review">In Review</option>
                  <option value="done">Done</option>
                  <option value="blocked">Blocked</option>
                  <option value="canceled">Canceled</option>
                </select>
              </div>
              <div class="field"><label>Priority</label>
                <select id="editTaskPriority">
                  <option value="urgent">Urgent</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div class="field"><label>Due date</label><input type="date" id="editTaskDueDate" /></div>
              <div class="field"><label>Description</label><textarea id="editTaskDescription" rows="3" placeholder="Description…"></textarea></div>
              <div class="notice bad hidden" id="editTaskError"></div>
              <div class="btn-row">
                <button class="btn primary" id="editTaskSaveBtn" type="button">Save</button>
                <button class="btn ghost compact" id="editTaskCancelBtn" type="button">Cancel</button>
              </div>
              <div class="notice bad hidden" id="editUpgradeNotice">Editing tasks requires Pro or Max.</div>
            </div>

            <!-- PM Intelligence section -->
            <div class="task-detail-section" id="pmIntelligenceSection">
              <div class="pm-intelligence-header">
                <div class="label">PM Intelligence</div>
                <button class="btn ghost compact" id="refreshPmIntelligenceBtn" type="button">Refresh Intelligence</button>
              </div>
              <div id="pmIntelligenceLoading" class="pm-intelligence-loading hidden" aria-live="polite">
                <div class="pm-think-row">
                  <div class="pm-think-dots" aria-hidden="true"><span></span><span></span><span></span></div>
                  <div class="pm-think-copy">
                    <strong class="pm-think-title">Tyne is reading this task</strong>
                    <span class="pm-think-step">Pulling issue context</span>
                  </div>
                </div>
              </div>
              <div id="pmIntelligenceError" class="notice bad hidden"></div>

              <div class="pm-intelligence-block" id="pmGoalSection">
                <div class="pm-intelligence-label">Goal</div>
                <div id="pmGoalText" class="pm-intelligence-content"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmSubtasksSection">
                <div class="pm-intelligence-label">Subtasks</div>
                <div id="pmSubtasksList" class="pm-intelligence-list"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmAcceptanceCriteriaSection">
                <div class="pm-intelligence-label">Acceptance Criteria</div>
                <div id="pmAcceptanceCriteriaList" class="pm-intelligence-list"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmProofPointsSection">
                <div class="pm-intelligence-label">Proof Points</div>
                <div id="pmProofPointsList" class="pm-intelligence-list"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmValidationStepsSection">
                <div class="pm-intelligence-label">Validation Steps</div>
                <div id="pmValidationStepsList" class="pm-intelligence-list"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmValidationResultSection">
                <div class="pm-intelligence-label">Validation Result</div>
                <div id="pmValidationResultText" class="pm-intelligence-content"></div>
              </div>
            </div>

            <!-- ▸ Details collapse toggle -->
            <button class="task-details-toggle" id="taskDetailsToggle" type="button">▸ Details</button>
            <div class="task-details-body hidden" id="taskDetailsBody">

              <div class="task-detail-desc-wrap">
                <div class="task-detail-desc" id="taskDetailDesc"></div>
                <button class="btn ghost compact hidden" id="taskDetailDescToggle" type="button">Show more</button>
              </div>

              <div class="task-detail-section hidden" id="taskDetailSubtasksSection">
                <div class="label" style="margin-top:10px">Jira Subtasks</div>
                <div id="taskDetailSubtasks"></div>
                <div class="add-row hidden" id="addSubtaskRow">
                  <input type="text" id="newSubtaskInput" placeholder="Add subtask…" autocomplete="off" />
                  <button class="icon-btn" id="addSubtaskSubmitBtn" type="button" title="Add subtask">${ICON.plus}</button>
                </div>
              </div>

              <div class="task-detail-section hidden" id="taskDetailCommentsSection">
                <div class="label" style="margin-top:10px">Comments</div>
                <div id="taskDetailComments"></div>
                <button class="btn ghost compact hidden" id="taskDetailMoreCommentsBtn" type="button">Show more</button>
                <div class="add-row hidden" id="addCommentRow">
                  <input type="text" id="newCommentInput" placeholder="Add comment…" autocomplete="off" />
                  <button class="icon-btn" id="addCommentSubmitBtn" type="button" title="Post">${ICON.plus}</button>
                </div>
              </div>

              <div class="task-detail-section hidden" id="taskDetailHistorySection">
                <div class="label" style="margin-top:10px">History (last 30 days)</div>
                <div id="taskDetailHistory"></div>
              </div>

            </div>
          </div>

          <!-- Inline create task drawer (Pro/Max) -->
          <div class="task-create-drawer hidden" id="taskCreateDrawer">
            <div class="task-detail-head">
              <span class="task-detail-title">New Task</span>
              <button class="btn ghost compact" id="createDrawerCloseBtn" type="button">✕</button>
            </div>
            <div class="field"><label>PM Tool</label>
              <select id="createTaskTool">
                <option value="linear">Linear</option>
                <option value="jira">Jira</option>
              </select>
            </div>
            <div class="field"><label>Title <span class="req">*</span></label><input type="text" id="createTaskTitle" placeholder="Task title…" autocomplete="off" /></div>
            <div class="field"><label>Description</label><textarea id="createTaskDesc" rows="3" placeholder="Description (optional)…"></textarea></div>
            <div class="field"><label>Status</label>
              <select id="createTaskStatus">
                <option value="todo">Todo</option>
                <option value="in_progress">In Progress</option>
              </select>
            </div>
            <div class="field"><label>Priority</label>
              <select id="createTaskPriority">
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
                <option value="low">Low</option>
                <option value="none">None</option>
              </select>
            </div>
            <div class="field"><label>Due date</label><input type="date" id="createTaskDueDate" /></div>
            <div class="notice bad hidden" id="createTaskError"></div>
            <div class="btn-row">
              <button class="btn primary" id="createTaskSubmitBtn" type="button">Create Task</button>
              <button class="btn ghost compact" id="createTaskCancelBtn" type="button">Cancel</button>
            </div>
            <div class="notice bad hidden" id="createUpgradeNotice">Creating tasks requires Pro or Max.</div>
          </div>

          <!-- Save preset drawer -->
          <div class="task-create-drawer hidden" id="savePresetDrawer">
            <div class="task-detail-head">
              <span class="task-detail-title">Save Filter Preset</span>
              <button class="btn ghost compact" id="savePresetDrawerCloseBtn" type="button">✕</button>
            </div>
            <div class="field"><label>Name <span class="req">*</span></label><input type="text" id="presetNameInput" placeholder="e.g. My Active Tasks" autocomplete="off" /></div>
            <div class="field"><label><input type="checkbox" id="presetIsDefault" /> Set as default</label></div>
            <div class="btn-row">
              <button class="btn primary" id="presetSaveSubmitBtn" type="button">Save</button>
              <button class="btn ghost compact" id="presetSaveCancelBtn" type="button">Cancel</button>
            </div>
          </div>

          </div>

          <!-- ===== THREAD (tab inside Tasks) ===== -->
          <div class="tab-panel active" id="threadPage">

          <!-- Inline alert banners (drift, prep) -->
          <div id="thread-alerts">
            <div class="thread-alert-banner hidden" id="prepPanel">
              <div class="tab-alert-icon">&#9432;</div>
              <div class="tab-alert-body">
                <div class="tab-alert-title">Workspace prep</div>
                <div id="prepLines" class="tab-alert-sub">Preparing workspace&hellip;</div>
              </div>
            </div>
            <div class="thread-alert-banner warn hidden" id="driftPanel">
              <div class="tab-alert-icon">&#9888;</div>
              <div class="tab-alert-body">
                <div class="tab-alert-title">Drift detected — <span id="driftFile"></span></div>
                <div id="driftNote" class="tab-alert-sub"></div>
                <div class="tab-alert-actions">
                  <button class="thr-link-btn" data-drift-action="park">Park idea</button>
                  <button class="thr-link-btn" data-drift-action="new_ticket">New ticket</button>
                  <button class="thr-link-btn muted" data-drift-action="dismiss">Ignore</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Thread brief form (pre-weave) -->
          <div id="briefSection">
            <div class="label-row">
              <div class="label">Start a thread</div>
              <button class="link-action" id="addTaskBtn" type="button" data-flow-action="addTask" title="Create a task from this brief">${ICON.plus}<span>Add task</span></button>
            </div>
            <div class="thread-form-hint">Anchor this session to one task and its goal. Tyne branches, tracks, and validates against it.</div>
            <div class="field">
              <label for="appName">Project / app</label>
              <input type="text" id="appName" placeholder="My App" autocomplete="off" />
            </div>
            <!-- Ranked suggestion: same order as the Tasks list "Start here" band -->
            <div class="thread-suggest hidden" id="threadSuggest">
              <div class="thread-suggest-head">
                <span class="thread-suggest-title">Start here</span>
                <button class="thr-link-btn muted" id="threadSuggestAllBtn" type="button">See all tasks</button>
              </div>
              <div id="threadSuggestBody"></div>
            </div>
            <div class="field" id="threadTaskPickerField">
              <label for="threadTaskPicker">Pick a task</label>
              <select id="threadTaskPicker">
                <option value="">— Select an assigned task —</option>
              </select>
            </div>
            <div class="field">
              <label for="taskId">Task ID</label>
              <input type="text" id="taskId" placeholder="PRO-102" autocomplete="off" />
            </div>
            <div class="field">
              <label for="goal">Goal</label>
              <input type="text" id="goal" placeholder="What must be true when this is done?" autocomplete="off" />
            </div>
          </div>

          <!-- Custom task creation (visible in both pre-weave and weaving states) -->
          <div class="field hidden" id="customTaskField">
            <label for="customTaskTitle">Custom task title</label>
            <div class="add-row">
              <input type="text" id="customTaskTitle" placeholder="Enter a task title…" autocomplete="off" />
              <button class="btn primary compact" id="customTaskCreateBtn" type="button">Create</button>
            </div>
          </div>

          <!-- Active thread hero -->
          <div id="briefSummary" class="thread-hero hidden">
            <div class="thread-hero-top">
              <div class="thread-id-chip" id="bsEyebrow"></div>
              <span class="pill standby thread-status-inline" id="threadStatusPill"><span id="threadStatusText">Standby</span></span>
            </div>
            <div class="thread-hero-head">
              <div class="thread-hero-title" id="bsGoal"></div>
              <div class="thread-hero-switch hidden" id="weavingTaskPickerField">
                <select id="weavingTaskPicker" aria-label="Switch task">
                  <option value="">Switch task…</option>
                </select>
              </div>
            </div>
            <div class="thread-hero-goal hidden" id="bsGoalSub"></div>
            <div class="thread-meta-card">
              <div class="thread-fact">
                <span class="thread-fact-k">Branch</span>
                <span class="thread-fact-v" id="bsBranch" title=""></span>
              </div>
              <div class="thread-fact">
                <span class="thread-fact-k">Time</span>
                <span class="thread-fact-v" id="mTime">0m</span>
              </div>
              <div class="thread-fact">
                <span class="thread-fact-k">Tree</span>
                <span class="thread-fact-v thread-tree-v" id="mTree"><span class="thread-tree-dot"></span><span id="gitStatusMsg">Working tree clean</span></span>
              </div>
              <div class="thread-fact hidden" id="mStitchWrap">
                <span class="thread-fact-k">Stitches</span>
                <span class="thread-fact-v"><span id="mStitch">0</span></span>
              </div>
              <button type="button" class="thread-stage-action hidden" id="gitStageBtn">Stage</button>
            </div>
            <span id="bsTask" class="visually-hidden" aria-hidden="true"></span>
            <span id="mTask" class="visually-hidden" aria-hidden="true">—</span>
          </div>

          <!-- Staging action bar (legacy hook; tree lives in meta card) -->
          <div id="gitStatusHint" class="thread-stage-bar hidden" aria-hidden="true"></div>

          <!-- Deep review lock notice -->
          <div class="notice bad hidden" id="deepReviewLock">
            <div class="notice-title">Core validations used up</div>
            <div class="notice-copy">You reached your 5 Core validations for this month. Upgrade to Pro (50/month) or Max (unlimited) to keep reviewing.</div>
            <div class="btn-row"><button class="btn primary" id="upgradeToMaxBtn" type="button">Upgrade plan</button></div>
          </div>

          <div class="thread-connect-banner hidden" id="threadGithubBanner" role="note">
            <span class="thread-connect-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </span>
            <div class="thread-connect-copy">
              Connect GitHub for full PM task intelligence.
              <button type="button" class="thread-connect-link" id="threadGithubConnectBtn">Connect →</button>
            </div>
          </div>

          <!-- Proof points + live review result (merged) -->
          <div id="proofSection">
            <div class="notice bad hidden" id="threadEnrichmentNotice"></div>
            <button class="section-toggle proof-toggle" data-target="proofBody" type="button">
              <span class="toggle-arrow">&#9658;</span> <span id="proofSectionTitle">Proof points</span>
              <span class="toggle-count" id="proofToggleCount"></span>
            </button>
            <div class="section-body" id="proofBody">
              <div class="val-counter-bar thread-val-quota hidden" id="valCounterBar" aria-label="Validation usage">
                <div class="val-counter-row">
                  <span class="val-counter" id="valCounter">Validations: loading…</span>
                  <span class="val-provider" id="valProviderBadge"></span>
                </div>
              </div>
              <div class="thread-metric-list hidden" id="threadReviewMetrics"></div>
              <div class="proof-result-slot hidden" id="proofResultSlot" aria-live="polite"></div>
              <div id="proofTemplateList"></div>
              <div id="subtaskList"></div>
              <div class="add-row" id="proofAddRow">
                <input type="text" id="newSubtask" placeholder="Add a proof point&hellip;" autocomplete="off" />
                <button class="icon-btn" id="addSubtaskBtn" title="Add" aria-label="Add proof point">${ICON.plus}</button>
              </div>
              <div class="proof-result-actions hidden" id="proofResultActions"></div>
            </div>
          </div>

          <!-- Primary action + overflow for rare actions (Override, etc.) -->
          <div class="thread-cta-row">
            <button class="btn primary thread-primary-btn" id="flowPrimaryBtn" type="button" data-flow-action="selectTask">Select task</button>
            <div class="thread-more-wrap hidden" id="flowMoreWrap">
              <button class="icon-btn thread-more-btn" id="flowMoreBtn" type="button" title="More" aria-label="More actions" aria-haspopup="true" aria-expanded="false">${ICON.more}</button>
              <div class="thread-more-menu hidden" id="flowMoreMenu" role="menu">
                <button class="thread-more-item" id="flowSecondaryBtn" type="button" role="menuitem" data-flow-action="openAi">AI setup</button>
              </div>
            </div>
          </div>

          <!-- Thin progress runner -->
          <div class="runner" id="flowRunner"><div class="fill" id="flowRunnerFill"></div></div>

          <!-- PR panel (shown after ship) -->
          <div class="notice good hidden" id="prPanel">
            <div class="notice-title">Thread complete</div>
            <div class="notice-copy" id="prSummary">Draft PR created</div>
            <div class="btn-row"><button class="btn" id="prLink" type="button">View on GitHub</button></div>
          </div>

          <!-- Collapsible sections -->
          <div class="thread-collapses">

            <!-- Latest review (legacy shell kept for IDs; UI lives in proofSection) -->
            <div class="hidden" id="validationWrap" aria-hidden="true">
              <div class="section-body hidden" id="validationBody">
                <div class="val-stages-panel hidden" id="valStagesPanel" aria-hidden="true">
                  <div class="val-stages-title visually-hidden">Validation</div>
                  <div class="val-stages-list" id="valStagesList"></div>
                </div>
                <div class="val-meta-row hidden" id="valMetaRow">
                  <span class="val-counter-legacy" id="valCounterLegacy"></span>
                  <span class="val-provider" id="valProviderBadgeLegacy"></span>
                </div>
                <div class="card thread-val-legacy hidden" id="validationPanel">
                  <div class="val-empty" id="valEmpty">No reports yet. Run Validate &amp; Review after coding.</div>
                  <div class="val-result hidden" id="valResult">
                    <div class="val-header">
                      <span class="val-badge" id="valBadge"></span>
                      <span class="val-match" id="valMatch"></span>
                      <span class="val-risk" id="valRisk"></span>
                    </div>
                    <div class="val-summary" id="valSummary"></div>
                    <div class="val-enhanced hidden" id="valEnhanced">
                      <div class="val-section hidden" id="valDetailedSection"><div class="val-label">Detailed explanation</div><div class="val-text" id="valDetailed"></div></div>
                      <div class="val-section hidden" id="valMissingSection"><div class="val-label">Missing requirements</div><ul id="valMissing"></ul></div>
                      <div class="val-section hidden" id="valSuggestionsSection"><div class="val-label">Suggestions</div><ul id="valSuggestions"></ul></div>
                      <div class="val-section hidden" id="valQualitySection"><div class="val-label">Code quality notes</div><ul id="valQuality"></ul></div>
                      <div class="val-section hidden" id="valFilesSection"><div class="val-label">Files reviewed</div><ul id="valFiles"></ul></div>
                    </div>
                    <div class="val-meta" id="valMeta"></div>
                    <div class="btn-row" id="valActions">
                      <button class="btn primary" id="btnRevalidate" type="button">Run Review</button>
                      <button class="btn hidden" id="btnOverride" type="button">Override</button>
                      <button class="btn ghost compact" id="btnCopyValSummary" type="button">Copy</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Past reviews (sibling section) -->
            <div class="hidden" id="pastReviewsWrap">
              <button class="section-toggle" data-target="pastReviewsBody" type="button">
                <span class="toggle-arrow">&#9658;</span> Past reviews
                <span class="toggle-count" id="pastReviewsCount"></span>
              </button>
              <div class="section-body hidden" id="pastReviewsBody">
                <div class="val-history-controls hidden" id="valHistoryControls">
                  <input type="text" class="val-search" id="valHistorySearch" placeholder="Search…" />
                  <select class="val-filter" id="valHistoryFilter" title="Filter">
                    <option value="">All</option>
                    <option value="today">Today</option>
                    <option value="this_week">This week</option>
                    <option value="this_month">This month</option>
                    <option value="pass">PASS</option>
                    <option value="partial">PARTIAL</option>
                    <option value="fail">FAIL</option>
                  </select>
                  <select class="val-sort" id="valHistorySort" title="Sort">
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                  </select>
                  <div class="val-more-menu-wrap">
                    <button class="btn ghost compact" id="valHistoryMoreBtn" type="button">Export</button>
                    <div class="val-more-menu hidden" id="valHistoryMoreMenu">
                      <button class="val-more-item" data-export="csv" type="button">Export CSV</button>
                      <button class="val-more-item" data-export="json" type="button">Export JSON</button>
                    </div>
                  </div>
                </div>
                <div class="val-trends hidden" id="valTrends"></div>
                <div class="val-history" id="valHistory"><div class="empty" id="valHistoryEmpty">No past reviews yet.</div></div>
                <button type="button" class="thread-view-all hidden" id="valHistoryViewAll">View all reviews</button>
              </div>
            </div>

            <!-- AI Usage -->
            <div class="hidden" id="usageWrap">
              <button class="section-toggle" data-target="usageBody">
                <span class="toggle-arrow">&#9658;</span> Usage
                <span class="toggle-count" data-target="usageBody"></span>
              </button>
              <div class="section-body hidden" id="usageBody">
                <div class="thread-kv" id="usageKv">
                  <div class="thread-kv-row"><span id="usageLabel">AI usage</span><span id="usageText">0 / 50</span></div>
                </div>
                <div class="usage-track"><div class="usage-fill" id="usageFill"></div></div>
              </div>
            </div>

            <!-- Parked ideas -->
            <div class="hidden" id="parkedPanel">
              <button class="section-toggle" data-target="parkedBody" id="parkedTitle">
                <span class="toggle-arrow">&#9658;</span> Parked ideas
                <span class="toggle-count" data-target="parkedBody"></span>
              </button>
              <div class="section-body hidden" id="parkedBody">
                <div id="parkedList"></div>
                <div class="btn-row" style="margin-top:6px"><button class="btn compact" id="clearParkedBtn" type="button">Clear all</button></div>
              </div>
            </div>

            <!-- Commits -->
            <div id="commitActivitySection">
              <button class="section-toggle" data-target="commitActivityBody">
                <span class="toggle-arrow">&#9658;</span> Commits
                <span class="toggle-count" data-target="commitActivityBody" id="commitActivityCount"></span>
              </button>
              <div class="section-body hidden" id="commitActivityBody">
                <div id="taskCommitSummaryCard" class="card thread-commit-summary-card">
                  <div class="empty">No linked commit history yet.</div>
                </div>
                <div id="taskCommitList" class="thread-commit-list"></div>
              </div>
            </div>

          </div>

          </div>

        </section>

        <!-- ===== BRANCHES ===== -->
        <section class="page" id="branchesPage">
          <div class="page-head">
            <span class="page-title">Branches</span>
            <button class="icon-btn" id="refreshBranchesBtn" type="button" title="Refresh branches">↺</button>
          </div>
          <div id="currentBranchCard" class="card branch-current-card">
            <div class="empty">No linked Tyne branch is active.</div>
          </div>

          <button class="section-toggle" data-target="branchHistoryBody" type="button">
            <span class="toggle-arrow">▸</span> Branch History
            <span class="toggle-count" data-target="branchHistoryBody">0</span>
          </button>
          <div class="section-body hidden" id="branchHistoryBody">
            <div id="branchHistoryList"></div>
          </div>
        </section>

        <!-- ===== COMMITS ===== -->
        <section class="page" id="commitsPage">
          <div class="page-head">
            <span class="page-title">Commits</span>
            <button class="icon-btn" id="refreshCommitsBtn" type="button" title="Refresh commits">↺</button>
          </div>
          <div class="time-hero hidden" aria-hidden="true">
            <div class="big" id="commitOverviewValue">0</div>
            <div class="cap" id="commitOverviewLabel">Commits on this branch</div>
          </div>
          <div class="metrics metrics-card">
            <div class="metric"><div class="k">Sessions</div><div class="v" id="commitSessionCount">0</div></div>
            <div class="metric"><div class="k">Duration</div><div class="v" id="commitDurationTotal">0m</div></div>
            <div class="metric"><div class="k">Last active</div><div class="v" id="commitLastActivity">—</div></div>
          </div>

          <div class="cv-panel" id="velocityPanel">
            <div class="cv-toolbar">
              <div class="cv-seg" id="velocityToggle" role="tablist" aria-label="Velocity metric">
                <button type="button" data-vmetric="commits" class="active" role="tab" aria-selected="true">Commits</button>
                <button type="button" data-vmetric="lines" role="tab" aria-selected="false">Lines</button>
              </div>
              <div class="cv-seg" id="velocityRange" role="tablist" aria-label="Velocity range">
                <button type="button" data-vrange="all">All</button>
                <button type="button" data-vrange="30">30d</button>
                <button type="button" data-vrange="14" class="active">14d</button>
                <button type="button" data-vrange="7">7d</button>
              </div>
            </div>
            <div class="cv-metrics" id="velocityMetrics"></div>
            <div class="cv-heat-wrap">
              <div class="cv-heat" id="velocityHeat" aria-label="Commit activity heatmap"></div>
            </div>
            <div class="cv-foot" id="velocityFoot">Commit velocity appears as you stitch on this branch.</div>
          </div>

          <button class="section-toggle" data-target="sessionBody" type="button">
            <span class="toggle-arrow">▸</span> Sessions
            <span class="toggle-count" data-target="sessionBody">0</span>
          </button>
          <div class="section-body hidden" id="sessionBody">
            <div id="sessionList"><div class="empty">No commit sessions found for this Tyne branch yet.</div></div>
          </div>

          <button class="section-toggle" data-target="commitBody" type="button">
            <span class="toggle-arrow">▸</span> All Commits
            <span class="toggle-count" data-target="commitBody">0</span>
          </button>
          <div class="section-body hidden" id="commitBody">
            <div id="commitList"><div class="empty">No commits found.</div></div>
          </div>
        </section>

        <!-- ===== ANALYTICS ===== -->
        <section class="page" id="analyticsPage">
          <div class="page-head">
            <span class="page-title">Analytics</span>
            <div class="time-header-actions">
              <button class="icon-btn" id="addManualTimeHeaderBtn" type="button" title="Add manual time">+</button>
              <button class="icon-btn" id="refreshTimeBtn" type="button" title="Refresh analytics">↺</button>
            </div>
          </div>

          <div class="analytics-task-pick">
            <label class="analytics-pick-label" for="analyticsTaskSelect">Task</label>
            <select id="analyticsTaskSelect" aria-label="Select task for analytics">
              <option value="">No tasks with time yet</option>
            </select>
          </div>

          <div class="analytics-hero" id="analyticsHero">
            <div class="analytics-greet" id="analyticsGreet">Developer Time Breakdown</div>
            <div class="analytics-sub" id="analyticsSub">Select a task to see detailed work time.</div>
          </div>

          <div class="analytics-bento" id="analyticsBento">
            <div class="analytics-card analytics-card-score" id="analyticsScoreCard">
              <div class="analytics-card-label">Productivity</div>
              <div class="analytics-ring-wrap">
                <svg class="analytics-ring" viewBox="0 0 72 72" aria-hidden="true">
                  <circle class="analytics-ring-bg" cx="36" cy="36" r="30" />
                  <circle class="analytics-ring-fg" id="analyticsRingFg" cx="36" cy="36" r="30" />
                </svg>
                <div class="analytics-ring-value" id="analyticsScoreValue">—</div>
              </div>
              <div class="analytics-card-foot" id="analyticsScoreFoot">Score / 100</div>
            </div>
            <div class="analytics-card analytics-card-time" id="analyticsTimeCard">
              <div class="analytics-card-label">Time on task</div>
              <div class="analytics-big" id="analyticsTotalTime">0m</div>
              <div class="analytics-bars" id="analyticsTimeBars"></div>
            </div>
            <div class="analytics-card analytics-card-code" id="analyticsCodeCard">
              <div class="analytics-card-label">Code</div>
              <div class="analytics-metric-grid" id="analyticsCodeMetrics"></div>
            </div>
            <div class="analytics-card analytics-card-ai" id="analyticsAiCard">
              <div class="analytics-card-label">AI used</div>
              <div id="analyticsAiBody"><div class="empty">No Tyne AI usage yet.</div></div>
            </div>
          </div>

          <div class="analytics-insights card" id="analyticsInsights">
            <div class="empty">Insights appear after you track time.</div>
          </div>

          <div class="analytics-detail card" id="analyticsDetailCard">
            <div class="analytics-detail-head">
              <div class="analytics-detail-title">Timeline</div>
              <div class="analytics-detail-total" id="analyticsDetailTotal">TOTAL: 0m</div>
            </div>
            <div class="analytics-timeline" id="analyticsTimeline">
              <div class="empty">No sessions yet for this task.</div>
            </div>
            <div class="analytics-detail-foot" id="analyticsDetailFoot"></div>
          </div>

          <div class="card" id="taskTimeSummaryCard" style="display:none" aria-hidden="true"></div>

          <button class="section-toggle" data-target="timeSessionBody" type="button">
            <span class="toggle-arrow">▸</span> Sessions
            <span class="toggle-count" data-target="timeSessionBody">0</span>
          </button>
          <div class="section-body hidden" id="timeSessionBody">
            <div id="timeSessionList"><div class="empty">No commit sessions found for this branch yet.</div></div>
          </div>

          <button class="section-toggle" data-target="manualTimeBody" type="button">
            <span class="toggle-arrow">▸</span> Manual Entries
            <span class="toggle-count" data-target="manualTimeBody">0</span>
          </button>
          <div class="section-body hidden" id="manualTimeBody">
            <div id="manualTimeList"><div class="empty">No manual time entries yet.</div></div>
            <div class="card hidden" id="manualTimeFormCard">
              <div class="label" style="margin-top:0">New Manual Entry</div>
              <div class="field"><label for="mtDate">Date</label><input type="date" id="mtDate" /></div>
              <div class="field"><label for="mtDuration">Duration (minutes)</label><input type="number" id="mtDuration" min="1" placeholder="e.g. 45" /></div>
              <div class="field"><label for="mtStartTime">Start time (optional)</label><input type="time" id="mtStartTime" /></div>
              <div class="field"><label for="mtEndTime">End time (optional)</label><input type="time" id="mtEndTime" /></div>
              <div class="field"><label for="mtNote">Note (optional)</label><input type="text" id="mtNote" placeholder="Coding, debugging, testing, review&hellip;" /></div>
              <div class="notice bad hidden" id="manualTimeError"><div class="notice-copy" id="manualTimeErrorText"></div></div>
              <div class="btn-row">
                <button class="btn primary" id="saveManualTimeBtn" type="button">Save</button>
                <button class="btn" id="cancelManualTimeBtn" type="button">Cancel</button>
              </div>
            </div>
          </div>

        </section>

        <!-- ===== AUTOMATION ===== -->
        <section class="page" id="automationPage">
          <div class="page-head">
            <span class="page-title">Automation</span>
            <button class="btn ghost compact" id="refreshAutomationBtn" type="button">Refresh</button>
          </div>

          <div class="label">Task Status</div>
          <div class="card" id="automationStatusCard">
            <div class="empty">No active task. Start a thread to use automation.</div>
          </div>

          <div class="notice bad hidden" id="automationConflictCard">
            <div class="notice-title">Status Mismatch</div>
            <div class="notice-copy" id="automationConflictText">Task status changed in PM tool. Refresh Tyne task state?</div>
            <div class="btn-row"><button class="btn" id="automationResolveConflictBtn" type="button">Refresh Status</button></div>
          </div>

          <div class="label">Actions</div>
          <div class="btn-stack" id="automationActionBtns">
            <button class="btn" id="automationRefreshStatusBtn" type="button">Refresh Status</button>
            <button class="btn" id="automationPreviewFeedbackBtn" type="button">Preview Feedback</button>
            <button class="btn" id="automationPostFeedbackBtn" type="button">Post Feedback</button>
            <button class="btn" id="automationMarkDoneBtn" type="button">Mark Task Done</button>
            <button class="btn primary" id="automationCompleteBtn" type="button">Complete Task &amp; Post Feedback</button>
          </div>

          <div class="card hidden" id="automationFeedbackPreviewCard">
            <label class="label" for="automationFeedbackPreviewText" style="margin-top:0">Tyne Update Preview</label>
            <textarea id="automationFeedbackPreviewText" rows="10" aria-label="Edit PM comment before posting"></textarea>
            <div class="btn-row">
              <button class="btn primary" id="automationPostPreviewedBtn" type="button">Post to Jira/Linear</button>
              <button class="btn" id="automationClosePreviewBtn" type="button">Cancel</button>
            </div>
          </div>

          <div class="label">Recent Events</div>
          <div id="automationEventList"><div class="empty">No automation events yet.</div></div>

          <div class="label">Commit Detection</div>
          <div class="card" id="commitDetectionCard">
            <div class="field-row">
              <span class="field-label">Status</span>
              <span id="commitDetectionStatus">Detecting...</span>
            </div>
            <div class="btn-row" style="margin-top:8px">
              <button class="btn" id="reinstallCommitHookBtn" type="button">Reinstall Git Hook</button>
            </div>
          </div>

          <div class="label">Automation Settings</div>
          <div class="card" id="automationSettingsCard">
            <div class="settings-subhead">Workflow</div>
            <div class="field">
              <label for="autoCloseTrigger">Auto-close trigger</label>
              <select id="autoCloseTrigger">
                <option value="manual">When I tie the knot</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
            <div class="field toggle-row max-only hidden" id="autoCloseOnCommitRow">
              <label for="autoCloseOnCommit">Auto-close on commit (MAX)</label>
              <input type="checkbox" id="autoCloseOnCommit" />
            </div>
            <div class="field">
              <label for="autoFeedbackTrigger">Auto-feedback trigger</label>
              <select id="autoFeedbackTrigger">
                <option value="after_commit">After commit</option>
                <option value="after_validation_pass">After validation pass</option>
                <option value="manual">Manual</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
            <div class="field toggle-row">
              <label for="requireValidationBeforeAutoClose">Require validation before close</label>
              <input type="checkbox" id="requireValidationBeforeAutoClose" />
            </div>
            <div class="field toggle-row">
              <label for="requireValidationBeforeFeedback">Require validation before feedback</label>
              <input type="checkbox" id="requireValidationBeforeFeedback" />
            </div>
            <div class="field toggle-row">
              <label for="autoPostFeedbackAfterClose">Auto-post feedback after close</label>
              <input type="checkbox" id="autoPostFeedbackAfterClose" />
            </div>

            <div class="settings-subhead">PM Sync</div>
            <div class="field toggle-row">
              <label for="syncPmStatusToTyne">Sync PM status to Tyne</label>
              <input type="checkbox" id="syncPmStatusToTyne" />
            </div>
            <div class="field toggle-row">
              <label for="syncTyneStatusToPm">Sync Tyne status to PM</label>
              <input type="checkbox" id="syncTyneStatusToPm" />
            </div>
            <div class="field toggle-row">
              <label for="autoMovePmToInProgressOnStart">Move PM to In Progress on start</label>
              <input type="checkbox" id="autoMovePmToInProgressOnStart" />
            </div>

            <div class="settings-subhead">Privacy &amp; Data</div>
            <div class="field" id="privacyModeField">
              <label>Privacy Mode</label>
              <div class="privacy-mode-options">
                <label><input type="radio" name="privacyMode" value="cloud" /> Cloud Review</label>
                <label><input type="radio" name="privacyMode" value="privacy_enhanced" /> Privacy Enhanced</label>
                <label><input type="radio" name="privacyMode" value="local_compliance" /> Local Compliance Mode</label>
              </div>
              <p class="hint">Controls what leaves your machine during Validate &amp; Review.</p>
            </div>
            <div class="field" id="dataResidencyField">
              <label for="dataResidency">Data Processing Location</label>
              <select id="dataResidency">
                <option value="us">US</option>
                <option value="eu">EU</option>
                <option value="local_only">Local Only</option>
                <option value="enterprise_managed">Enterprise Managed</option>
              </select>
              <p class="hint">Local Only keeps analysis on-device. Enterprise Managed routes to your self-hosted endpoint (Settings: tyne.enterpriseValidateReviewUrl).</p>
            </div>
            <div class="field hidden" id="enterpriseEndpointHint">
              <p class="hint">Set <code>tyne.enterpriseValidateReviewUrl</code> in VS Code settings to your self-hosted Tyne Validate &amp; Review URL.</p>
            </div>

            <div class="settings-subhead max-only hidden">Compliance (MAX)</div>
            <div class="field toggle-row max-only hidden" id="complianceChecksEnabledRow">
              <label for="complianceChecksEnabled">Compliance policy checks</label>
              <input type="checkbox" id="complianceChecksEnabled" />
            </div>
            <fieldset class="field max-only hidden compliance-frameworks" id="complianceFrameworksField">
              <legend>Enabled frameworks</legend>
              <div class="compliance-framework-grid">
                <label><input type="checkbox" data-compliance-framework="HIPAA" /> HIPAA</label>
                <label><input type="checkbox" data-compliance-framework="SOC2" /> SOC 2</label>
                <label><input type="checkbox" data-compliance-framework="PCI_DSS" /> PCI DSS</label>
                <label><input type="checkbox" data-compliance-framework="GDPR" /> GDPR</label>
                <label><input type="checkbox" data-compliance-framework="ISO27001" /> ISO 27001</label>
                <label><input type="checkbox" data-compliance-framework="NIST_CSF" /> NIST CSF</label>
                <label><input type="checkbox" data-compliance-framework="NIST_800_53" /> NIST 800-53</label>
                <label><input type="checkbox" data-compliance-framework="FEDRAMP" /> FedRAMP</label>
                <label><input type="checkbox" data-compliance-framework="CCPA_CPRA" /> CCPA / CPRA</label>
                <label><input type="checkbox" data-compliance-framework="SOX" /> SOX</label>
                <label><input type="checkbox" data-compliance-framework="CUSTOM" /> Custom policies</label>
              </div>
              <div class="vr-custom-policy-form max-only" id="customCompliancePolicyForm">
                <div class="label">Custom enterprise rule</div>
                <input id="customPolicyName" type="text" placeholder='Rule: "Customer emails cannot be logged"' />
                <input id="customPolicyCategory" type="text" placeholder="Category: PII Exposure" />
                <input id="customPolicyPattern" type="text" placeholder="Pattern: email|logger" />
                <select id="customPolicySeverity">
                  <option value="critical">Severity: Critical</option>
                  <option value="high">Severity: High</option>
                  <option value="medium">Severity: Medium</option>
                  <option value="low">Severity: Low</option>
                </select>
                <select id="customPolicyAction">
                  <option value="block">Action: Block</option>
                  <option value="review">Action: Review</option>
                  <option value="inform">Action: Inform</option>
                </select>
                <select id="customPolicySink">
                  <option value="log">Sink: Logs</option>
                  <option value="response">Sink: API response</option>
                  <option value="storage">Sink: Storage</option>
                </select>
                <button type="button" class="btn" id="customPolicyCreateBtn">Add policy</button>
                <ul class="vr-custom-policy-list" id="customPolicyList"></ul>
              </div>
            </fieldset>

            <div class="btn-row" style="margin-top:12px; align-items:center; gap:8px">
              <button class="btn primary" id="automationSaveSettingsBtn" type="button">Save Settings</button>
              <span class="unsaved-badge hidden" id="automationUnsaved">Unsaved changes</span>
            </div>
          </div>

          <div class="label max-only hidden" id="maxReportSettingsLabel">MAX Report Settings</div>
          <div class="card max-only hidden" id="maxReportSettingsCard">
            <p class="field-help" style="margin-top:0">Choose which sections appear in the MAX validation report posted to your PM tool.</p>
            <div class="field toggle-row">
              <label for="maxReportValidationStages">Validation stages</label>
              <input type="checkbox" id="maxReportValidationStages" data-section="validation_stages" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportRiskAssessment">Risk assessment</label>
              <input type="checkbox" id="maxReportRiskAssessment" data-section="risk_assessment" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportSecurityCheck">Security check</label>
              <input type="checkbox" id="maxReportSecurityCheck" data-section="security_check" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportCodeQuality">Code quality</label>
              <input type="checkbox" id="maxReportCodeQuality" data-section="code_quality" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportPerformanceMetrics">Performance metrics</label>
              <input type="checkbox" id="maxReportPerformanceMetrics" data-section="performance_metrics" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportRecommendations">Recommendations</label>
              <input type="checkbox" id="maxReportRecommendations" data-section="recommendations" />
            </div>
            <div class="btn-row" style="margin-top:10px">
              <button class="btn primary" id="maxReportSaveSettingsBtn" type="button">Save Report Settings</button>
            </div>
          </div>
        </section>

        <!-- ===== SETTINGS (incl. Account + Integrations) ===== -->
        <section class="page" id="settingsPage">
          <div class="page-head"><span class="page-title">Settings</span></div>

          <div class="label">Account</div>
          <div class="account-card">
            <div class="name-row">
              <span class="tag-outline soon" id="accountConnTag">NOT CONNECTED</span>
              <span class="beta-pill">BETA</span>
            </div>
            <div class="name hidden" id="accountName">Not connected</div>
            <div class="tier-row">
              <span class="tier-cap">Plan</span>
              <img class="tier-logo t-core" src="${tier.core}" alt="Free" />
              <img class="tier-logo t-pro" src="${tier.pro}" alt="Pro" />
              <img class="tier-logo t-max" src="${tier.max}" alt="Max" />
              <span class="plan" id="accountPlan">Connect GitHub to load your plan</span>
            </div>
            <div class="plan-note hidden" id="planMaxNote">You're on the Max plan</div>
            <div class="credits hidden" id="accountCredits">Daily usage · <span id="accountCreditsVal">0</span>%</div>
            <div class="btn-stack account-actions">
              <button class="btn primary hidden" id="upgradePlanBtn" type="button">Upgrade</button>
              <button class="btn hidden" id="manageBillingBtn" type="button">Manage billing</button>
              <button class="btn" id="signoutBtn">Log out</button>
            </div>
          </div>

          <div class="label">Integrations</div>
          <div class="int-list" id="integrationsList">
            <div class="int-item" data-tool="github">
              <svg class="int-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.8c.85.01 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2z"/></svg>
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">GitHub</span>
                </div>
                <div class="int-desc" id="githubDesc">Account connection · draft PRs, branch push, review links</div>
              </div>
              <div class="int-actions">
                <button class="btn compact primary" id="githubStateBtn" data-action="connect" data-provider="github">Connect</button>
                <button class="btn ghost compact hidden" id="githubDisconnectBtn" data-action="disconnect" data-tool="github">Disconnect</button>
              </div>
            </div>
            <div class="int-item" data-tool="jira">
              <img class="int-logo" src="${logos.jira}" alt="Jira" />
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">Jira</span>
                </div>
                <div class="int-desc" id="jiraDesc">Connect Jira to link this repository with your sprint work.</div>
              </div>
              <div class="int-actions">
                <button class="btn compact primary" id="jiraStateBtn" data-action="connect" data-provider="jira" data-github-required-id="jiraConnectGithubBtn" data-reconnect-id="jiraReconnectBtn">Connect</button>
                <button class="btn ghost compact hidden" id="jiraChangeProjectBtn" data-action="change-project" data-provider="jira">Change Project</button>
                <button class="btn ghost compact hidden" id="jiraDisconnectBtn" data-action="disconnect" data-tool="jira">Disconnect</button>
              </div>
            </div>
            <div class="int-item" data-tool="linear">
              <img class="int-logo" src="${logos.linear}" alt="Linear" />
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">Linear</span>
                </div>
                <div class="int-desc" id="linearDesc">Connect Linear to link issues with your sprint work.</div>
              </div>
              <div class="int-actions">
                <button class="btn compact primary" id="linearStateBtn" data-action="connect" data-provider="linear">Connect</button>
                <button class="btn ghost compact hidden" id="linearDisconnectBtn" data-action="disconnect" data-tool="linear">Disconnect</button>
              </div>
            </div>
          </div>

          <div class="label">AI &amp; API</div>

          <div id="planConnectContainer" class="hidden">
            <div class="notice info">
              <div class="notice-title">Connect account</div>
              <div class="notice-copy">Tyne could not load your subscription yet. Connect GitHub to hydrate your tier.</div>
              <div class="btn-row"><button class="btn primary" id="connectGithubSettingsBtn" type="button">Connect GitHub</button></div>
            </div>
          </div>

          <div id="coreConfigContainer" class="hidden">
            <div class="notice info">
              <div class="notice-copy">Core includes 5 hosted Validate &amp; Review runs / month. BYOK requires Pro or Max. <a href="#" id="upgradeFromSettingsLink">Upgrade</a></div>
            </div>
          </div>

          <div id="premiumConfigContainer" class="hidden">
            <div class="notice good"><div class="notice-copy">Connected to Tyne hosted models.</div></div>
            <div class="row-setting">
              <div><div class="st">Override with custom key</div><div class="ss">Use your own API key (BYOK)</div></div>
              <button class="toggle" id="overrideByokToggle" type="button" aria-pressed="false"></button>
            </div>
            <div id="byokOverrideFields" class="hidden">
              <div class="field">
                <label>Provider</label>
                <div class="seg" id="premiumProviderSeg">
                  <button class="active" type="button" data-provider="claude">Claude</button>
                  <button type="button" data-provider="openai">OpenAI</button>
                </div>
              </div>
              <div class="field"><label for="byokApiKeyPremium">API key</label><input type="password" id="byokApiKeyPremium" placeholder="sk-ant-… or sk-…" autocomplete="off" /></div>
              <div class="btn-row">
                <button class="btn primary" id="saveByokBtnPremium" type="button">Save key</button>
                <button class="btn ghost compact" id="testByokBtnPremium" type="button">Test</button>
                <button class="btn ghost compact" id="deleteByokBtnPremium" type="button">Delete</button>
              </div>
              <div class="row-setting"><div class="ss" id="byokStatusPremium">No key saved.</div></div>
            </div>
          </div>

          <div class="label">Features</div>
          <div class="row-setting">
            <div><div class="st">Project Lead Mode</div><div class="ss">Prep repo, drift detection, synth commit.</div></div>
            <button class="toggle" data-toggle="projectLead" type="button" aria-pressed="false"></button>
          </div>

          <div class="label">Feedback</div>
          <button class="btn ghost beta-bug-fab" id="betaBugFab" type="button">Report a beta issue</button>

          <div class="label">About</div>
          <div class="about-ver">Tyne v${extensionVersion.replace(/[<>&"]/g, '')}</div>
          <div class="about-sub">Local project lead for VS Code.</div>
          <div class="about-legal">
            <a href="#" id="aboutTermsLink" data-url="https://tyne.proflowtech.io/terms">Terms</a>
            <span class="about-legal-sep">·</span>
            <a href="#" id="aboutPrivacyLink" data-url="https://tyne.proflowtech.io/privacy">Privacy</a>
          </div>
        </section>

      </div>
      <footer class="brand-footer" aria-label="Tyne, powered by Axiom">
        <img class="brand-footer-logo" src="${tier.mark}" alt="" aria-hidden="true" />
        <span class="brand-footer-name">Tyne</span>
        <span class="brand-footer-sep">·</span>
        <span class="brand-footer-axiom">Powered by Axiom</span>
      </footer>
    </div>
  </main>
</div>

<!-- Beta bug reporter sheet (opened from Settings) -->
<div class="beta-bug-sheet hidden" id="betaBugSheet" role="dialog" aria-modal="true" aria-labelledby="betaBugTitle">
  <div class="beta-bug-sheet-scrim" id="betaBugScrim"></div>
  <div class="beta-bug-sheet-panel">
    <div class="beta-bug-sheet-head">
      <div>
        <div class="beta-bug-sheet-title" id="betaBugTitle">Report a beta issue</div>
        <div class="beta-bug-sheet-sub">Takes ~10 seconds. Context is attached automatically.</div>
      </div>
      <button type="button" class="icon-btn" id="betaBugCloseBtn" aria-label="Close">${ICON.x}</button>
    </div>
    <div class="beta-bug-kinds" role="radiogroup" aria-label="Issue type">
      <button type="button" class="beta-bug-kind active" data-kind="bug" aria-pressed="true">Broken</button>
      <button type="button" class="beta-bug-kind" data-kind="confusing" aria-pressed="false">Confusing</button>
      <button type="button" class="beta-bug-kind" data-kind="idea" aria-pressed="false">Idea</button>
    </div>
    <label class="beta-bug-label" for="betaBugMessage">What happened?</label>
    <textarea id="betaBugMessage" rows="4" maxlength="4000" placeholder="e.g. Validate stuck on partial after I fixed majors…"></textarea>
    <label class="beta-bug-label" for="betaBugEmail">Reply email <span class="req">*</span></label>
    <input type="email" id="betaBugEmail" maxlength="320" placeholder="you@company.com" autocomplete="email" />
    <div class="beta-bug-context" id="betaBugContext"></div>
    <div class="beta-bug-error hidden" id="betaBugError" role="alert"></div>
    <div class="beta-bug-actions">
      <button type="button" class="btn ghost compact" id="betaBugCancelBtn">Cancel</button>
      <button type="button" class="btn primary compact" id="betaBugSubmitBtn">Send</button>
    </div>
  </div>
</div>

<!-- ── Validation full report overlay (Max tier) ── -->
<div class="vr-finding-dialog hidden" id="vrFindingDialog" role="dialog" aria-modal="true" aria-label="Finding detail">
  <div class="vr-finding-dialog-scrim vr-fa-btn" data-action="close_finding_dialog"></div>
  <div class="vr-finding-dialog-panel" id="vrFindingDialogPanel"></div>
</div>
<div class="val-detail-overlay hidden" id="valDetailOverlay" role="dialog" aria-modal="true" aria-label="Validation report">
  <div class="val-detail-scrim" id="valDetailScrim"></div>
  <div class="val-detail-modal">
    <div class="val-detail-bar">
      <span class="val-detail-bar-title">Validation report</span>
      <div class="val-detail-bar-actions">
        <button class="btn ghost compact" id="valDetailCopyBtn" type="button">Copy</button>
        <button class="btn ghost compact" id="valDetailCloseBtn" type="button" aria-label="Close report">✕</button>
      </div>
    </div>
    <div class="val-detail-report" id="valDetailReport"></div>
    <div class="val-detail-foot">
      <button class="btn hidden" id="valDetailOpenCommitBtn" type="button">Open commit</button>
      <span class="val-detail-foot-spacer"></span>
      <button class="btn" id="valDetailCloseBtn2" type="button">Close</button>
      <button class="btn primary" id="valDetailRunAgainBtn" type="button">Run again</button>
    </div>
  </div>
</div>

<script nonce="${nonce}" src="${taskInteractionsUri}"></script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/** Render a decomposed task as a plain-text Jira sub-task description. */
export function buildPmSubtaskDescription(task: DecomposedTask): string {
  const lines: string[] = [];
  if (task.description) { lines.push(task.description, ''); }
  if (task.acceptanceCriteria.length) {
    lines.push('Acceptance criteria:', ...task.acceptanceCriteria.map(ac => `- ${ac}`), '');
  }
  if (task.proofPoints.length) {
    lines.push('Proof points:', ...task.proofPoints.map(p => `- ${p}`), '');
  }
  if (task.affectedFiles.length) {
    lines.push('Likely files:', ...task.affectedFiles.map(f => `- ${f}`), '');
  }
  if (task.dependencies.length) {
    lines.push(`Depends on: ${task.dependencies.join(', ')}`, '');
  }
  if (task.developerContext) { lines.push(`Developer context: ${task.developerContext}`, ''); }
  lines.push(`Estimated effort: ${task.estimatedHours}h`, '', 'Generated by Tyne story decomposition.');
  return lines.join('\n');
}

export function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
